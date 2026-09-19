import { isRecord } from "../../utils/json.js";
import { IMPORT_FAILED_TAG, IMPORT_INDEXING_TAG, IMPORT_STATUS_TAGS, IMPORT_SUMMARY_PROCESSING_TAG } from "../import/memory-import-pipeline.js";
import { panelDateKey, panelRoundDecimal } from "./model-costs.js";
export function panelListItemFromMemory(item, memory, processing) {
    const spanGoal = panelSpanGoalForMemory(memory);
    return {
        ...item,
        processing,
        metadata: {
            ...(item.metadata ?? {}),
            source: panelSourceForMemory(memory),
            ...(spanGoal ? { spanGoal } : {})
        },
        tags: panelTagsForMemory(memory, processing)
    };
}
function panelSpanGoalForMemory(memory) {
    if (memory.properties.internal_info.memory_kind !== "span")
        return undefined;
    const span = isRecord(memory.properties.internal_info.span) ? memory.properties.internal_info.span : {};
    const goal = span.span_goal;
    return typeof goal === "string" && goal.trim() ? goal.trim() : undefined;
}
export function panelSourceDistribution(memories) {
    const counts = new Map();
    for (const memory of memories) {
        const source = panelSourceForStatsRow(memory);
        counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([source, count]) => ({
        source,
        count,
        percentage: memories.length > 0 ? panelRoundDecimal((count / memories.length) * 100, 1) : 0
    }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}
export function panelCountByDate(rows, dates, getTime, timeZone) {
    const counts = new Map(dates.map((date) => [date, 0]));
    for (const row of rows) {
        const key = panelDateKey(getTime(row), timeZone);
        if (counts.has(key))
            counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}
export function panelTagsForMemory(memory, processing) {
    const tags = memory.tags.filter((tag) => !IMPORT_STATUS_TAGS.includes(tag));
    if (memory.status === "archived" || memory.status === "deleted" || !processing)
        return tags;
    const label = processing.state === "summary_pending" || processing.state === "summarizing"
        ? IMPORT_SUMMARY_PROCESSING_TAG
        : processing.state === "embedding_pending" || processing.state === "embedding"
            ? IMPORT_INDEXING_TAG
            : processing.state === "failed"
                ? IMPORT_FAILED_TAG
                : undefined;
    return label ? uniq([...tags, label]) : tags;
}
export function panelSourceForMemory(memory) {
    const internalInfo = isRecord(memory.properties.internal_info)
        ? memory.properties.internal_info
        : {};
    return panelSourceForStatsRow({
        conversationId: memory.conversationId,
        sessionId: memory.sessionId,
        agentId: memory.agentId,
        appId: memory.appId,
        status: memory.status,
        memoryLayer: memory.memoryLayer,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        infoSource: memory.info.source,
        internalSource: internalInfo.source
    });
}
function panelSourceForStatsRow(memory) {
    const explicitSources = [memory.infoSource, memory.internalSource];
    const explicitSource = firstString(...explicitSources.map(panelNormalizeExplicitSource));
    if (explicitSource)
        return explicitSource;
    const hostSource = firstString(panelNormalizeKnownSource(memory.sessionId), panelNormalizeKnownSource(memory.conversationId), panelNormalizeSourceAgent(memory.agentId), panelNormalizeSourceAgent(memory.appId));
    if (hostSource)
        return hostSource;
    return explicitSources.some(panelIsInternalSourceValue) ? "memmy" : "unknown";
}
function panelNormalizeExplicitSource(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (panelIsInternalSource(normalized))
        return undefined;
    return panelNormalizeKnownSource(normalized) ?? normalized;
}
function panelNormalizeKnownSource(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "claude" || normalized.startsWith("claude-"))
        return "claude-code";
    if (normalized === "open-code" || normalized.startsWith("open-code-"))
        return "opencode";
    for (const source of ["hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "manual", "memmy"]) {
        if (normalized === source || normalized.startsWith(`${source}-`))
            return source;
    }
    return undefined;
}
function panelNormalizeSourceAgent(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const normalized = value.trim().toLowerCase();
    return panelNormalizeKnownSource(normalized) ?? normalized;
}
function panelIsInternalSourceValue(value) {
    return typeof value === "string" && panelIsInternalSource(value.trim().toLowerCase());
}
function panelIsInternalSource(value) {
    return /^(?:turn|worker|panel|system|feedback|memory|session|episode|recall|skill_trial|l2_candidate)(?:[.:_-]|$)/.test(value);
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function uniq(values) {
    return [...new Set(values)];
}
