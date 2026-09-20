import { attachMemoryVector } from "../../storage/memory-vector-state.js";
import { RETRIEVAL_DOCUMENT_VERSION, retrievalDocumentForMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
const EMBEDDING_RETRY_BASE_BACKOFF_MS = 60_000;
const EMBEDDING_RETRY_MAX_BACKOFF_MS = 60 * 60_000;
export function embeddingTextForMemory(memory) {
    const trace = traceMetaFromMemory(memory);
    if (trace) {
        return [trace.summary, trace.reflection ?? ""]
            .filter(Boolean)
            .join("\n");
    }
    if (memory.memoryLayer === "Skill" && skillMetaFromMemory(memory))
        return retrievalDocumentForMemory(memory);
    return memory.memoryValue;
}
export function traceSummaryEmbeddingText(memory) {
    const span = isRecord(memory.properties.internal_info.span)
        ? memory.properties.internal_info.span
        : undefined;
    const spanGoal = span ? stringFromRecord(span, "span_goal") : undefined;
    const spanSummary = span ? stringFromRecord(span, "summary") : undefined;
    if (spanGoal && spanSummary) {
        return [
            `Goal: ${spanGoal}`,
            `Summary: ${spanSummary}`
        ].join("\n");
    }
    const trace = traceMetaFromMemory(memory);
    const summary = firstRealSummary(trace?.summary, stringFromRecord(memory.info, "summary"), stringFromRecord(memory.properties.internal_info, "summary"));
    if (!summary)
        return undefined;
    const originalExchange = trace
        ? clip([trace.userText, trace.agentText].filter(Boolean).join("\n"), 3_000)
        : "";
    return [
        `Summary: ${summary}`,
        ...(originalExchange ? [`Original exchange:\n${originalExchange}`] : [])
    ].join("\n\n");
}
export function embeddingRetryTargetKindForMemory(memory) {
    if (memory.memoryLayer === "L1")
        return "trace";
    if (memory.memoryLayer === "L2")
        return "timeline";
    if (memory.memoryLayer === "L3")
        return "project_profile";
    if (memory.memoryLayer === "L4")
        return "user_profile";
    return "skill";
}
export function embeddingRetryVectorFieldForMemory(memory) {
    return memory.memoryLayer === "L1" ? "vec_summary" : "vec";
}
export function embeddingRetryBackoffMs(attemptNo) {
    return Math.min(EMBEDDING_RETRY_MAX_BACKOFF_MS, EMBEDDING_RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attemptNo - 1));
}
export function embeddingRetryToRunItem(retry) {
    return {
        id: retry.id,
        status: retry.status,
        targetKind: retry.targetKind,
        targetMemoryId: retry.targetId,
        vectorField: retry.vectorField,
        attempts: retry.attempts,
        lastError: retry.lastError
    };
}
export function updateMemoryVectorField(memory, vectorField, vector, input) {
    const internal = memory.properties.internal_info;
    const nextInternal = { ...internal };
    if (memory.memoryLayer === "L1" && isRecord(internal.trace)) {
        nextInternal.trace = { ...internal.trace };
    }
    else if (memory.memoryLayer === "Skill" && isRecord(internal.skill)) {
        nextInternal.skill = { ...internal.skill };
    }
    if (memory.memoryLayer !== "L1" && input.sourceHash) {
        nextInternal.retrieval_index = {
            version: RETRIEVAL_DOCUMENT_VERSION,
            source_hash: input.sourceHash,
            indexed_at: input.updatedAt
        };
    }
    const updated = {
        ...memory,
        properties: {
            ...memory.properties,
            internal_info: { ...memory.properties.internal_info, ...nextInternal }
        },
        updatedAt: input.updatedAt
    };
    return attachMemoryVector(updated, {
        vectorField,
        vector,
        embeddingProvider: input.provider,
        embeddingModel: input.model
    });
}
function firstRealSummary(...values) {
    return values
        .map((value) => value?.trim())
        .find((value) => Boolean(value && !isImportSummaryPlaceholder(value)));
}
function isImportSummaryPlaceholder(value) {
    const first = value
        ?.split(/\r?\n/)
        .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
        .find(Boolean);
    return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中)$/i.test(first));
}
function stringFromRecord(record, key) {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}
