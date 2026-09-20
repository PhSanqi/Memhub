import { isRecord } from "../../utils/json.js";
import { detailSummaryForMemory } from "./memory.js";
import { nowIso, resolveTimeZone } from "../../utils/time.js";
import { panelAverage, panelDateKey, panelDateKeys, panelLastSevenDateKeys, panelPercentile95, panelRecallScore, panelRoundDecimal, panelRoundInt, panelToolLatency } from "./model-costs.js";
import { panelCountByDate, panelListItemFromMemory, panelSourceDistribution } from "./panel.js";
const PANEL_ITEMS_PAGE_SIZE = 20;
const PANEL_DAILY_ACTIVITY_DAYS = 371;
export class PanelReadModel {
    deps;
    now;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? nowIso;
    }
    auditLogs(input = {}) {
        return {
            items: this.deps.repos.runtime.listAudit({
                userId: input.userId ?? this.deps.resolveContext(input).userId,
                targetKind: input.targetKind,
                targetId: input.targetId,
                limit: input.limit
            }),
            serverTime: this.now()
        };
    }
    serviceLogs(input = {}) {
        const limit = input.limit ?? 50;
        const changes = this.panelChanges({
            namespace: input.namespace,
            limit,
            cursor: input.cursor
        });
        const audits = this.deps.repos.runtime.listAudit({ limit });
        const jobs = [
            ...this.deps.repos.runtime.listJobs("failed", limit),
            ...this.deps.repos.runtime.listJobs("dead_letter", limit)
        ].slice(0, limit);
        const entries = [
            ...changes.items.map((change) => ({
                type: "change",
                id: String(change.seq),
                at: change.createdAt,
                userId: change.userId,
                action: `${change.kind}.${change.op}`,
                targetKind: change.kind,
                targetId: change.entityId,
                source: change.source,
                payload: changeLogToPanelChange(change)
            })),
            ...audits.map((audit) => ({
                type: "audit",
                id: audit.id,
                at: audit.createdAt,
                userId: audit.userId,
                action: audit.action,
                targetKind: audit.targetKind,
                targetId: audit.targetId,
                source: "audit",
                payload: audit
            })),
            ...jobs.map((job) => ({
                type: "job",
                id: job.id,
                at: job.updatedAt,
                userId: job.userId,
                action: `job.${job.status}`,
                targetKind: job.jobType,
                targetId: job.targetMemoryId,
                source: "worker",
                payload: job
            }))
        ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
        return {
            cursor: changes.cursor,
            entries,
            changes: changes.changes,
            audits,
            jobs,
            serverTime: this.now()
        };
    }
    apiLogs(input = {}) {
        const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
        const offset = Math.max(0, input.offset ?? 0);
        const result = this.deps.repos.runtime.listApiLogs({
            toolNames: input.tools,
            sourceAgent: input.sourceAgent,
            excludedSourceAgents: input.excludedSourceAgents,
            limit,
            offset
        });
        return {
            logs: result.logs.map((log) => this.withCurrentTraceSummaries(log)),
            total: result.total,
            limit,
            offset,
            nextOffset: offset + result.logs.length < result.total ? offset + result.logs.length : undefined,
            serverTime: this.now()
        };
    }
    withCurrentTraceSummaries(log) {
        if (log.toolName !== "memory_add")
            return log;
        try {
            const output = JSON.parse(log.outputJson);
            if (!isRecord(output) || !Array.isArray(output.details))
                return log;
            let changed = false;
            const details = output.details.map((detail) => {
                if (!isRecord(detail) || (detail.role !== "trace" && detail.role !== "span"))
                    return detail;
                const memoryId = typeof (detail.role === "span" ? detail.spanId : detail.traceId) === "string"
                    ? detail.role === "span" ? detail.spanId : detail.traceId
                    : detail.traceId;
                if (typeof memoryId !== "string")
                    return detail;
                const memory = this.deps.repos.memories.get(memoryId);
                const spanGoal = memory && detail.role === "span"
                    ? this.spanGoalForMemory(memory)
                    : undefined;
                const summary = memory && detail.role === "trace" ? detailSummaryForMemory(memory) : undefined;
                const key = detail.role === "span" ? "spanGoal" : "summary";
                const value = spanGoal ?? summary;
                if (!value || detail[key] === value)
                    return detail;
                changed = true;
                return { ...detail, [key]: value };
            });
            return changed ? { ...log, outputJson: JSON.stringify({ ...output, details }) } : log;
        }
        catch {
            return log;
        }
    }
    spanGoalForMemory(memory) {
        const span = isRecord(memory.properties.internal_info.span) ? memory.properties.internal_info.span : undefined;
        const goal = span?.span_goal;
        return typeof goal === "string" && goal.trim() ? goal.trim() : undefined;
    }
    serviceMetrics(input = {}) {
        const overview = this.panelOverview(input);
        return {
            storage: this.deps.storageCapabilities(),
            schema: this.deps.schemaVersion(),
            memory: overview.stats,
            changeSeq: overview.latestChangeSeq,
            feedback: { recent: this.deps.repos.runtime.listFeedback({ limit: 1000 }).length },
            jobs: overview.stats.jobs,
            embeddingRetries: overview.stats.embeddingRetries,
            models: this.deps.models(),
            serverTime: this.now()
        };
    }
    adminStatus(input = {}, routes = []) {
        return {
            health: this.deps.health(routes),
            overview: this.panelOverview(input),
            failedJobs: this.deps.repos.runtime.listJobs("failed", 20),
            deadLetterJobs: this.deps.repos.runtime.listJobs("dead_letter", 20),
            serverTime: this.now()
        };
    }
    configStatus(_input = {}) {
        const config = this.deps.config();
        return {
            version: config.version,
            config: redactConfig(config),
            redacted: true,
            serverTime: this.now()
        };
    }
    panelOverview(input = {}) {
        const userId = input.userId ?? input.namespace?.userId;
        const byLayer = this.memoryLayerCounts(userId);
        const byStatus = this.memoryStatusCounts(userId);
        const latestChangeSeq = this.deps.repos.runtime.latestChangeSeq();
        const jobs = this.jobStatusCounts();
        const embeddingRetries = this.embeddingRetryStatusCounts();
        return {
            stats: {
                byLayer,
                byStatus,
                episodes: this.episodeStatusCounts(userId),
                jobs,
                embeddingRetries,
                lastChangeSeq: latestChangeSeq || undefined
            },
            counts: byLayer,
            queuedJobs: jobs.queued,
            latestChangeSeq,
            cursor: this.deps.encodeChangeCursor(latestChangeSeq),
            etag: `panel-overview-v${latestChangeSeq}`,
            serverTime: this.now()
        };
    }
    panelOverviewSummary(input = {}) {
        const userId = input.userId ?? input.namespace?.userId;
        const memories = this.deps.repos.memories.listStats(userId);
        const timeZone = resolveTimeZone(input.timeZone);
        const dates = panelDateKeys(this.now(), PANEL_DAILY_ACTIVITY_DAYS, timeZone);
        return {
            counts: {
                memories: memories.filter((memory) => memory.memoryLayer === "L1").length,
                skills: memories.filter((memory) => memory.memoryLayer === "Skill").length,
                timelines: memories.filter((memory) => memory.memoryLayer === "L2").length,
                projectProfiles: memories.filter((memory) => memory.memoryLayer === "L3").length,
                userProfiles: memories.filter((memory) => memory.memoryLayer === "L4").length
            },
            dailyActivity: panelCountByDate(memories, dates, (memory) => memory.createdAt, timeZone),
            sourceDistribution: panelSourceDistribution(memories)
        };
    }
    panelAnalysis(input = {}) {
        const timeZone = resolveTimeZone(input.timeZone);
        const dates = panelLastSevenDateKeys(this.now(), timeZone);
        const memories = this.deps.repos.memories.listStats();
        const skillMemories = memories.filter((memory) => memory.memoryLayer === "Skill");
        const logs = this.deps.repos.runtime.listApiLogs({ limit: 10_000, offset: 0 }).logs
            .filter((log) => dates.includes(panelDateKey(log.calledAt, timeZone)));
        const recallScores = logs
            .filter((log) => log.toolName === "memory_search")
            .map((log) => panelRecallScore(log.outputJson))
            .filter((score) => score !== undefined);
        const durations = logs.map((log) => Math.max(0, Math.round(log.durationMs)));
        return {
            metrics: {
                avgRecallScore: panelRoundDecimal(panelAverage(recallScores), 2),
                recallEvents: logs.filter((log) => log.toolName === "memory_search").length,
                activeSkills: skillMemories.filter((memory) => memory.status === "activated").length,
                recentlyUsedSkills: skillMemories.filter((memory) => dates.includes(panelDateKey(memory.updatedAt, timeZone))).length,
                avgToolLatencyMs: panelRoundInt(panelAverage(durations)),
                p95ToolLatencyMs: panelPercentile95(durations)
            },
            dailyMemoryWrites: panelCountByDate(memories, dates, (memory) => memory.createdAt, timeZone),
            dailySkillEvolutions: panelCountByDate(skillMemories, dates, (memory) => memory.updatedAt, timeZone),
            toolLatency: panelToolLatency(logs, dates, timeZone)
        };
    }
    panelItems(input) {
        const pageSize = normalizePanelItemsLimit(input.limit);
        const filter = {
            userId: input.userId ?? input.namespace?.userId,
            memoryLayer: input.layer,
            status: input.status,
            tags: input.tags,
            agentId: input.sourceAgent,
            excludedAgentIds: input.excludedSourceAgents
        };
        const total = input.q?.trim()
            ? this.deps.repos.memories.searchCount(input.q, { ...filter, status: filter.status ?? ["activated", "resolving"] })
            : this.deps.repos.memories.count(filter);
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const requestedPage = normalizePageNumber(input.page);
        const page = Math.min(requestedPage, totalPages);
        const offset = normalizeOffsetCursor(input.cursor) ?? ((page - 1) * pageSize);
        const memories = input.q?.trim()
            ? this.deps.repos.memories.getMany(this.deps.repos.memories.searchPanelIds(input.q, { ...filter, status: filter.status ?? ["activated", "resolving"] }, pageSize, offset).map((hit) => hit.id))
            : this.deps.repos.memories.list(filter, pageSize, offset);
        return {
            items: memories.map((memory) => panelListItemFromMemory(this.deps.repos.memories.toListItem(memory), memory, this.deps.repos.processing.get(memory.id))),
            page,
            pageSize,
            total,
            totalPages,
            hasNext: offset + memories.length < total,
            hasPrev: offset > 0,
            etag: `panel-items-v${this.deps.repos.runtime.latestChangeSeq()}`,
            nextCursor: offset + memories.length < total ? String(offset + memories.length) : undefined,
            serverTime: this.now()
        };
    }
    panelTasks(input) {
        const pageSize = 20;
        const query = input.q?.trim() || undefined;
        const userId = input.userId ?? input.namespace?.userId;
        const total = this.deps.repos.runtime.countEpisodes(userId, query, input.sourceAgent);
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(normalizePageNumber(input.page), totalPages);
        const episodes = this.deps.repos.runtime.listEpisodes(userId, pageSize, (page - 1) * pageSize, query, input.sourceAgent);
        return {
            tasks: episodes.map((episode) => ({
                id: episode.id,
                episode: this.deps.episodeRef(episode),
                memoryIds: episode.l1MemoryIds.filter((memoryId) => Boolean(this.deps.repos.memories.get(memoryId))),
                turns: this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, 1000).map(this.deps.rawTurnSummary),
                updatedAt: episode.updatedAt
            })),
            page,
            pageSize,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
            serverTime: this.now()
        };
    }
    panelRawTurns(input = {}) {
        const pageSize = normalizePanelItemsLimit(input.limit);
        const projectIds = Array.isArray(input.projectIds)
            ? input.projectIds.filter((value) => typeof value === "string" && value.trim())
            : [];
        const rawTurnStats = this.deps.repos.runtime.rawTurnStats({
            userId: input.userId,
            ...(projectIds.length ? { projectIds } : {}),
            ...(input.sessionSource ? { sessionSource: input.sessionSource } : {})
        });
        const total = rawTurnStats.total;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(normalizePageNumber(input.page), totalPages);
        const offset = (page - 1) * pageSize;
        const turns = this.deps.repos.runtime.listRawTurns({
            userId: input.userId,
            ...(projectIds.length ? { projectIds } : {}),
            ...(input.sessionSource ? { sessionSource: input.sessionSource } : {})
        }, pageSize, offset);
        return {
            items: turns.map((turn) => ({
                rawTurnId: turn.id,
                sessionId: turn.sessionId,
                episodeId: turn.episodeId,
                turnId: turn.turnId,
                conversationId: turn.conversationId,
                projectId: turn.projectId,
                sessionSource: turn.sessionSource,
                userText: turn.redactedAt || turn.deletedAt ? undefined : turn.userText,
                assistantText: turn.redactedAt || turn.deletedAt ? undefined : turn.assistantText,
                reasoningSummary: turn.redactedAt || turn.deletedAt ? undefined : turn.reasoningSummary,
                status: turn.status,
                createdAt: turn.createdAt
            })),
            page,
            pageSize,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
            stats: rawTurnStats,
            serverTime: this.now()
        };
    }
    panelChanges(input = {}) {
        const limit = input.limit ?? 50;
        const cursorSeq = this.deps.decodeChangeCursor(input.cursor);
        const items = this.deps.repos.runtime.listChanges(undefined, limit, cursorSeq);
        const lastSeq = items.reduce((max, item) => Math.max(max, item.seq), cursorSeq);
        return {
            cursor: this.deps.encodeChangeCursor(lastSeq),
            changes: items.map(changeLogToPanelChange),
            hasMore: items.length === limit,
            items,
            serverTime: this.now()
        };
    }
    panelJobs(input = {}) {
        const items = this.deps.repos.runtime.listJobs(input.status, input.limit ?? 50);
        return {
            jobs: items.map((job) => ({
                ...job,
                error: job.lastError ? { code: "worker_error", message: job.lastError } : undefined
            })),
            items,
            serverTime: this.now()
        };
    }
    jobStatusCounts() {
        return this.deps.repos.runtime.countJobsByStatus();
    }
    memoryLayerCounts(userId) {
        return this.deps.repos.memories.countByLayer(userId);
    }
    memoryStatusCounts(userId) {
        return this.deps.repos.memories.countByStatus(userId);
    }
    episodeStatusCounts(userId) {
        return this.deps.repos.runtime.countEpisodesByStatus(userId);
    }
    embeddingRetryStatusCounts() {
        const statuses = ["pending", "in_progress", "succeeded", "failed"];
        const counts = { pending: 0, in_progress: 0, succeeded: 0, failed: 0 };
        for (const status of statuses) {
            counts[status] = this.deps.repos.runtime.countEmbeddingRetriesByStatus(status);
        }
        return counts;
    }
}
function emptyPanelItems(page, pageSize, serverTime) {
    return {
        items: [],
        page,
        pageSize,
        total: 0,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        etag: "panel-items-empty",
        serverTime
    };
}
function normalizePageNumber(value) {
    if (!Number.isFinite(value))
        return 1;
    return Math.max(1, Math.floor(value));
}
function normalizePanelItemsLimit(value) {
    if (!Number.isFinite(value))
        return PANEL_ITEMS_PAGE_SIZE;
    return clampNumber(Math.floor(value), 1, 100);
}
function normalizeOffsetCursor(value) {
    if (value === undefined)
        return undefined;
    const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}
function normalizeChangeOp(value) {
    return value === "created" || value === "updated" || value === "archived" || value === "deleted" ? value : undefined;
}
function normalizeChangeKind(value) {
    return value === "trace" || value === "span" || value === "policy" || value === "world_model" || value === "skill" ||
        value === "session" || value === "episode" || value === "job" || value === "feedback" ||
        value === "raw_turn" || value === "repair" || value === "skill_trial" || value === "recall" ||
        value === "artifact"
        ? value
        : undefined;
}
function changeOp(changeType) {
    if (changeType.includes("delete"))
        return "deleted";
    if (changeType.includes("archive"))
        return "archived";
    if (changeType.includes("create") || changeType.includes("insert"))
        return "created";
    return "updated";
}
function changeKind(change) {
    if (change.changeType.includes("artifact") || change.memoryId.startsWith("artifact_"))
        return "artifact";
    if (change.changeType.includes("skill_trial"))
        return "skill_trial";
    if (change.changeType.includes("recall"))
        return "recall";
    if (change.changeType.includes("session"))
        return "session";
    if (change.changeType.includes("episode"))
        return "episode";
    if (change.changeType.includes("job"))
        return "job";
    if (change.changeType.includes("feedback"))
        return "feedback";
    if (change.changeType.includes("repair") || change.memoryId.startsWith("repair_"))
        return "repair";
    if (change.changeType.includes("raw_turn") || change.memoryId.startsWith("raw_"))
        return "raw_turn";
    const after = isRecord(change.after) ? change.after : undefined;
    const layer = after?.memoryLayer ?? after?.memory_layer;
    if (layer === "L1")
        return "trace";
    if (layer === "L2")
        return "policy";
    if (layer === "L3")
        return "world_model";
    if (layer === "Skill")
        return "skill";
    return "trace";
}
function versionFromChange(change) {
    const after = isRecord(change.after) ? change.after : undefined;
    return typeof after?.version === "number" ? after.version : undefined;
}
function changeSource(source) {
    if (source.startsWith("turn."))
        return "turn_complete";
    if (source.startsWith("feedback."))
        return "feedback";
    if (source.startsWith("worker."))
        return "worker";
    if (source.startsWith("panel."))
        return "panel";
    return "system";
}
function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
