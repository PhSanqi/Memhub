import { isRecord } from "../../utils/json.js";
import { clip, firstLine } from "../../utils/text.js";
/**
 * Embedding and trace-summary worker domain, extracted from MemoryService.
 *
 * This module intentionally has no MemoryService import.  The host owns the
 * generic job-enqueue policy; this processor owns the job-specific state
 * transitions, model calls, and change records.
 */
import { retrievalDocumentSourceHash, traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import { kindFromMemory } from "../../storage/repositories.js";
import { stableHash } from "../../utils/id.js";
import { isMemmyRecallToolName } from "../../utils/memmy-context-tags.js";
import { firstRealSummary, importStatusTags, isImportSummaryPlaceholder, memoryHasImportPipeline, memoryNeedsImportSummary, updateImportPipelineStatus, updateTraceImportSummary } from "../import/import-job-processor.js";
import { IMPORT_DEFAULT_ALPHA, IMPORT_DEFAULT_PRIORITY, IMPORT_DEFAULT_VALUE } from "../import/memory-import-pipeline.js";
import { namespaceForMemory } from "../namespace/namespace-scope.js";
import { processingJobMatchesMemory } from "../worker/job-handlers.js";
import { buildUserMemory, isDynamicCurrentFactQuery } from "../user-memory/user-memory.js";
import { embeddingTextForMemory, traceSummaryEmbeddingText, updateMemoryVectorField } from "./embedding-pipeline.js";
export class EmbeddingJobProcessor {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async embedMemory(job) {
        const item = this.prepareEmbeddingJob(job);
        if (!item)
            return;
        try {
            const [vector] = await this.deps.embedder.embed([item.text], item.role);
            this.applyEmbeddingVector(item, vector ?? []);
        }
        catch (error) {
            if (!this.enqueueEmbeddingRetryAfterFailure(item, error))
                throw error;
        }
    }
    async embedUserMemory(job) {
        const memory = job.targetMemoryId
            ? this.deps.repos.userMemories.get(job.targetMemoryId)
            : undefined;
        if (!memory)
            throw new Error(`user memory embedding target not found: ${job.targetMemoryId ?? "unknown"}`);
        const contentHash = typeof job.payload.contentHash === "string" ? job.payload.contentHash : undefined;
        if (contentHash && contentHash !== stableHash(memory.content))
            return;
        const vector = await this.deps.embedder.embedOne(memory.content, "document");
        const current = this.deps.repos.userMemories.get(memory.id);
        if (!current || (contentHash && contentHash !== stableHash(current.content)))
            return;
        const at = this.deps.nowIso();
        const saved = this.deps.repos.userMemories.updateEmbedding(current.id, vector, {
            model: this.deps.embedder.config.model,
            provider: this.deps.embedder.config.provider,
            updatedAt: at
        });
        if (!saved)
            return;
        this.deps.repos.runtime.appendChange({
            memoryId: saved.id,
            kind: "user_memory",
            op: "updated",
            entityId: saved.id,
            userId: saved.userId,
            changeType: "user_memory_embedding_updated",
            before: current,
            after: saved,
            source: "worker.user_memory_embedding",
            createdAt: at
        });
    }
    prepareEmbeddingJob(job) {
        const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
        if (!memory) {
            if (job.targetMemoryId && this.isRejectedCaptureTarget(job.targetMemoryId))
                return null;
            throw new Error(`embedding target not found: ${job.targetMemoryId ?? "unknown"}`);
        }
        if (!processingJobMatchesMemory(job, memory))
            return null;
        if (memory.memoryLayer === "L1") {
            if (memoryNeedsImportSummary(memory)) {
                this.deps.enqueueImportSummaryIfMissing(memory, this.deps.nowIso());
                return null;
            }
            const text = traceSummaryEmbeddingText(memory);
            if (!text) {
                this.deps.enqueueImportSummaryIfMissing(memory, this.deps.nowIso());
                return null;
            }
            return { job, memory, text, role: "document", vectorField: "vec_summary" };
        }
        const text = embeddingTextForMemory(memory);
        return {
            job,
            memory,
            text,
            role: "query",
            vectorField: "vec",
            sourceHash: memory.memoryLayer === "Skill" || memory.memoryLayer === "L3"
                ? retrievalDocumentSourceHash(memory)
                : undefined
        };
    }
    applyEmbeddingVector(item, vector) {
        const current = this.deps.repos.memories.get(item.memory.id);
        if (!current) {
            if (this.isRejectedCaptureTarget(item.memory.id))
                return;
            throw new Error(`embedding target not found: ${item.memory.id}`);
        }
        if (!processingJobMatchesMemory(item.job, current))
            return;
        if (item.sourceHash && retrievalDocumentSourceHash(current) !== item.sourceHash)
            return;
        this.persistEmbeddingVector({
            memoryId: current.id,
            vectorField: item.vectorField,
            vector,
            attemptCount: item.job.attempts,
            source: "worker.embedding",
            sourceHash: item.sourceHash,
            allowedProcessingStates: ["embedding_pending", "embedding"],
            finalize: (_saved, hadProcessing, at) => {
                if (hadProcessing)
                    this.deps.repos.runtime.completeJob(item.job.id, at);
            }
        });
    }
    persistEmbeddingVector(input) {
        const current = this.deps.repos.memories.get(input.memoryId);
        if (!current)
            throw new Error(`embedding target not found: ${input.memoryId}`);
        const at = this.deps.nowIso();
        let saved = current;
        this.deps.repos.transaction(() => {
            const vectorized = updateMemoryVectorField(current, input.vectorField, input.vector, {
                model: this.deps.embedder.config.model ?? this.deps.embedder.config.provider,
                provider: this.deps.embedder.config.provider,
                updatedAt: at,
                sourceHash: input.sourceHash
            });
            saved = this.deps.repos.memories.updateMaintenance(current.memoryLayer === "L1" ? updateImportPipelineStatus(vectorized, "indexed", at) : vectorized);
            const hadProcessing = Boolean(this.deps.repos.processing.get(saved.id));
            if (hadProcessing) {
                this.deps.repos.processing.update(saved.id, {
                    state: "ready", stage: null, activeJobId: null, attemptCount: input.attemptCount,
                    retryAction: "retry", errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
                }, input.allowedProcessingStates ?? ["embedding_pending", "embedding"]);
            }
            this.appendMemoryChange(saved, current, input.source, at);
            input.finalize?.(saved, hadProcessing, at);
        });
        return saved;
    }
    enqueueEmbeddingRetryAfterFailure(item, error) {
        if (this.deps.repos.processing.get(item.memory.id))
            return false;
        const retry = this.deps.enqueueEmbeddingRetry(item.memory, item.text, this.deps.nowIso(), item.vectorField);
        this.deps.appendEmbeddingRetryChange(retry, "queued", undefined, {
            code: "embedding_error",
            message: error instanceof Error ? error.message : String(error)
        });
        return true;
    }
    async summarizeImportedTrace(job) {
        const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
        if (!memory || memory.memoryLayer !== "L1") {
            throw new Error(`import summary target not found: ${job.targetMemoryId ?? "unknown"}`);
        }
        if (!processingJobMatchesMemory(job, memory))
            return;
        const trace = traceMetaFromMemory(memory);
        if (!trace)
            throw new Error(`import trace payload is missing: ${memory.id}`);
        const generated = this.deps.llm.isConfigured()
            ? await this.deps.summarizeTraceForCapture({ trace, userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflectionText: "" }, { strict: true })
            : fallbackImportSummary(trace, memory);
        const summary = firstRealSummary(generated) ?? fallbackImportSummary(trace, memory);
        const at = this.deps.nowIso();
        const current = this.deps.repos.memories.get(memory.id);
        if (!current || !processingJobMatchesMemory(job, current))
            return;
        this.deps.repos.transaction(() => {
            const previous = current;
            const next = updateImportPipelineStatus(updateTraceImportSummary(current, {
                summary, alpha: IMPORT_DEFAULT_ALPHA, value: IMPORT_DEFAULT_VALUE, priority: IMPORT_DEFAULT_PRIORITY,
                tags: importStatusTags(memory.tags, "indexing"), updatedAt: at
            }), "indexing", at);
            const saved = this.deps.repos.memories.update(next);
            this.appendMemoryChange(saved, previous, "worker.import_summary", at);
            this.scheduleEmbeddingAfterTextUpdate({
                memory: saved,
                sourceJob: job,
                reason: "import.summary.updated",
                vectorField: "vec_summary",
                clearExistingVector: false,
                allowedProcessingStates: ["summary_pending", "summarizing"],
                textOnlyAttemptCount: 0,
                at
            });
        });
    }
    async summarizeCapturedTrace(job) {
        const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
        if (!memory || memory.memoryLayer !== "L1" || memoryHasImportPipeline(memory)) {
            throw new Error(`trace summary target is invalid: ${job.targetMemoryId ?? "unknown"}`);
        }
        if (!processingJobMatchesMemory(job, memory))
            return;
        const trace = traceMetaFromMemory(memory);
        if (!trace)
            throw new Error(`trace payload is missing: ${memory.id}`);
        const decideCapture = job.payload.decideCapture === true;
        const proposedDecision = decideCapture
            ? await this.deps.decideTurnMemoryForCapture({
                trace,
                userText: trace.userText,
                agentText: trace.agentText,
                toolCalls: trace.toolCalls,
                reflectionText: ""
            })
            : undefined;
        const proposedSummary = proposedDecision
            ? proposedDecision.l1Summary
            : this.deps.llm.isConfigured()
                ? await this.deps.summarizeTraceForCapture({ trace, userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflectionText: "" }, { strict: true })
                : trace.summary || fallbackTraceSummary(trace);
        const at = this.deps.nowIso();
        const current = this.deps.repos.memories.get(memory.id);
        if (!current || !processingJobMatchesMemory(job, current))
            return;
        const currentTrace = traceMetaFromMemory(current);
        if (!currentTrace)
            throw new Error(`trace payload is missing: ${current.id}`);
        const decision = proposedDecision
            ? constrainTurnMemoryDecision(proposedDecision, current, currentTrace)
            : undefined;
        const summary = decision?.l1Summary ?? proposedSummary;
        let finalizedEpisodeId;
        this.deps.repos.transaction(() => {
            let userMemoryCapture = userMemoryCaptureFromJob(job);
            if (decision?.createUserMemory && job.payload.captureUserMemory === true) {
                userMemoryCapture = this.captureUserMemoryFromDecision(current, currentTrace, decision, job, at);
            }
            if (decision && !decision.createL1) {
                this.recordTurnCaptureDiagnostics(currentTrace, current.id, decision, userMemoryCapture, job, at);
                const rejected = this.deps.repos.memories.update(recordTurnMemoryDecision(current, decision, "rejected", at));
                const deleted = this.deps.repos.memories.softDelete(rejected.id, at);
                if (deleted)
                    this.appendMemoryChange(deleted, current, "worker.turn_memory_decision.rejected", at);
                this.deps.repos.processing.delete(current.id);
                const episodeId = currentTrace.episodeId ?? job.episodeId;
                if (episodeId) {
                    finalizedEpisodeId = episodeId;
                }
                return;
            }
            const previous = current;
            const summarized = summary.trim() && summary.trim() !== currentTrace.summary.trim()
                ? this.deps.repos.memories.update(updateTraceSummary(current, { summary: summary.trim(), updatedAt: at }))
                : previous;
            const saved = decision
                ? this.deps.repos.memories.update(acceptTurnMemoryDecision(summarized, decision, at))
                : summarized;
            if (saved !== previous)
                this.appendMemoryChange(saved, previous, "worker.trace_summary", at);
            if (decision) {
                this.recordTurnCaptureDiagnostics(currentTrace, saved.id, decision, userMemoryCapture, job, at);
            }
            this.scheduleEmbeddingAfterTextUpdate({
                memory: saved,
                sourceJob: job,
                reason: "trace.summary.updated",
                vectorField: "vec_summary",
                clearExistingVector: false,
                allowedProcessingStates: ["summary_pending", "summarizing"],
                textOnlyAttemptCount: job.attempts,
                at
            });
            if (decision)
                finalizedEpisodeId = currentTrace.episodeId ?? job.episodeId;
        });
        if (finalizedEpisodeId) {
            const episode = this.deps.repos.runtime.getEpisode(finalizedEpisodeId);
            if (episode?.status === "closed")
                this.deps.finalizeClosedEpisode(episode, at);
        }
    }
    isRejectedCaptureTarget(memoryId) {
        const memory = this.deps.repos.memories.getIncludingDeleted(memoryId);
        const decision = memory && isRecord(memory.properties.internal_info.capture_decision)
            ? memory.properties.internal_info.capture_decision
            : undefined;
        return decision?.status === "rejected";
    }
    captureUserMemoryFromDecision(sourceMemory, trace, decision, job, at) {
        const content = decision.userMemoryAction === "correct_existing"
            ? decision.correctedUserMemoryContent?.trim() ?? ""
            : trace.userText.trim();
        const sourceTurnId = trace.rawTurnId;
        if (!content || !sourceTurnId || decision.userMemoryTypes.length === 0)
            return undefined;
        const sourceAt = Number.isFinite(trace.ts) ? new Date(trace.ts).toISOString() : at;
        if (decision.userMemoryAction === "confirm_existing" && decision.matchedUserMemoryId) {
            const confirmed = this.deps.repos.userMemories.confirmExisting({
                id: decision.matchedUserMemoryId,
                userId: sourceMemory.userId,
                sourceTurnId,
                memoryTypes: decision.userMemoryTypes,
                updatedAt: sourceAt
            });
            if (!confirmed)
                return undefined;
            this.deps.repos.runtime.appendChange({
                memoryId: confirmed.memory.id,
                kind: "user_memory",
                op: "updated",
                entityId: confirmed.memory.id,
                userId: confirmed.memory.userId,
                changeType: "user_memory_confirmed",
                before: confirmed.previous,
                after: confirmed.memory,
                source: "worker.turn_memory_decision",
                createdAt: at
            });
            return { action: "confirmed", memoryId: confirmed.memory.id };
        }
        const correctionTarget = decision.userMemoryAction === "correct_existing" && decision.matchedUserMemoryId
            ? this.deps.repos.userMemories.get(decision.matchedUserMemoryId)
            : undefined;
        if (decision.userMemoryAction === "correct_existing" &&
            (!correctionTarget || correctionTarget.userId !== sourceMemory.userId || correctionTarget.status !== "active"))
            return undefined;
        const candidate = buildUserMemory({
            id: `user_memory_${stableHash(`${sourceTurnId}:${content}`).slice(0, 20)}`,
            sourceTurnId,
            userId: sourceMemory.userId,
            memoryTypes: decision.userMemoryTypes,
            content,
            createdAt: sourceAt,
            ...(correctionTarget ? { replacesMemoryId: correctionTarget.id } : {})
        });
        const upsert = this.deps.repos.userMemories.upsertExact(candidate);
        if (correctionTarget && upsert.memory.id === correctionTarget.id) {
            throw new Error("user memory correction must change the target content");
        }
        this.deps.repos.runtime.appendChange({
            memoryId: upsert.memory.id,
            kind: "user_memory",
            op: upsert.created ? "created" : "updated",
            entityId: upsert.memory.id,
            userId: upsert.memory.userId,
            changeType: upsert.created ? "user_memory_created" : "user_memory_updated",
            before: upsert.previous,
            after: upsert.memory,
            source: "worker.turn_memory_decision",
            createdAt: at
        });
        if (correctionTarget) {
            const archived = this.deps.repos.userMemories.archiveForCorrection(correctionTarget.id, upsert.memory.id, at);
            if (archived) {
                this.deps.repos.runtime.appendChange({
                    memoryId: archived.id,
                    kind: "user_memory",
                    op: "archived",
                    entityId: archived.id,
                    userId: archived.userId,
                    changeType: "user_memory_archived",
                    before: correctionTarget,
                    after: archived,
                    source: "worker.turn_memory_decision",
                    createdAt: at
                });
            }
        }
        if (upsert.created && this.deps.capture.embedAfterCapture) {
            this.deps.enqueueJob({
                jobType: "user_memory_embedding",
                userId: upsert.memory.userId,
                sessionId: sourceMemory.sessionId,
                episodeId: job.episodeId,
                targetMemoryId: upsert.memory.id,
                payload: { contentHash: stableHash(upsert.memory.content) },
                maxAttempts: 6,
                createdAt: at
            });
        }
        return {
            action: correctionTarget ? "corrected" : upsert.created ? "created" : "updated",
            memoryId: upsert.memory.id,
            ...(correctionTarget ? { targetMemoryId: correctionTarget.id } : {})
        };
    }
    recordTurnCaptureDiagnostics(trace, l1MemoryId, decision, userMemoryCapture, job, at) {
        if (!trace.rawTurnId)
            return;
        const rawTurn = this.deps.repos.runtime.getRawTurn(trace.rawTurnId);
        if (!rawTurn)
            return;
        const turnComplete = isRecord(rawTurn.messagePayload?.turn_complete)
            ? rawTurn.messagePayload.turn_complete
            : {};
        const previous = isRecord(turnComplete.memory_capture) ? turnComplete.memory_capture : {};
        const previousL1 = Array.isArray(previous.l1)
            ? previous.l1.filter(isRecord)
            : [];
        const l1 = [
            ...previousL1.filter((item) => item.memory_id !== l1MemoryId),
            {
                memory_id: l1MemoryId,
                written: decision.createL1,
                policy_eligible: decision.policyEligible
            }
        ];
        const recordsUserMemory = job.payload.captureUserMemory === true || Boolean(userMemoryCapture);
        this.deps.repos.runtime.updateRawTurn({
            ...rawTurn,
            messagePayload: {
                ...rawTurn.messagePayload,
                turn_complete: {
                    ...turnComplete,
                    memory_capture: {
                        status: "completed",
                        decided_at: at,
                        l1,
                        ...(recordsUserMemory ? {
                            user_memory: {
                                written: Boolean(userMemoryCapture),
                                action: userMemoryCapture?.action ?? "none",
                                memory_id: userMemoryCapture?.memoryId,
                                target_memory_id: userMemoryCapture?.targetMemoryId
                            }
                        } : isRecord(previous.user_memory) ? { user_memory: previous.user_memory } : {})
                    }
                }
            }
        });
    }
    scheduleEmbeddingAfterTextUpdate(input) {
        const { memory, sourceJob, allowedProcessingStates } = input;
        const at = input.at ?? this.deps.nowIso();
        if (input.clearExistingVector && this.deps.repos.processing.get(memory.id)) {
            this.deps.repos.memories.deleteVector(memory.id, input.vectorField);
        }
        if (!this.deps.capture.embedAfterCapture) {
            this.markReadyTextOnly(memory, input.textOnlyAttemptCount, at, allowedProcessingStates);
            return;
        }
        const embeddingJob = this.enqueueEmbeddingJob(memory, sourceJob, at, input.reason);
        this.markEmbeddingPending(memory, embeddingJob.id, at, allowedProcessingStates);
    }
    enqueueEmbeddingJob(memory, source, at, reason) {
        return this.deps.enqueueJob({
            jobType: "embedding", userId: memory.userId, sessionId: memory.sessionId, episodeId: source.episodeId,
            targetMemoryId: memory.id,
            payload: { reason, sourceJobId: source.id, contentHash: memory.contentHash },
            maxAttempts: 6, createdAt: at
        });
    }
    markReadyTextOnly(memory, attemptCount, at, allowedStates) {
        this.deps.repos.processing.update(memory.id, {
            state: "ready_text_only", stage: null, activeJobId: null, attemptCount, retryAction: "retry",
            errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
        }, allowedStates);
    }
    markEmbeddingPending(memory, activeJobId, at, allowedStates) {
        this.deps.repos.processing.update(memory.id, {
            state: "embedding_pending", stage: "embedding", activeJobId, attemptCount: 0, retryAction: "retry",
            updatedAt: at
        }, allowedStates);
    }
    appendMemoryChange(after, before, source, createdAt) {
        this.deps.repos.runtime.appendChange({
            memoryId: after.id, namespaceId: namespaceIdFromMemory(after), kind: kindFromMemory(after), op: "updated",
            entityId: after.id, userId: after.userId, changeType: "update", before, after, source, createdAt
        });
    }
}
export function updateTraceSummary(memory, input) {
    const trace = traceMetaFromMemory(memory);
    if (!trace)
        return memory;
    const internalTrace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : {};
    const nextTrace = { ...internalTrace, summary: input.summary, summary_at: input.updatedAt };
    return { ...memory, memoryValue: renderTraceMemoryValue({
            summary: input.summary, rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"), stepIndex: numberFromRecord(internalTrace, "step_index"),
            userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls,
            reflection: { text: trace.reflection, alpha: trace.alpha }, value: trace.value, priority: trace.priority
        }), info: { ...memory.info, summary: input.summary }, properties: {
            ...memory.properties, info: { ...(memory.properties.info ?? {}), summary: input.summary },
            internal_info: { ...memory.properties.internal_info, summary: input.summary, trace: nextTrace }
        }, updatedAt: input.updatedAt };
}
function acceptTurnMemoryDecision(memory, decision, updatedAt) {
    const internal = memory.properties.internal_info;
    const pending = isRecord(internal.capture_decision) ? internal.capture_decision : {};
    const originalEvidenceStatus = typeof pending.original_evidence_status === "string"
        ? pending.original_evidence_status
        : undefined;
    const { evidence_status: _infoEvidenceStatus, ...info } = memory.info;
    const { evidence_status: _propertyInfoEvidenceStatus, ...propertyInfo } = memory.properties.info ?? {};
    const { evidence_status: _internalEvidenceStatus, ...internalWithoutEvidence } = internal;
    return {
        ...memory,
        status: "activated",
        info: {
            ...info,
            policy_eligible: decision.policyEligible,
            ...(originalEvidenceStatus ? { evidence_status: originalEvidenceStatus } : {})
        },
        properties: {
            ...memory.properties,
            status: "activated",
            info: {
                ...propertyInfo,
                policy_eligible: decision.policyEligible,
                ...(originalEvidenceStatus ? { evidence_status: originalEvidenceStatus } : {})
            },
            internal_info: {
                ...internalWithoutEvidence,
                policy_eligible: decision.policyEligible,
                ...(originalEvidenceStatus ? { evidence_status: originalEvidenceStatus } : {}),
                capture_decision: recordTurnMemoryDecisionFields(pending, decision, "accepted", updatedAt)
            }
        },
        updatedAt
    };
}
function recordTurnMemoryDecision(memory, decision, status, updatedAt) {
    const internal = memory.properties.internal_info;
    const pending = isRecord(internal.capture_decision) ? internal.capture_decision : {};
    return {
        ...memory,
        properties: {
            ...memory.properties,
            internal_info: {
                ...internal,
                capture_decision: recordTurnMemoryDecisionFields(pending, decision, status, updatedAt)
            }
        },
        updatedAt
    };
}
function recordTurnMemoryDecisionFields(pending, decision, status, updatedAt) {
    return {
        ...pending,
        status,
        create_l1: decision.createL1,
        policy_eligible: decision.policyEligible,
        create_user_memory: decision.createUserMemory,
        user_memory_types: decision.userMemoryTypes,
        user_memory_evidence: decision.userMemoryEvidence,
        user_memory_action: decision.userMemoryAction,
        matched_user_memory_id: decision.matchedUserMemoryId,
        corrected_user_memory_content: decision.correctedUserMemoryContent,
        l1_evidence: decision.l1Evidence.map((item) => ({
            quote: item.quote,
            source_role: item.sourceRole,
            kind: item.kind
        })),
        reason: decision.reason,
        decided_at: updatedAt
    };
}
function constrainTurnMemoryDecision(decision, memory, trace) {
    const text = trace.userText.trim();
    const evidenceTypes = decision.userMemoryEvidence.map((item) => item.type);
    const userMemoryTypes = uniq(evidenceTypes);
    const dynamicCurrent = isDynamicCurrentFactQuery(text);
    const verifiedToolObservation = hasVerifiedDurableToolObservation(memory, trace, dynamicCurrent);
    const createUserMemory = !dynamicCurrent && userMemoryTypes.length > 0 &&
        decision.createUserMemory && decision.userMemoryEvidence.length > 0;
    let createL1 = decision.createL1 && decision.l1Evidence.length > 0;
    const guards = [];
    if (decision.createUserMemory && decision.userMemoryEvidence.length === 0) {
        guards.push("user-memory-evidence-missing");
    }
    if (decision.createL1 && decision.l1Evidence.length === 0) {
        guards.push("l1-evidence-missing");
    }
    if (dynamicCurrent) {
        createL1 = false;
        guards.push("dynamic-current");
    }
    else if (verifiedToolObservation) {
        createL1 = true;
        guards.push("verified-tool-evidence");
    }
    const policyEligible = isPolicyEligibleCapture(decision, createL1, verifiedToolObservation);
    return {
        ...decision,
        createL1,
        l1Summary: createL1 ? decision.l1Summary.trim() || fallbackTraceSummary(trace) : "",
        policyEligible,
        createUserMemory,
        userMemoryTypes: createUserMemory ? userMemoryTypes : [],
        userMemoryAction: createUserMemory ? decision.userMemoryAction : "none",
        matchedUserMemoryId: createUserMemory ? decision.matchedUserMemoryId : undefined,
        reason: clip([decision.reason, guards.length > 0 ? `guards=${guards.join(",")}` : ""].filter(Boolean).join("; "), 300)
    };
}
function isPolicyEligibleCapture(decision, createL1, verifiedToolObservation) {
    if (!createL1 || !decision.policyEligible)
        return false;
    return decision.l1Evidence.some((evidence) => {
        if (evidence.sourceRole === "user" &&
            (evidence.kind === "user_preference" ||
                evidence.kind === "user_directive" ||
                evidence.kind === "decision" ||
                evidence.kind === "correction"))
            return true;
        if (evidence.kind !== "task_outcome")
            return false;
        return evidence.sourceRole === "user" || evidence.sourceRole === "tool" || verifiedToolObservation;
    });
}
function hasVerifiedDurableToolObservation(memory, trace, dynamicCurrent) {
    if (dynamicCurrent || trace.toolCalls.length === 0)
        return false;
    const captureDecision = isRecord(memory.properties.internal_info.capture_decision)
        ? memory.properties.internal_info.capture_decision
        : {};
    if (captureDecision.original_evidence_status !== "verified")
        return false;
    return trace.toolCalls.some((call) => !isMemmyRecallToolName(call.name));
}
function uniq(values) {
    return [...new Set(values)];
}
function userMemoryCaptureFromJob(job) {
    const memoryId = Array.isArray(job.payload.capturedUserMemoryIds)
        ? job.payload.capturedUserMemoryIds.find((id) => typeof id === "string" && id.length > 0)
        : undefined;
    if (!memoryId)
        return undefined;
    const corrected = job.payload.capturedUserMemoryAction === "corrected";
    return {
        action: corrected ? "corrected" : "created",
        memoryId,
        ...(corrected && typeof job.payload.capturedUserMemoryTargetId === "string"
            ? { targetMemoryId: job.payload.capturedUserMemoryTargetId }
            : {})
    };
}
function fallbackImportSummary(trace, memory) {
    const title = stringFromRecord(memory.info, "title");
    const summary = [trace.userText, trace.agentText, title].map((value) => firstLine(value ?? "")).find((value) => value && !isImportSummaryPlaceholder(value));
    return clip(summary || "导入记忆", 200);
}
function fallbackTraceSummary(trace) {
    return clip(firstLine([trace.summary, trace.userText, trace.agentText].filter(Boolean).join("\n")) || "trace memory", 200);
}
function renderTraceMemoryValue(step) {
    return [
        `Summary: ${step.summary}`, step.rawTurnId ? `RawTurn: ${step.rawTurnId}` : undefined,
        typeof step.stepIndex === "number" ? `TraceStep: ${step.stepIndex}` : undefined,
        step.userText ? `User:\n${step.userText}` : undefined,
        step.toolCalls.length ? ["Tool calls:", ...step.toolCalls.map((call) => `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`)].join("\n") : undefined,
        step.agentText ? `Agent:\n${step.agentText}` : undefined,
        step.reflection.text ? `Reflection: ${clip(step.reflection.text, 800)}` : undefined,
        `Alpha: ${step.reflection.alpha}`, `Value: ${step.value}`, `Priority: ${step.priority}`
    ].filter(Boolean).join("\n");
}
function namespaceIdFromMemory(memory) {
    const namespace = namespaceForMemory(memory);
    return [namespace.tenantId, namespace.userId, namespace.projectId ?? namespace.workspaceId, namespace.source, namespace.profileId].filter(Boolean).join(":");
}
function stringFromRecord(record, key) { const value = record[key]; return typeof value === "string" ? value : undefined; }
function numberFromRecord(record, key) { const value = record[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
