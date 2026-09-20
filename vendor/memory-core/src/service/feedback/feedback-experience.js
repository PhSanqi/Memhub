import { DECISION_REPAIR_PROMPT, classifyFeedbackText, traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import {} from "../../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import { Repositories, jobToRef, kindFromMemory } from "../../storage/repositories.js";
import { MemoryServiceError } from "../../utils/error.js";
import { newId, stableHash, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import { nowIso } from "../../utils/time.js";
import { namespaceForMemory, namespaceForSession, normalizeNamespace, profileIdFromMemory, projectIdFromMemory } from "../namespace/namespace-scope.js";
import { skillBetaPosterior } from "../read-model/skill.js";
import { isRepairFailureLikeTrace as sessionIsRepairFailureLikeTrace, repairTraceContains as sessionRepairTraceContains } from "../session/session-turn-service.js";
import {} from "../worker/job-handlers.js";
const pipelineLogger = createMemoryLogger("pipeline");
export class FeedbackExperienceService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async feedback(request) {
        if (!this.deps.memoryAddEnabled()) {
            return this.feedbackNoWrite(request);
        }
        const idempotencyKey = request.adapterId && request.requestId
            ? `feedback.add:${request.adapterId}:${request.requestId}`
            : undefined;
        const requestHash = stableHash({ request });
        if (idempotencyKey) {
            const existing = this.deps.repos.runtime.getIdempotency(idempotencyKey);
            if (existing) {
                if (existing.requestHash !== requestHash) {
                    throw new MemoryServiceError("conflict", "idempotency key reused with different feedback request body");
                }
                const body = existing.response;
                return {
                    ...body,
                    duplicate: true
                };
            }
        }
        const context = this.resolveFeedbackContext(request);
        const attribution = this.resolveFeedbackAttribution(request, context);
        const attributedRequest = {
            ...request,
            l1MemoryId: request.l1MemoryId ?? attribution.l1MemoryId,
            rawTurnId: request.rawTurnId ?? attribution.rawTurnId,
            episodeId: request.episodeId ?? attribution.episodeId,
            sessionId: request.sessionId ?? attribution.sessionId
        };
        const recallOutcome = recallOutcomeFromFeedback(request);
        let recallEvent;
        if (request.recallEventId) {
            recallEvent = this.deps.repos.runtime.getRecallEvent(request.recallEventId);
            if (!recallEvent) {
                throw new MemoryServiceError("not_found", `recall event not found: ${request.recallEventId}`);
            }
        }
        const feedbackId = newId("feedback");
        const feedbackContextHash = this.feedbackContextHash(attributedRequest, context);
        const feedback = this.deps.repos.runtime.insertFeedback({
            id: feedbackId,
            userId: context.userId,
            projectId: context.namespace.projectId ?? context.namespace.workspaceId,
            conversationId: context.conversationId,
            sessionId: attributedRequest.sessionId,
            episodeId: attributedRequest.episodeId,
            l1MemoryId: attributedRequest.l1MemoryId,
            rawTurnId: attributedRequest.rawTurnId,
            channel: request.channel,
            polarity: request.polarity,
            magnitude: request.magnitude ?? 1,
            rationale: request.rationale,
            rawPayload: request.rawPayload ?? {},
            contextHash: feedbackContextHash,
            createdAt: nowIso()
        });
        if (feedback.episodeId) {
            this.deps.repos.runtime.appendEpisodeFeedback(feedback.episodeId, feedback.id, feedback.createdAt);
        }
        const repairDraft = await this.maybeSynthesizeFeedbackDecisionRepair(attributedRequest, feedback, feedbackContextHash);
        const repair = this.maybeCreateDecisionRepair(attributedRequest, feedback, feedbackContextHash, namespaceIdFromContext(context.namespace), repairDraft);
        const updatedRecallEvent = recallEvent && recallOutcome
            ? this.deps.repos.runtime.updateRecallEventOutcome(recallEvent.id, recallOutcome)
            : undefined;
        if (updatedRecallEvent) {
            this.applyRecallOutcome(updatedRecallEvent, feedback, feedback.createdAt);
        }
        const jobs = [];
        const rewardEpisode = attributedRequest.episodeId
            ? this.deps.repos.runtime.getEpisode(attributedRequest.episodeId)
            : undefined;
        if ((attributedRequest.l1MemoryId || attributedRequest.episodeId) && rewardEpisode?.status !== "open") {
            jobs.push(this.deps.enqueueJob({
                jobType: "reward",
                userId: context.userId,
                sessionId: attributedRequest.sessionId,
                episodeId: attributedRequest.episodeId,
                payload: {
                    feedbackId: feedback.id,
                    ...(attributedRequest.l1MemoryId ? { l1MemoryId: attributedRequest.l1MemoryId } : {}),
                    channel: feedback.channel,
                    polarity: feedback.polarity,
                    magnitude: feedback.magnitude,
                    rationale: feedback.rationale,
                    ...(repair?.repairId ? { repairId: repair.repairId } : {}),
                    ...(rewardEpisode?.status === "closed" ? { phase: "final" } : {}),
                    trigger: feedback.channel === "implicit" ? "implicit_feedback" : "explicit_feedback"
                }
            }));
        }
        for (const trial of this.deps.pendingTrialsForFeedback(feedback)) {
            jobs.push(this.deps.enqueueJob({
                jobType: "skill_trial_resolve",
                userId: context.userId,
                sessionId: trial.sessionId,
                episodeId: trial.episodeId,
                payload: {
                    trialId: trial.id,
                    feedbackId: feedback.id,
                    targetKind: "skill_trial",
                    rawTurnId: trial.rawTurnId,
                    turnId: trial.turnId
                }
            }));
        }
        const changeSeq = this.deps.repos.runtime.appendChange({
            memoryId: attributedRequest.l1MemoryId ?? attributedRequest.rawTurnId ?? feedback.id,
            namespaceId: namespaceIdFromContext(context.namespace),
            kind: "feedback",
            op: "created",
            entityId: feedback.id,
            userId: context.userId,
            changeType: "feedback",
            after: feedback,
            source: "feedback.add",
            createdAt: feedback.createdAt
        });
        const body = {
            id: feedbackId,
            ts: feedback.createdAt,
            channel: feedback.channel,
            polarity: feedback.polarity,
            magnitude: feedback.magnitude,
            scheduledEvolution: jobs.length > 0,
            changeSeq,
            syncCursor: this.deps.encodeChangeCursor(changeSeq, context.namespace),
            feedbackId,
            recallEventId: updatedRecallEvent?.id,
            recallOutcome: updatedRecallEvent?.outcome,
            repair,
            jobs: jobs.map(jobToRef),
            serverTime: nowIso()
        };
        if (idempotencyKey) {
            this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body);
        }
        return body;
    }
    feedbackContextHash(request, context) {
        const rawContextHash = isRecord(request.rawPayload) && typeof request.rawPayload.contextHash === "string"
            ? request.rawPayload.contextHash
            : undefined;
        if (rawContextHash)
            return rawContextHash;
        return stableHash({
            sessionId: request.sessionId,
            episodeId: request.episodeId,
            rawTurnId: request.rawTurnId,
            l1MemoryId: request.l1MemoryId,
            recallEventId: request.recallEventId,
            rationale: request.rationale
        }).slice(0, 32);
    }
    async maybeSynthesizeFeedbackDecisionRepair(request, feedback, contextHash) {
        const classification = classifyFeedbackText(request.rationale ?? feedback.rationale ?? "");
        const shouldRepair = request.polarity === "negative" ||
            classification.shape === "negative" ||
            classification.shape === "preference" ||
            classification.shape === "correction" ||
            classification.shape === "constraint";
        if (!shouldRepair)
            return undefined;
        const cooldownMs = this.deps.config.algorithm.feedback.cooldownMs;
        if (cooldownMs > 0) {
            const since = new Date(Date.parse(feedback.createdAt) - cooldownMs).toISOString();
            const recent = this.deps.repos.runtime.listDecisionRepairs({
                userId: feedback.userId,
                contextHash,
                since,
                limit: 1
            });
            if (recent.length > 0)
                return undefined;
        }
        const evidence = this.feedbackRepairEvidence(request, feedback);
        const highValue = this.decisionRepairTraceSources(this.deps.repos.memories.getMany(evidence.highValueMemoryIds));
        const lowValue = this.decisionRepairTraceSources(this.deps.repos.memories.getMany(evidence.lowValueMemoryIds));
        return synthesizeDecisionRepairDraft({
            trigger: "user.feedback",
            contextHash,
            feedbackText: request.rationale ?? feedback.rationale ?? "",
            classification,
            highValue,
            lowValue,
            traceCharCap: this.deps.config.algorithm.feedback.traceCharCap,
            diagnostics: {
                pipeline: "decision_repair.feedback",
                feedbackId: feedback.id
            }
        }, {
            useLlm: this.deps.config.algorithm.feedback.useLlm,
            llm: this.deps.skillLlm
        });
    }
    maybeCreateDecisionRepair(request, feedback, contextHash, namespaceId, llmDraft) {
        const classification = classifyFeedbackText(request.rationale ?? "");
        const shouldRepair = request.polarity === "negative" ||
            classification.shape === "negative" ||
            classification.shape === "preference" ||
            classification.shape === "correction" ||
            classification.shape === "constraint";
        if (!shouldRepair)
            return undefined;
        const cooldownMs = this.deps.config.algorithm.feedback.cooldownMs;
        if (cooldownMs > 0) {
            const since = new Date(Date.parse(feedback.createdAt) - cooldownMs).toISOString();
            const recent = this.deps.repos.runtime.listDecisionRepairs({
                userId: feedback.userId,
                contextHash,
                since,
                limit: 1
            });
            if (recent.length > 0) {
                return {
                    contextHash,
                    skipped: true,
                    reason: "cooldown"
                };
            }
        }
        const evidence = this.feedbackRepairEvidence(request, feedback);
        const repair = this.deps.repos.runtime.insertDecisionRepair({
            id: newId("repair"),
            sessionId: feedback.sessionId,
            episodeId: feedback.episodeId,
            rawTurnId: feedback.rawTurnId,
            userId: feedback.userId,
            projectId: feedback.projectId,
            contextHash,
            issue: repairIssueFromFeedback(request, classification),
            suggestion: llmDraft?.preference ?? repairSuggestionFromFeedback(request, classification),
            preference: llmDraft?.preference ?? repairPreferenceFromFeedback(request, classification),
            antiPattern: llmDraft?.antiPattern ?? repairAntiPatternFromFeedback(request, classification),
            highValueMemoryIds: evidence.highValueMemoryIds,
            lowValueMemoryIds: evidence.lowValueMemoryIds,
            feedbackId: feedback.id,
            validated: false,
            source: {
                source: "feedback.decision_repair.v7",
                classification,
                ...(llmDraft ? { synthesis: "llm" } : {})
            },
            meta: {
                trigger: "user_feedback",
                polarity: feedback.polarity,
                severity: llmDraft?.severity,
                confidence: llmDraft?.confidence ?? classification.confidence
            },
            createdAt: feedback.createdAt
        });
        if (feedback.episodeId) {
            this.deps.repos.runtime.appendEpisodeDecisionRepair(feedback.episodeId, repair.id, feedback.createdAt);
        }
        this.deps.repos.runtime.appendChange({
            memoryId: repair.id,
            namespaceId,
            userId: feedback.userId,
            kind: "repair",
            op: "created",
            entityId: repair.id,
            changeType: "decision_repair_created",
            after: repair,
            source: "feedback.decision_repair.v7",
            createdAt: feedback.createdAt
        });
        return {
            repairId: repair.id,
            contextHash,
            skipped: false
        };
    }
    feedbackRepairEvidence(request, feedback) {
        const limit = this.deps.config.algorithm.feedback.evidenceLimit;
        const low = new Set();
        const high = new Set();
        if (feedback.l1MemoryId) {
            if (feedback.polarity === "negative") {
                low.add(feedback.l1MemoryId);
            }
            else if (feedback.polarity === "positive") {
                high.add(feedback.l1MemoryId);
            }
        }
        if (request.recallEventId) {
            const recall = this.deps.repos.runtime.getRecallEvent(request.recallEventId);
            for (const id of recall?.injectedMemoryIds ?? []) {
                if (feedback.polarity === "negative") {
                    low.add(id);
                }
                else if (feedback.polarity === "positive") {
                    high.add(id);
                }
            }
        }
        const searchText = request.rationale ?? feedback.rationale;
        if (request.sessionId && (high.size < limit || low.size < limit)) {
            const evidence = this.sessionRepairEvidence(request.sessionId, searchText, limit);
            for (const memory of evidence.highValue) {
                if (!low.has(memory.id) && high.size < limit)
                    high.add(memory.id);
            }
            for (const memory of evidence.lowValue) {
                if (!high.has(memory.id) && low.size < limit)
                    low.add(memory.id);
            }
        }
        if (searchText && high.size < limit) {
            for (const memory of this.deps.repos.memories.search(searchText, {
                memoryLayer: "L1",
                status: "activated"
            }, limit * 2)) {
                const fullMemory = this.deps.repos.memories.get(memory.id);
                const trace = fullMemory ? this.deps.traceMeta(fullMemory) : null;
                if (trace && trace.value > 0 && !low.has(memory.id))
                    high.add(memory.id);
                if (high.size >= limit)
                    break;
            }
        }
        if (searchText && low.size < limit) {
            for (const memory of this.deps.repos.memories.search(searchText, {
                memoryLayer: "L1",
                status: "activated"
            }, limit * 2)) {
                const fullMemory = this.deps.repos.memories.get(memory.id);
                const trace = fullMemory ? this.deps.traceMeta(fullMemory) : null;
                if (trace &&
                    !high.has(memory.id) &&
                    (trace.value < -this.deps.config.algorithm.feedback.minLowValueThreshold ||
                        sessionIsRepairFailureLikeTrace(trace))) {
                    low.add(memory.id);
                }
                if (low.size >= limit)
                    break;
            }
        }
        return {
            highValueMemoryIds: [...high].slice(0, limit),
            lowValueMemoryIds: [...low].slice(0, limit)
        };
    }
    sessionRepairEvidence(sessionId, keyword, limit) {
        const recent = this.deps.repos.memories
            .list({
            sessionId,
            memoryLayer: "L1",
            status: "activated"
        }, Math.max(limit * 6, 24))
            .map((memory) => ({ memory, trace: this.deps.traceMeta(memory) }))
            .filter((item) => Boolean(item.trace));
        if (recent.length === 0) {
            return { highValue: [], lowValue: [] };
        }
        const needle = keyword?.toLowerCase().trim() ?? "";
        const firstPass = this.partitionSessionRepairEvidence(recent, needle, limit);
        const emptyFirstPass = firstPass.highValue.length === 0 && firstPass.lowValue.length === 0;
        if (!needle || !emptyFirstPass) {
            return firstPass;
        }
        return this.partitionSessionRepairEvidence(recent, "", limit);
    }
    partitionSessionRepairEvidence(rows, needle, limit) {
        const highValue = [];
        const lowValue = [];
        for (const row of rows) {
            if (needle && !sessionRepairTraceContains(row.trace, needle))
                continue;
            if (row.trace.value > 0) {
                if (highValue.length < limit)
                    highValue.push(row.memory);
            }
            else if (row.trace.value < -this.deps.config.algorithm.feedback.minLowValueThreshold ||
                sessionIsRepairFailureLikeTrace(row.trace)) {
                if (lowValue.length < limit)
                    lowValue.push(row.memory);
            }
            if (highValue.length >= limit && lowValue.length >= limit)
                break;
        }
        return { highValue, lowValue };
    }
    decisionRepairTraceSources(memories) {
        return memories.map((memory) => {
            const rawTurnId = rawTurnIdFromMemory(memory);
            return {
                memory,
                rawTurn: rawTurnId ? this.deps.repos.runtime.getRawTurn(rawTurnId) : undefined
            };
        });
    }
    applyRecallOutcome(event, feedback, at) {
        const outcome = event.outcome;
        if (!outcome || outcome === "pending")
            return;
        const memoryIds = uniq(event.injectedMemoryIds ?? event.hitMemoryIds);
        for (const memory of this.deps.repos.memories.getMany(memoryIds)) {
            const previous = memory;
            let next = updateRecallStats(memory, {
                outcome,
                feedbackId: feedback.id,
                recallEventId: event.id,
                updatedAt: at
            });
            const saved = this.deps.repos.memories.update(next);
            this.deps.repos.runtime.appendChange({
                memoryId: saved.id,
                namespaceId: namespaceIdFromMemory(saved),
                kind: kindFromMemory(saved),
                op: "updated",
                entityId: saved.id,
                userId: saved.userId,
                changeType: "recall_outcome_update",
                before: previous,
                after: saved,
                source: "worker.recall_outcome.v7",
                createdAt: at
            });
        }
        this.deps.repos.runtime.appendChange({
            memoryId: event.id,
            namespaceId: event.namespaceId,
            userId: event.userId,
            kind: "recall",
            op: "updated",
            entityId: event.id,
            changeType: "recall_outcome",
            after: event,
            source: "feedback.recall_outcome",
            createdAt: at
        });
    }
    feedbackNoWrite(request) {
        const cursor = this.deps.readOnlyCursor(request.namespace);
        const feedbackId = `feedback_${stableHash({
            sessionId: request.sessionId,
            target: request.target,
            polarity: request.polarity,
            rationale: request.rationale
        }).slice(0, 20)}`;
        return {
            id: feedbackId,
            ts: nowIso(),
            channel: request.channel,
            polarity: request.polarity,
            magnitude: request.magnitude ?? 1,
            scheduledEvolution: false,
            changeSeq: cursor.changeSeq,
            syncCursor: cursor.syncCursor,
            feedbackId,
            jobs: [],
            serverTime: nowIso()
        };
    }
    resolveFeedbackContext(request) {
        if (request.sessionId) {
            const session = this.deps.repos.runtime.getSession(request.sessionId);
            if (session) {
                this.deps.assertSessionInScope(session, request.namespace);
                return {
                    userId: session.userId,
                    conversationId: session.conversationId,
                    namespace: namespaceForSession(session)
                };
            }
        }
        if (request.episodeId) {
            const episode = this.deps.repos.runtime.getEpisode(request.episodeId);
            if (episode) {
                this.deps.assertEpisodeInScope(episode, request.namespace);
                const session = this.deps.repos.runtime.getSession(episode.sessionId);
                if (session) {
                    return {
                        userId: session.userId,
                        conversationId: session.conversationId,
                        namespace: namespaceForSession(session)
                    };
                }
                return {
                    userId: episode.userId,
                    conversationId: episode.conversationId,
                    namespace: {
                        ...normalizeNamespace(request.namespace),
                        userId: episode.userId
                    }
                };
            }
        }
        if (request.rawTurnId) {
            const rawTurn = this.deps.repos.runtime.getRawTurn(request.rawTurnId);
            if (rawTurn) {
                this.deps.assertRawTurnInScope(rawTurn, request.namespace);
                const session = this.deps.repos.runtime.getSession(rawTurn.sessionId);
                if (session) {
                    return {
                        userId: session.userId,
                        conversationId: session.conversationId,
                        namespace: namespaceForSession(session)
                    };
                }
                return {
                    userId: rawTurn.userId,
                    conversationId: rawTurn.conversationId,
                    namespace: {
                        ...normalizeNamespace(request.namespace),
                        userId: rawTurn.userId
                    }
                };
            }
        }
        if (request.l1MemoryId) {
            const memory = this.deps.repos.memories.get(request.l1MemoryId);
            if (memory) {
                this.deps.assertMemoryInScope(memory, request.namespace);
                const session = memory.sessionId ? this.deps.repos.runtime.getSession(memory.sessionId) : undefined;
                if (session) {
                    return {
                        userId: session.userId,
                        conversationId: session.conversationId,
                        namespace: namespaceForSession(session)
                    };
                }
                return {
                    userId: memory.userId,
                    conversationId: memory.conversationId,
                    namespace: namespaceForMemory(memory)
                };
            }
        }
        return this.deps.resolveContext(request);
    }
    resolveFeedbackAttribution(request, context) {
        let episode = request.episodeId ? this.deps.requireEpisode(request.episodeId) : undefined;
        if (episode) {
            this.deps.assertEpisodeInScope(episode, request.namespace);
            if (request.sessionId && episode.sessionId !== request.sessionId) {
                throw new MemoryServiceError("conflict", "feedback episode does not belong to the requested session");
            }
        }
        let rawTurn = request.rawTurnId ? this.deps.requireRawTurn(request.rawTurnId) : undefined;
        if (rawTurn) {
            this.deps.assertRawTurnInScope(rawTurn, request.namespace);
            if (request.sessionId && rawTurn.sessionId !== request.sessionId) {
                throw new MemoryServiceError("conflict", "feedback raw turn does not belong to the requested session");
            }
            if (episode && rawTurn.episodeId !== episode.id) {
                throw new MemoryServiceError("conflict", "feedback raw turn does not belong to the requested episode");
            }
            episode = episode ?? this.deps.repos.runtime.getEpisode(rawTurn.episodeId);
        }
        if (request.l1MemoryId) {
            const memory = this.deps.requireExistingMemory(request.l1MemoryId);
            this.deps.assertMemoryInScope(memory, request.namespace);
            const trace = this.deps.traceMeta(memory);
            if (!trace) {
                throw new MemoryServiceError("invalid_argument", "feedback l1MemoryId must reference an L1 trace memory");
            }
            const traceRawTurnId = rawTurnIdFromMemory(memory);
            if (request.sessionId && memory.sessionId && memory.sessionId !== request.sessionId) {
                throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested session");
            }
            if (episode && trace.episodeId && trace.episodeId !== episode.id) {
                throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested episode");
            }
            if (rawTurn && traceRawTurnId && traceRawTurnId !== rawTurn.id) {
                throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested raw turn");
            }
            return {
                l1MemoryId: memory.id,
                rawTurnId: rawTurn?.id ?? traceRawTurnId,
                episodeId: episode?.id ?? trace.episodeId,
                sessionId: request.sessionId ?? memory.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
            };
        }
        const rawTurnTarget = rawTurn ? this.feedbackTargetFromRawTurn(rawTurn) : undefined;
        if (rawTurnTarget) {
            const trace = this.deps.traceMeta(rawTurnTarget);
            return {
                l1MemoryId: rawTurnTarget.id,
                rawTurnId: rawTurn?.id ?? rawTurnIdFromMemory(rawTurnTarget),
                episodeId: episode?.id ?? trace?.episodeId,
                sessionId: request.sessionId ?? rawTurnTarget.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
            };
        }
        const episodeTarget = episode ? this.feedbackTargetFromEpisode(episode) : undefined;
        if (episode && episodeTarget) {
            const trace = this.deps.traceMeta(episodeTarget);
            return {
                l1MemoryId: episodeTarget.id,
                rawTurnId: rawTurnIdFromMemory(episodeTarget),
                episodeId: episode.id ?? trace?.episodeId,
                sessionId: request.sessionId ?? episodeTarget.sessionId ?? episode.sessionId
            };
        }
        return {
            rawTurnId: rawTurn?.id,
            episodeId: episode?.id,
            sessionId: request.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
        };
    }
    feedbackTargetFromRawTurn(rawTurn) {
        const episode = this.deps.repos.runtime.getEpisode(rawTurn.episodeId);
        for (const id of [...(episode?.l1MemoryIds ?? [])].reverse()) {
            const memory = this.deps.repos.memories.get(id);
            if (memory && rawTurnIdFromMemory(memory) === rawTurn.id && this.deps.traceMeta(memory)) {
                return memory;
            }
        }
        return this.deps.repos.memories
            .list({ memoryLayer: "L1", status: "activated" }, 1000)
            .find((memory) => rawTurnIdFromMemory(memory) === rawTurn.id && Boolean(this.deps.traceMeta(memory)));
    }
    feedbackTargetFromEpisode(episode) {
        for (const id of [...episode.l1MemoryIds].reverse()) {
            const memory = this.deps.repos.memories.get(id);
            if (memory && this.deps.traceMeta(memory)) {
                return memory;
            }
        }
        return undefined;
    }
}
function updateRecallStats(memory, input) {
    const current = isRecord(memory.properties.internal_info.recall)
        ? memory.properties.internal_info.recall
        : {};
    const positive = numberOr(current.positive, 0) + (input.outcome === "positive" ? 1 : 0);
    const negative = numberOr(current.negative, 0) + (input.outcome === "negative" ? 1 : 0);
    const ignored = numberOr(current.ignored, 0) + (input.outcome === "ignored" ? 1 : 0);
    const total = positive + negative + ignored;
    const effectiveness = total > 0 ? (positive - negative) / total : 0;
    return {
        ...memory,
        properties: {
            ...memory.properties,
            internal_info: {
                ...memory.properties.internal_info,
                recall: {
                    ...current,
                    positive,
                    negative,
                    ignored,
                    total,
                    effectiveness,
                    last_outcome: input.outcome,
                    last_feedback_id: input.feedbackId,
                    last_recall_event_id: input.recallEventId,
                    updated_at: input.updatedAt
                }
            }
        },
        updatedAt: input.updatedAt
    };
}
function recallOutcomeFromFeedback(feedback) {
    if (feedback.polarity === "positive")
        return "positive";
    if (feedback.polarity === "negative")
        return "negative";
    return "ignored";
}
export function polarityFromTurnFeedback(feedback) {
    if (feedback.polarity === "positive")
        return "positive";
    if (feedback.polarity === "negative")
        return "negative";
    return "neutral";
}
function repairIssueFromFeedback(request, classification) {
    if (classification.shape === "correction" && classification.correction) {
        return `Correction requested: ${clip(classification.correction, 180)}`;
    }
    if (classification.shape === "preference" && classification.avoid) {
        return `Avoided approach: ${clip(classification.avoid, 180)}`;
    }
    if (classification.shape === "constraint" && classification.constraint) {
        return `Missing constraint: ${clip(classification.constraint, 180)}`;
    }
    return clip(request.rationale ?? classification.text, 220) || "negative feedback";
}
function repairSuggestionFromFeedback(request, classification) {
    const target = classification.prefer ?? classification.correction ?? classification.constraint;
    if (target)
        return `Prefer: ${clip(target, 200)}`;
    return clip(request.rationale ?? classification.text, 220) || "Prefer the path that avoids the reported issue.";
}
function repairPreferenceFromFeedback(request, classification) {
    const target = classification.prefer ?? classification.correction ?? classification.constraint;
    if (target)
        return `Prefer: ${clip(target, 200)}`;
    return `Prefer: ${clip(request.rationale ?? classification.text, 200) || "use a corrected approach next time"}`;
}
function repairAntiPatternFromFeedback(request, classification) {
    const target = classification.avoid ?? (classification.shape === "negative" ? (request.rationale ?? classification.text) : undefined);
    if (target)
        return `Avoid: ${clip(target, 200)}`;
    return "Avoid: repeating the same approach after negative feedback.";
}
function cleanFeedbackText(value) {
    if (!value)
        return undefined;
    return value.trim().replace(/^["'`]|["'`]$/g, "").trim() || undefined;
}
export const DECISION_REPAIR_OPERATION = `${DECISION_REPAIR_PROMPT.id}.v${DECISION_REPAIR_PROMPT.version}`;
const DECISION_REPAIR_SYSTEM_PROMPT = `${DECISION_REPAIR_PROMPT.system}

Service extension:
- USER_FEEDBACK may be provided when the repair is triggered by explicit user
  correction, preference, or constraint feedback instead of a pure retry loop.
- In that case, CURRENT_CONTEXT describes what the agent is trying to fix now,
  and FAILURE_HISTORY may contain low-value traces or the feedback text itself.
- Ground guidance in USER_FEEDBACK, FAILURE_HISTORY, or SIMILAR_SUCCESS.
- If SIMILAR_SUCCESS is empty, use severity="info" and confidence <= 0.5 unless
  the user feedback is a direct correction.`;
export function decisionRepairPromptMessages(input) {
    const high = input.highValue
        .map((memory) => decisionRepairTraceBlock(memory, input.traceCharCap))
        .filter(Boolean)
        .join("\n---\n");
    const low = input.lowValue
        .map((memory) => decisionRepairTraceBlock(memory, input.traceCharCap))
        .filter(Boolean)
        .join("\n---\n");
    const contextHead = [
        `TRIGGER: ${input.trigger}`,
        `CONTEXT_HASH: ${input.contextHash}`,
        `FEEDBACK_SHAPE: ${input.classification.shape}`,
        input.classification.prefer ? `USER_PREFERS: ${input.classification.prefer}` : "",
        input.classification.avoid ? `USER_AVOIDS: ${input.classification.avoid}` : "",
        input.classification.correction ? `USER_CORRECTION: ${input.classification.correction}` : "",
        input.classification.constraint ? `USER_CONSTRAINT: ${input.classification.constraint}` : ""
    ].filter(Boolean).join("\n");
    const userContent = [
        "CURRENT_CONTEXT:",
        contextHead,
        "",
        `USER_FEEDBACK:\n${clip(input.feedbackText, 800) || "(none)"}`,
        "",
        "FAILURE_HISTORY:",
        low || "(none)",
        "",
        "SIMILAR_SUCCESS:",
        high || "(none)",
        "",
        "Return the JSON object described in the system prompt."
    ].join("\n");
    return [
        { role: "system", content: DECISION_REPAIR_SYSTEM_PROMPT },
        { role: "user", content: userContent }
    ];
}
export async function synthesizeDecisionRepairDraft(input, options) {
    if (!options.useLlm || !options.llm.isConfigured())
        return undefined;
    const messages = decisionRepairPromptMessages(input);
    try {
        const result = await options.llm.completeJson(messages, {
            operation: DECISION_REPAIR_OPERATION,
            thinkingMode: "enabled",
            temperature: options.llm.config.temperature,
            maxTokens: 800
        });
        return normalizeDecisionRepairLlmDraft(result);
    }
    catch (error) {
        pipelineLogger.warn("fallback.used", {
            operation: DECISION_REPAIR_OPERATION,
            pipeline: input.diagnostics?.pipeline ?? decisionRepairPipelineForTrigger(input.trigger),
            fallback: "no_llm_draft",
            feedbackId: input.diagnostics?.feedbackId,
            sourceMemoryId: input.diagnostics?.sourceMemoryId,
            ...memoryErrorFields(error)
        });
        return undefined;
    }
}
function decisionRepairPipelineForTrigger(trigger) {
    if (trigger === "failure-burst")
        return "decision_repair.failure_burst";
    if (trigger === "value-distribution")
        return "decision_repair.value_distribution";
    return "decision_repair.feedback";
}
function decisionRepairTraceBlock(source, charCap) {
    const { memory, rawTurn } = source;
    const trace = traceMetaFromMemoryWithRaw(memory, rawTurn);
    if (!trace)
        return "";
    return [
        `trace ${memory.id}`,
        `value: ${roundNumber(trace.value)}`,
        trace.userText ? `user: ${tailClip(trace.userText, charCap)}` : "",
        trace.agentText ? `agent: ${tailClip(trace.agentText, charCap)}` : "",
        trace.reflection ? `reflection: ${tailClip(trace.reflection, charCap)}` : ""
    ].filter(Boolean).join("\n");
}
export function normalizeDecisionRepairLlmDraft(value) {
    const preference = typeof value.preference === "string" ? value.preference.trim() : "";
    const antiPattern = typeof value.anti_pattern === "string" ? value.anti_pattern.trim() : "";
    if (!preference && !antiPattern)
        return undefined;
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
        ? clampNumber(value.confidence, 0, 1)
        : 0.5;
    return {
        preference: clip(preference || "Prefer the path that avoids the reported issue.", 360),
        antiPattern: clip(antiPattern || "Avoid repeating the reported failing approach.", 360),
        severity: value.severity === "warn" ? "warn" : "info",
        confidence
    };
}
const NEGATIVE_FEEDBACK_REFINEMENT_EXAMPLES = `Extract guidance to AVOID this mistake.

CRITICAL: Be SPECIFIC and CONCISE.
- Identify the concrete task type, e.g. "bubble sort implementation", not "similar task".
- Extract the specific requirement, e.g. "descending order", not "adjust according to feedback".
- Only fill caveats/verification if you have specific content.

Example 1:
Turn 1:
User: "写个冒泡排序"
Agent: [generates ascending sort code]

Turn 2:
User: "写的不对，我要的是从大到小的"

Output:
{
  "title": "Bubble sort: descending order",
  "trigger": "When the user asks to implement bubble sort.",
  "procedure": "Implement descending order by using > in the comparison.",
  "caveats": [],
  "verification": "",
  "confidence": 0.85
}

Example 2:
Turn 1:
User: "Write a function to filter even numbers from an array."
Agent: [generates filter with wrong boolean logic]

Turn 2:
User: "Wrong, it should use AND conditions, not OR."

Output:
{
  "title": "Confirm filter condition operators",
  "trigger": "When the user asks to filter or select data.",
  "procedure": "Before generating code, confirm whether multiple filter conditions should use AND or OR.",
  "caveats": ["Do not assume multiple conditions use OR by default."],
  "verification": "Check that the generated code uses the requested logical operator.",
  "confidence": 0.9
}

BAD Example:
{
  "title": "Fix user feedback",
  "trigger": "When a similar task appears",
  "procedure": "Adjust according to feedback",
  "caveats": ["Avoid repeating the current mistake"],
  "verification": "Check whether the issue is solved",
  "confidence": 0.5
}`;
const POSITIVE_FEEDBACK_REFINEMENT_EXAMPLES = `Extract guidance to REPLICATE this success.

CRITICAL: Be SPECIFIC and CONCISE.
- Identify the concrete task type.
- Extract the specific success pattern.
- Only fill caveats/verification if you have specific content.

Example:
Turn 1:
User: "写个快速排序"
Agent: [generates quicksort with three-way partitioning]

Turn 2:
User: "很好，这个实现很高效"

Output:
{
  "title": "Quicksort: use three-way partitioning",
  "trigger": "When the user asks to implement quicksort.",
  "procedure": "Use three-way partitioning for duplicate elements and choose a median or random pivot.",
  "caveats": ["Avoid always choosing the first element as pivot because sorted arrays degrade to O(n^2)."],
  "verification": "Check that the code partitions into less-than, equal-to, and greater-than groups.",
  "confidence": 0.85
}`;
function stripFeedbackRefinementPrefix(title, prefix) {
    const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*[:：-]\\s*`, "i");
    return title.replace(pattern, "").trim() || title;
}
function feedbackTaskContext(userRequest, episodeContext) {
    const combined = `${userRequest} ${episodeContext}`.toLowerCase();
    const patterns = [
        { pattern: /(写|实现|生成|创建).{0,8}(排序|冒泡|快排|归并|选择|插入)/, trigger: "When the user asks to implement a sorting algorithm.", taskType: "sorting algorithm implementation" },
        { pattern: /(写|实现|生成|创建).{0,8}(搜索|查找|二分|遍历)/, trigger: "When the user asks to implement a search algorithm.", taskType: "search algorithm implementation" },
        { pattern: /(筛选|过滤|filter|select).{0,16}(数据|数组|列表|records|rows)/, trigger: "When the user asks to filter data.", taskType: "data filtering" },
        { pattern: /(读取|写入|操作).{0,8}(文件|file)/, trigger: "When the user asks for file operations.", taskType: "file operation" },
        { pattern: /(调用|请求|fetch).{0,8}(api|接口|服务)/, trigger: "When the user asks to call an API or service.", taskType: "API call" },
        { pattern: /(处理|解析|parse).{0,12}(json|xml|csv|数据|filing|document)/, trigger: "When the user asks to parse structured data or documents.", taskType: "structured data parsing" },
        { pattern: /(格式化|format|转换|convert)/, trigger: "When the user asks to format or convert data.", taskType: "data formatting" },
        { pattern: /(sec|13f|cusip|issuer|holding)/, trigger: "When the user asks to parse SEC 13F holdings or issuer/CUSIP data.", taskType: "SEC 13F parsing" }
    ];
    for (const item of patterns) {
        if (item.pattern.test(combined)) {
            return { trigger: item.trigger, taskType: item.taskType };
        }
    }
    const verbNoun = combined.match(/\b(write|implement|create|parse|process|convert|filter)\s+(.{2,40}?)(?:\.|\n|$)/i);
    if (verbNoun?.[1] && verbNoun[2]) {
        const task = clip(verbNoun[2].trim(), 80);
        return {
            trigger: `When the user asks to ${verbNoun[1]} ${task}.`,
            taskType: `${verbNoun[1]} ${task}`
        };
    }
    return { trigger: "", taskType: "" };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function feedbackExperienceGuidance(type, classification, text) {
    const preference = [];
    const antiPattern = [];
    if (classification.shape === "preference") {
        if (classification.prefer)
            preference.push(clip(classification.prefer, 360));
        if (classification.avoid)
            antiPattern.push(clip(classification.avoid, 360));
    }
    else if (classification.shape === "correction" && classification.correction) {
        preference.push(clip(classification.correction, 360));
    }
    else if (classification.shape === "constraint" && classification.constraint) {
        preference.push(clip(classification.constraint, 360));
    }
    if (type === "failure_avoidance")
        antiPattern.push(text);
    if (type === "repair_instruction" || type === "success_pattern")
        preference.push(text);
    return {
        preference: dedupeTextLines(preference),
        antiPattern: dedupeTextLines(antiPattern)
    };
}
function feedbackExperienceTraceIds(feedback, episode, trace) {
    return uniq([
        feedback.l1MemoryId,
        trace?.id,
        ...(episode?.l1MemoryIds ?? [])
    ].filter((id) => typeof id === "string" && id.length > 0));
}
function feedbackExperiencePrefix(type) {
    if (type === "failure_avoidance")
        return "Avoid";
    if (type === "repair_instruction")
        return "Repair";
    if (type === "preference")
        return "Prefer";
    if (type === "verifier_feedback")
        return "Verifier";
    if (type === "repair_validated")
        return "Validated";
    return "Success";
}
function firstFeedbackSentence(text, maxChars) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0] ?? normalized;
    return clip(sentence, maxChars);
}
function feedbackTraceHint(trace) {
    return [
        trace.summary ? `summary=${clip(trace.summary, 140)}` : null,
        trace.userText ? `user=${clip(trace.userText, 140)}` : null,
        trace.reflection ? `note=${clip(trace.reflection, 140)}` : null
    ].filter(Boolean).join(" | ");
}
function feedbackRawText(raw) {
    if (!raw)
        return "";
    if (typeof raw === "string")
        return raw.trim();
    if (!isRecord(raw))
        return String(raw);
    return dedupeTextLines([
        raw.feedback,
        raw.text,
        raw.message,
        raw.rationale,
        raw.reason,
        raw.verdict,
        raw.summary
    ].filter((item) => typeof item === "string")).join("\n");
}
function extractFeedbackVerifierMeta(raw, lower) {
    const looksVerifier = lower.includes("verifier") ||
        lower.includes("verification") ||
        lower.includes("counterexample") ||
        lower.includes("本任务评为反例");
    if (!looksVerifier && !isRecord(raw))
        return null;
    const meta = { source: "feedback" };
    if (looksVerifier)
        meta.verifier = true;
    if (isRecord(raw)) {
        for (const key of ["verdict", "score", "reward", "passed", "taskId", "family", "reason"]) {
            if (raw[key] !== undefined)
                meta[key] = raw[key];
        }
    }
    return Object.keys(meta).length > 1 || looksVerifier ? meta : null;
}
function feedbackVerifierScore(raw) {
    if (!isRecord(raw))
        return 0;
    for (const key of ["score", "reward", "r", "rating"]) {
        const value = Number(raw[key]);
        if (Number.isFinite(value))
            return Math.min(1, Math.abs(value));
    }
    return 0;
}
function isPositiveFeedbackExperience(feedback, lower, shape, verifier) {
    if (feedback.polarity === "positive")
        return true;
    if (shape === "positive")
        return true;
    if (verifier && lower.includes("pass"))
        return true;
    return /\b(success|succeeded|passed|task succeeded|works well|correct)\b/.test(lower) ||
        /成功|通过|正确|太好了|写得很好/.test(lower);
}
function isNegativeFeedbackExperience(feedback, lower, shape, verifier) {
    if (feedback.polarity === "negative")
        return true;
    if (shape === "negative" || shape === "correction")
        return true;
    if (verifier && /\b(fail|failed|counterexample)\b/.test(lower))
        return true;
    return /\b(fail|failed|wrong|incorrect|counterexample|not acceptable)\b/.test(lower) ||
        /失败|错误|不对|反例/.test(lower);
}
function dedupeTextLines(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== "string")
            continue;
        const line = value.trim();
        if (!line || seen.has(line))
            continue;
        seen.add(line);
        out.push(line);
    }
    return out;
}
function tailClip(value, max) {
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (cleaned.length <= max)
        return cleaned;
    return `...${cleaned.slice(Math.max(0, cleaned.length - max))}`;
}
function uniq(values) {
    return Array.from(new Set(values));
}
function stringOr(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function numberOr(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}
function traceMetaFromMemoryWithRaw(memory, rawTurn) {
    const trace = traceMetaFromMemory(memory);
    if (!trace || !rawTurn)
        return trace;
    const internalTrace = isRecord(memory.properties.internal_info.trace)
        ? memory.properties.internal_info.trace
        : {};
    const rawSpan = isRecord(internalTrace.raw_span) ? internalTrace.raw_span : {};
    const hasUserSpan = rawSpan.user_text === true;
    const hasAgentSpan = rawSpan.agent_text === true;
    const isRedacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);
    return {
        ...trace,
        toolCalls: isRedacted
            ? trace.toolCalls
            : rawTurn.toolCalls.filter(isToolCallPayload),
        userText: isRedacted
            ? (hasUserSpan ? "[REDACTED]" : trace.userText)
            : (trace.userText || (hasUserSpan ? rawTurn.userText ?? "" : "")),
        agentText: isRedacted
            ? (hasAgentSpan ? "[REDACTED]" : trace.agentText)
            : (trace.agentText || (hasAgentSpan ? rawTurn.assistantText ?? "" : ""))
    };
}
function rawTurnIdFromMemory(memory) {
    const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
    if (typeof sourceRawTurnId === "string" && sourceRawTurnId)
        return sourceRawTurnId;
    const rawTurnId = memory.properties.internal_info.raw_turn_id;
    if (typeof rawTurnId === "string" && rawTurnId)
        return rawTurnId;
    const trace = memory.properties.internal_info.trace;
    return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined;
}
function stringFromRecord(record, key) {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}
function isToolCallPayload(value) {
    return isRecord(value) && typeof value.name === "string";
}
function roundNumber(value, digits = 4) {
    const base = Math.pow(10, digits);
    return Math.round(value * base) / base;
}
function namespaceIdFromMemory(memory) {
    return namespaceIdFromContext(namespaceForMemory(memory));
}
function namespaceIdFromContext(namespace) {
    return [
        namespace.tenantId,
        namespace.userId,
        namespace.projectId ?? namespace.workspaceId,
        namespace.source,
        namespace.profileId
    ].filter(Boolean).join(":");
}
function memoryStatusForLifecycleStatus(status) {
    if (status === "archived")
        return "archived";
    return status === "candidate" ? "resolving" : "activated";
}
