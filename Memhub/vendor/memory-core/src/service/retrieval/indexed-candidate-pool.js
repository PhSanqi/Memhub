import { isMemoryReadyForRetrieval } from "../../algorithm/plugin-algorithms.js";
import { Repositories } from "../../storage/repositories.js";
export function dedupeStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
export class IndexedCandidatePool {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    retrievalCandidateCount(input) {
        const baseFilter = {
            userId: input.userId,
            ...projectRecallFilter(input.projectId),
            memoryLayer: input.layers,
            status: ["activated", "resolving"]
        };
        return this.deps.repos.memories.count(input.tags?.length ? { ...baseFilter, tags: input.tags } : baseFilter);
    }
    hasRetrievalVectorCandidates(input) {
        if (input.layers.length === 0)
            return false;
        const baseFilter = {
            userId: input.userId,
            ...projectRecallFilter(input.projectId),
            memoryLayer: input.layers,
            status: ["activated", "resolving"]
        };
        return this.deps.repos.memories.hasVectorRows(input.tags?.length ? { ...baseFilter, tags: input.tags } : baseFilter);
    }
    async indexedRetrievalCandidatePool(input) {
        const routeTasks = [];
        const queryVector = input.queryVector && input.queryVector.length > 0 ? input.queryVector : undefined;
        const layers = input.layers;
        const addRoute = (run) => {
            routeTasks.push(Promise.resolve().then(run));
        };
        for (const layer of layers) {
            const filter = {
                userId: input.userId,
                ...projectRecallFilter(input.projectId),
                memoryLayer: layer,
                status: ["activated", "resolving"],
                ...(input.tags?.length ? { tags: input.tags } : {})
            };
            const vectorPool = this.retrievalVectorPoolSize(layer, input.config);
            const keywordPool = this.retrievalKeywordPoolSize(layer, input.config);
            if (queryVector) {
                if (layer === "L1") {
                    addRoute(() => this.searchTraceVectorRoutes(queryVector, filter, vectorPool, input.compiledQuery, input.config));
                }
                else {
                    addRoute(() => this.deps.repos.memories.searchVectorIds(queryVector, "vec", filter, vectorPool));
                }
            }
            if (input.compiledQuery.ftsMatch) {
                addRoute(() => this.deps.repos.memories.searchFtsIds(input.compiledQuery.ftsMatch, filter, keywordPool));
            }
            if (input.compiledQuery.patternTerms.length > 0) {
                addRoute(() => this.deps.repos.memories.searchPatternIds(input.compiledQuery.patternTerms, filter, keywordPool));
            }
            if (layer === "L1" && input.compiledQuery.structuralFragments.length > 0) {
                addRoute(() => this.deps.repos.memories.searchStructuralIds(input.compiledQuery.structuralFragments, filter, Math.max(input.config.tier2TopK, 10)));
            }
        }
        if (input.targetSkillId && layers.includes("Skill")) {
            routeTasks.push(Promise.resolve([{ id: input.targetSkillId, score: 1, channel: "vec" }]));
        }
        if (routeTasks.length === 0) {
            return { memories: [], channelScoresByMemory: new Map() };
        }
        const routeHits = await Promise.all(routeTasks);
        const flattenedHits = routeHits.flat();
        const candidateIds = dedupeStrings(flattenedHits.map((hit) => hit.id));
        const channelScoresByMemory = new Map();
        for (const hit of flattenedHits) {
            if (!hit.channel)
                continue;
            const scores = channelScoresByMemory.get(hit.id) ?? {};
            scores[hit.channel] = Math.max(scores[hit.channel] ?? -Infinity, hit.score);
            channelScoresByMemory.set(hit.id, scores);
        }
        return {
            memories: this.deps.repos.memories.getMany(candidateIds).filter((memory) => this.isMemoryReadyForRetrieval(memory) &&
                this.isSkillVisibleToAgent(memory, input.currentAgentId)),
            channelScoresByMemory
        };
    }
    isSkillVisibleToAgent(memory, currentAgentId) {
        if (memory.memoryLayer !== "Skill")
            return true;
        const internal = memory.properties.internal_info;
        if (internal.read_only !== true)
            return true;
        const sourceAgentId = typeof internal.source_agent_id === "string"
            ? internal.source_agent_id.trim()
            : "";
        if (!sourceAgentId)
            return false;
        return !currentAgentId || normalizeAgentId(sourceAgentId) !== normalizeAgentId(currentAgentId);
    }
    searchTraceVectorRoutes(queryVector, filter, vectorPool, compiledQuery, config) {
        const tags = config.tagFilter === "off" ? [] : compiledQuery.tags;
        const search = (anyOfTags) => {
            const summary = this.deps.repos.memories.searchVectorIds(queryVector, "vec_summary", filter, vectorPool, {
                anyOfTags
            });
            const action = this.deps.repos.memories.searchVectorIds(queryVector, "vec_action", filter, vectorPool, {
                anyOfTags
            });
            return [...summary, ...action];
        };
        if (tags.length === 0)
            return search();
        const tagged = search(tags);
        if (tagged.length > 0 || config.tagFilter === "on")
            return tagged;
        return this.deps.repos.memories.searchVectorIds(queryVector, "vec_summary", filter, vectorPool);
    }
    isMemoryReadyForRetrieval(memory) {
        const processing = this.deps.repos.processing.get(memory.id);
        if (!processing || !this.deps.memoryHasImportPipeline(memory))
            return isMemoryReadyForRetrieval(memory);
        if (processing.state === "ready" || processing.state === "ready_text_only")
            return true;
        if (processing.state === "embedding_pending" ||
            processing.state === "embedding" ||
            (processing.state === "failed" && processing.stage === "embedding")) {
            return isMemoryReadyForRetrieval(memory);
        }
        return false;
    }
    retrievalVectorPoolSize(layer, config) {
        const topK = layer === "Skill"
            ? config.tier1TopK
            : layer === "L3"
                ? config.tier3TopK
                : config.tier2TopK;
        return Math.max(1, Math.ceil(topK * config.candidatePoolFactor));
    }
    retrievalKeywordPoolSize(layer, config) {
        const topK = layer === "Skill"
            ? config.tier1TopK
            : layer === "L3"
                ? config.tier3TopK
                : config.tier2TopK;
        return Math.max(topK, config.keywordTopK);
    }
    listAllMemories(filter) {
        const total = this.deps.repos.memories.count(filter);
        return total <= 0 ? [] : this.deps.repos.memories.list(filter, total);
    }
}
function projectRecallFilter(projectId) {
    const normalized = projectId?.trim();
    return {
        projectIds: normalized ? [normalized] : [],
        includeUnscopedProject: true
    };
}
function normalizeAgentId(value) {
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
