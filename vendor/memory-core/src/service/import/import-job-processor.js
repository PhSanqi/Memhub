import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import { stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { clip, firstLine } from "../../utils/text.js";
export const IMPORT_SUMMARY_QUEUED_TAG = "摘要排队中";
export const IMPORT_STATUS_TAGS = [
    IMPORT_SUMMARY_QUEUED_TAG,
    "摘要整理中",
    "摘要总结中",
    "建立索引中",
    "索引建立中",
    "索引已建立",
    "处理失败"
];
export const IMPORT_DEFAULT_ALPHA = 0;
export const IMPORT_DEFAULT_VALUE = 0;
export const IMPORT_DEFAULT_PRIORITY = 0.5;
export class ImportJobProcessor {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    addMemory(request) {
        const d = this.deps;
        d.assertMemoryAddEnabled();
        request = d.sanitizeMemoryAddRequest(request);
        const startedAt = Date.now();
        const receivedAt = d.nowIso();
        if (!request.content?.trim())
            throw d.createError("invalid_argument", "memory.add requires content");
        const context = d.resolveContext(request);
        const session = request.sessionId ? d.requireSession(request.sessionId) : undefined;
        if (session)
            d.assertSessionInScope(session, request.namespace);
        const layer = request.layer ?? "L1";
        const kind = kindForLayer(layer);
        const at = d.normalizeMemoryAddCreatedAt(request.createdAt, request.timeZone) ?? receivedAt;
        const importTrace = layer === "L1" ? d.memoryAddImportTrace(request, at) : null;
        const readOnlySkill = layer === "Skill";
        const sourceAgentId = readOnlySkill
            ? request.sourceAgentId?.trim() || request.source?.trim() || context.namespace.source?.trim()
            : undefined;
        if (readOnlySkill && !sourceAgentId) {
            throw d.createError("invalid_argument", "memory.add Skill requires sourceAgentId or source");
        }
        const importTitle = importTrace && d.isAgentSourceImportMemoryAdd(request) ? d.titleFromImportTrace(importTrace) : undefined;
        const title = importTitle ?? (request.title?.trim() || firstLine(request.content).slice(0, 120) || "Untitled memory");
        const importSummary = importTrace ? stringFromRecord(importTrace, "summary") || IMPORT_SUMMARY_QUEUED_TAG : undefined;
        const tags = d.memoryAddTags(request, importTrace !== null, importTrace ? stringArray(importTrace.tags) : []);
        const memoryKey = d.memoryAddKey(request, layer, title);
        const deletedReadOnlySkill = readOnlySkill
            ? d.memories.getByKeyIncludingDeleted(layer, memoryKey)
            : undefined;
        if (deletedReadOnlySkill?.status === "deleted" || deletedReadOnlySkill?.deletedAt) {
            const item = d.memories.toListItem(deletedReadOnlySkill);
            return {
                id: item.id,
                kind: item.kind,
                memoryLayer: item.memoryLayer,
                status: "deleted",
                title: item.title,
                summary: item.summary,
                tags: item.tags,
                createdAt: deletedReadOnlySkill.createdAt,
                serverTime: d.nowIso()
            };
        }
        const memory = d.buildMemory({
            userId: session?.userId ?? context.userId,
            conversationId: session?.conversationId,
            sessionId: session?.id ?? request.sessionId,
            agentId: session?.source ?? request.source?.trim() ?? context.namespace.source,
            appId: session?.workspaceId,
            projectId: session?.projectId ?? context.namespace.projectId,
            profileId: session?.profileId ?? context.namespace.profileId,
            layer, kind, memoryType: layer === "Skill" ? "SkillMemory" : "LongTermMemory",
            key: memoryKey,
            value: importTrace ? d.renderTraceMemoryValue({
                summary: importSummary ?? IMPORT_SUMMARY_QUEUED_TAG,
                userText: stringFromRecord(importTrace, "user_text"), agentText: stringFromRecord(importTrace, "agent_text"),
                toolCalls: d.toolCallsFromUnknown(importTrace.tool_calls),
                reflection: { text: null, alpha: IMPORT_DEFAULT_ALPHA }, value: IMPORT_DEFAULT_VALUE, priority: IMPORT_DEFAULT_PRIORITY
            }) : request.content,
            tags,
            info: {
                title,
                summary: importSummary ?? firstLine(request.content),
                source: request.source ?? "manual",
                turn_id: request.turnId,
                time_zone: request.timeZone,
                ...(readOnlySkill ? {
                    name: title,
                    eta: 0.5,
                    support: 1,
                    gain: 0,
                    skill_status: "active",
                    source_memory_ids: []
                } : {})
            },
            internal: {
                source: request.source ?? "manual", title, summary: importSummary ?? firstLine(request.content), turn_id: request.turnId, time_zone: request.timeZone,
                ...(request.sourceArtifactId?.trim() ? { source_artifact_id: request.sourceArtifactId.trim() } : {}),
                ...(readOnlySkill ? {
                    read_only: true,
                    source_namespace_tenant_id: request.namespace?.tenantId ?? context.namespace.tenantId ?? null,
                    source_namespace_project_id: request.namespace?.projectId ?? context.namespace.projectId ?? null,
                    source_agent_id: sourceAgentId,
                    source_skill_id: request.sourceSkillId?.trim() || request.turnId?.trim() || undefined,
                    source_skill_path: request.sourceSkillPath?.trim() || undefined,
                    source_skill_version: request.sourceSkillVersion?.trim() || undefined,
                    source_content_hash: request.sourceContentHash?.trim() || stableHash(request.content),
                    imported_at: receivedAt,
                    name: title,
                    invocation_guide: request.content,
                    procedure_json: { summary: request.content },
                    eta: 0.5,
                    support: 1,
                    gain: 0,
                    source_memory_ids: [],
                    evidence_anchor_ids: [],
                    skill: {
                        name: title,
                        eta: 0.5,
                        status: "active",
                        support: 1,
                        gain: 0,
                        source_memory_ids: [],
                        evidence_anchor_ids: [],
                        invocation_guide: request.content,
                        procedure_json: { summary: request.content },
                        trials_attempted: 0,
                        trials_passed: 0,
                        success_rate: 0,
                        beta_posterior: { alpha: 1, beta: 1, mean: 0.5 }
                    }
                } : {}),
                ...(importTrace ? { plugin_algorithm: "memory.add.import_async.v2", trace: importTrace } : {})
            },
            createdAt: at
        });
        const qaPair = layer === "L1" && d.isAgentSourceImportMemoryAdd(request)
            ? d.memoryAddQaPair(request)
            : null;
        const captureSource = qaPair
            ? d.normalizeMemoryCaptureSource(memory.agentId ?? request.source ?? context.namespace.source ?? "")
            : "";
        const persisted = d.transaction(() => {
            if (qaPair && captureSource) {
                const priorCaptureMemory = d.memories.getByKeyIncludingDeleted(layer, memoryKey);
                const capturePrimaryMemoryId = priorCaptureMemory &&
                    priorCaptureMemory.status !== "deleted" &&
                    !priorCaptureMemory.deletedAt
                    ? priorCaptureMemory.id
                    : memory.id;
                const capture = d.captureClaims.claim({
                    userId: memory.userId,
                    source: captureSource,
                    qaHash: d.memoryCaptureQaHash(qaPair.query, qaPair.answer),
                    primaryMemoryId: capturePrimaryMemoryId,
                    capturedBy: "agent_source_scan",
                    createdAt: at
                });
                if (!capture.claimed && capture.claim.capturedBy !== "agent_source_scan") {
                    const existing = d.memories.getIncludingDeleted(capture.claim.primaryMemoryId);
                    if (!existing) {
                        throw d.createError("conflict", "memory capture claim points to a missing memory");
                    }
                    d.assertMemoryInScope(existing, request.namespace);
                    return { duplicateMemory: existing };
                }
            }
            const upsert = d.memories.upsertByKey(memory);
            const inserted = upsert.memory;
            const changeSeq = d.runtime.appendChange({
                memoryId: inserted.id, namespaceId: d.namespaceIdFromMemory(inserted), kind: d.kindFromMemory(inserted),
                op: upsert.created ? "created" : "updated", entityId: inserted.id, userId: inserted.userId,
                changeType: upsert.created ? "create" : "update", before: upsert.previous, after: inserted,
                source: "memory.add", createdAt: at
            });
            if (readOnlySkill && upsert.created) {
                const sourceSkillIdentity = request.sourceSkillId?.trim() || request.sourceSkillPath?.trim();
                if (sourceAgentId && sourceSkillIdentity) {
                    for (const archived of d.memories.archivePriorReadOnlySkillVersions({
                        sourceAgentId,
                        sourceSkillIdentity,
                        currentMemoryId: inserted.id,
                        userId: inserted.userId,
                        projectId: request.namespace?.projectId ?? context.namespace.projectId ?? "",
                        tenantId: request.namespace?.tenantId ?? context.namespace.tenantId ?? inserted.userId,
                        at
                    })) {
                        d.runtime.appendChange({
                            memoryId: archived.id,
                            kind: "skill",
                            op: "archived",
                            entityId: archived.id,
                            userId: archived.userId,
                            changeType: "read_only_skill_superseded",
                            after: archived,
                            source: "memory.add",
                            createdAt: at
                        });
                    }
                }
            }
            if (importTrace) {
                const existing = d.processing.get(inserted.id);
                const contentChanged = Boolean(!upsert.created && upsert.previous?.contentHash && upsert.previous.contentHash !== inserted.contentHash);
                if (contentChanged)
                    d.memories.deleteVector(inserted.id, "vec_summary");
                const processing = !existing || contentChanged ? d.processing.save({
                    memoryId: inserted.id, state: "summary_pending", stage: "summary", activeJobId: null, attemptCount: 0,
                    manualRetryCount: existing?.manualRetryCount ?? 0, retryAction: "retry", errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
                }) : existing;
                if (!request.deferProcessing && processing.state === "summary_pending" && !processing.activeJobId) {
                    const job = d.enqueueJob({ jobType: "import_summary", userId: inserted.userId, sessionId: inserted.sessionId, targetMemoryId: inserted.id,
                        payload: { source: "memory.add", changeSeq, contentHash: inserted.contentHash }, maxAttempts: 3, createdAt: at });
                    d.processing.update(inserted.id, { activeJobId: job.id, updatedAt: at }, ["summary_pending"]);
                }
            }
            return { upsert, changeSeq, duplicateMemory: undefined };
        });
        if (persisted.duplicateMemory) {
            const item = d.memories.toListItem(persisted.duplicateMemory);
            return {
                id: item.id,
                kind: item.kind,
                memoryLayer: item.memoryLayer,
                status: item.status,
                title: item.title,
                summary: item.summary,
                tags: item.tags,
                createdAt: persisted.duplicateMemory.createdAt,
                serverTime: d.nowIso(),
                duplicate: true
            };
        }
        const inserted = persisted.upsert.memory;
        if (persisted.upsert.created && !d.isAgentSourceImportMemoryAdd(request)) {
            d.enqueueJob({ jobType: "episode_idle_close", userId: inserted.userId, sessionId: inserted.sessionId,
                dedupeKey: `episode_idle_close:memory.add:${inserted.id}`,
                payload: { triggerMemoryId: inserted.id, triggerSource: "memory.add", triggeredAt: receivedAt }, createdAt: receivedAt });
        }
        if (!importTrace && d.config.algorithm.capture.embedAfterCapture) {
            d.enqueueJob({ jobType: "embedding", userId: inserted.userId, sessionId: inserted.sessionId, targetMemoryId: inserted.id,
                payload: { source: "memory.add", changeSeq: persisted.changeSeq }, createdAt: at });
        }
        const item = d.memories.toListItem(inserted);
        const response = { id: item.id, kind: item.kind, memoryLayer: item.memoryLayer, status: item.status, title: item.title,
            summary: item.summary, tags: item.tags, createdAt: inserted.createdAt, serverTime: d.nowIso() };
        if (!d.isAgentSourceImportMemoryAdd(request))
            d.recordApiLog?.("memory_add", {
                sessionId: request.sessionId, turnId: request.turnId, layer, source: request.source, tags: request.tags, content: request.content
            }, { stored: 1, details: [{ role: item.kind, action: "stored", summary: item.summary, content: request.content, traceId: item.id }] }, Date.now() - startedAt, true, response.serverTime, inserted.agentId);
        return response;
    }
    memoryProcessingStatus(memoryIds, request = {}) {
        const ids = dedupeStrings(memoryIds).slice(0, 10_000);
        void request;
        return { items: this.deps.processing.getMany(ids), serverTime: this.deps.nowIso() };
    }
    retryMemoryProcessing(memoryId, request = {}) {
        const d = this.deps;
        d.assertMemoryAddEnabled();
        const memory = d.memories.get(memoryId);
        if (!memory)
            throw d.createError("not_found", `memory not found: ${memoryId}`);
        d.assertMemoryInScope(memory, request.namespace);
        const current = d.processing.get(memoryId);
        if (!current)
            throw d.createError("invalid_argument", `memory has no asynchronous processing state: ${memoryId}`);
        if (current.state !== "failed")
            return { accepted: false, processing: current, serverTime: d.nowIso() };
        if (current.retryAction === "none" || !current.stage)
            throw d.createError("conflict", current.errorMessage ?? "memory processing cannot be retried");
        const at = d.nowIso();
        const result = d.transaction(() => {
            const latest = d.processing.get(memoryId);
            if (!latest || latest.state !== "failed" || !latest.stage)
                return latest ? { accepted: false, processing: latest } : undefined;
            const summaryJobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
            const job = d.enqueueJob({ jobType: latest.stage === "summary" ? summaryJobType : "embedding", userId: memory.userId,
                sessionId: memory.sessionId, targetMemoryId: memory.id, payload: { source: "memory.processing.manual_retry", previousErrorCode: latest.errorCode ?? undefined, contentHash: memory.contentHash },
                maxAttempts: latest.stage === "summary" ? 3 : 6, createdAt: at });
            const processing = d.processing.save({ ...latest, state: latest.stage === "summary" ? "summary_pending" : "embedding_pending", activeJobId: job.id,
                attemptCount: 0, manualRetryCount: latest.manualRetryCount + 1, retryAction: "retry", updatedAt: at });
            return { accepted: true, processing, job: d.jobToRef(job) };
        });
        if (!result)
            throw d.createError("not_found", `processing state not found: ${memoryId}`);
        return { ...result, serverTime: at };
    }
    restartFailedProcessing(at, limit = 10_000) {
        const d = this.deps;
        if (!d.config.algorithm.enableMemoryAdd)
            return 0;
        let restarted = 0;
        for (const failed of d.processing.listByStates(["failed"], limit)) {
            if (!failed.stage || failed.retryAction === "none")
                continue;
            const memory = d.memories.get(failed.memoryId);
            if (!memory)
                continue;
            if (d.memories.hasVector(memory.id, "vec_summary")) {
                d.processing.update(memory.id, {
                    state: "ready",
                    stage: null,
                    activeJobId: null,
                    errorCode: null,
                    errorMessage: null,
                    failedAt: null,
                    updatedAt: at
                }, ["failed"]);
                continue;
            }
            if (failed.stage === "embedding" && !d.config.algorithm.capture.embedAfterCapture) {
                d.processing.update(memory.id, {
                    state: "ready_text_only",
                    stage: null,
                    activeJobId: null,
                    attemptCount: 0,
                    retryAction: "retry",
                    errorCode: null,
                    errorMessage: null,
                    failedAt: null,
                    updatedAt: at
                }, ["failed"]);
                continue;
            }
            const result = d.transaction(() => {
                const current = d.processing.get(memory.id);
                if (!current || current.state !== "failed" || !current.stage || current.retryAction === "none")
                    return undefined;
                const jobType = current.stage === "summary" ? (memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary") : "embedding";
                const job = d.enqueueJob({ jobType, userId: memory.userId, sessionId: memory.sessionId, targetMemoryId: memory.id,
                    payload: { source: "memory.processing.lifecycle_retry", previousErrorCode: current.errorCode ?? undefined, contentHash: memory.contentHash },
                    maxAttempts: current.stage === "summary" ? 3 : 6, createdAt: at });
                const processing = d.processing.save({ ...current, state: current.stage === "summary" ? "summary_pending" : "embedding_pending", activeJobId: job.id,
                    attemptCount: 0, retryAction: "retry", updatedAt: at });
                return { job, processing };
            });
            if (result)
                restarted += 1;
        }
        return restarted;
    }
    enqueuePendingImportSummaries(limit = 10_000, targetMemoryIds) {
        const d = this.deps;
        const targets = targetMemoryIds ? dedupeStrings(targetMemoryIds) : undefined;
        const memories = d.memories.listPendingAgentSourceImportSummaries(limit, targets);
        d.transaction(() => {
            for (const memory of memories) {
                const job = d.enqueueJob({ jobType: "import_summary", userId: memory.userId, sessionId: memory.sessionId, targetMemoryId: memory.id,
                    payload: { source: "agent_source.scan.summary_stage", contentHash: memory.contentHash }, maxAttempts: 3, createdAt: memory.createdAt });
                d.processing.update(memory.id, { activeJobId: job.id, updatedAt: d.nowIso() }, ["summary_pending"]);
            }
        });
        return { enqueued: memories.length, memoryIds: targets ?? d.memories.listUnprocessedAgentSourceImports(limit).map((memory) => memory.id), serverTime: d.nowIso() };
    }
}
export function memoryHasImportPipeline(memory) {
    const algorithm = stringFromRecord(memory.properties.internal_info, "plugin_algorithm");
    return algorithm?.startsWith("memory.add.import_async.") === true || memory.tags.some((tag) => tag.trim().toLowerCase() === "agent-source");
}
export function memoryNeedsImportSummary(memory) {
    if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory))
        return false;
    const summary = firstSummary(stringFromRecord(memory.info, "summary") ?? stringFromRecord(memory.properties.internal_info, "summary") ?? traceMetaFromMemory(memory)?.summary);
    return isImportSummaryPlaceholder(summary);
}
export function isImportSummaryPlaceholder(value) {
    const first = value?.split(/\r?\n/).map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim()).find(Boolean);
    return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中)$/i.test(first));
}
export function firstSummary(...values) {
    return values.map((value) => value?.trim()).find((value) => Boolean(value));
}
export function firstRealSummary(...values) {
    return values.map((value) => value?.trim()).find((value) => Boolean(value && !isImportSummaryPlaceholder(value)));
}
export function importStatusTags(tags, _status) {
    return uniq(tags.filter((tag) => !IMPORT_STATUS_TAGS.includes(tag)));
}
export function updateTraceImportSummary(memory, input) {
    const internalTrace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : {};
    const trace = traceMetaFromMemory(memory);
    if (!trace)
        return memory;
    const nextTrace = { ...internalTrace, summary: input.summary, reflection: null, alpha: input.alpha, usable: false, reflection_source: "none", value: input.value, priority: input.priority, import_summary_at: input.updatedAt };
    return {
        ...memory,
        memoryValue: renderTraceMemoryValue({ summary: input.summary, rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"), stepIndex: numberFromRecord(internalTrace, "step_index"), userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflection: { text: null, alpha: input.alpha }, value: input.value, priority: input.priority }),
        tags: input.tags,
        info: { ...memory.info, summary: input.summary, value: input.value, priority: input.priority, tags: input.tags },
        properties: { ...memory.properties, tags: input.tags, info: { ...(memory.properties.info ?? {}), summary: input.summary, value: input.value, priority: input.priority, tags: input.tags }, internal_info: { ...memory.properties.internal_info, summary: input.summary, alpha: input.alpha, value: input.value, priority: input.priority, trace: nextTrace } },
        updatedAt: input.updatedAt
    };
}
export function updateImportPipelineStatus(memory, _status, at) {
    if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory))
        return memory;
    const tags = importStatusTags(memory.tags, _status);
    return { ...memory, tags, info: { ...memory.info, tags }, properties: { ...memory.properties, tags, info: { ...(memory.properties.info ?? {}), tags } }, updatedAt: at };
}
function kindForLayer(layer) {
    if (layer === "L2")
        return "timeline";
    if (layer === "L3")
        return "project_profile";
    if (layer === "L4")
        return "user_profile";
    if (layer === "Skill")
        return "skill";
    return "trace";
}
function dedupeStrings(values) { return [...new Set(values)]; }
function uniq(values) { return [...new Set(values)]; }
function stringFromRecord(record, key) { const value = record[key]; return typeof value === "string" ? value : undefined; }
function stringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }
function numberFromRecord(record, key) { const value = record[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function renderTraceMemoryValue(input) {
    return [
        `Summary: ${input.summary}`,
        input.rawTurnId ? `RawTurn: ${input.rawTurnId}` : undefined,
        typeof input.stepIndex === "number" ? `TraceStep: ${input.stepIndex}` : undefined,
        input.userText ? `User:\n${input.userText}` : undefined,
        input.toolCalls.length ? ["Tool calls:", ...input.toolCalls.map((call) => `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`)].join("\n") : undefined,
        input.agentText ? `Agent:\n${input.agentText}` : undefined,
        input.reflection.text ? `Reflection: ${clip(input.reflection.text, 800)}` : undefined,
        `Alpha: ${input.reflection.alpha}`, `Value: ${input.value}`, `Priority: ${input.priority}`
    ].filter(Boolean).join("\n");
}
