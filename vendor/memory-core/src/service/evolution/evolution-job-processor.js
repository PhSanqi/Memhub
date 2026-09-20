import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { BigTurnSpanPipeline } from "./big-turn-span-pipeline.js";
import { RewardPipeline } from "./reward-pipeline.js";
import { SpanPipeline } from "./span-pipeline.js";

/**
 * Internal quality processor for source turns and Episodes.
 *
 * Product-layer evolution (L2/L3/L4 and Skills) is owned by Memhub's
 * distillation pipeline. Memory Core only keeps source-quality operations:
 * trace reflection/summarization, reward propagation, and big-turn splitting.
 */
export class EvolutionJobProcessor {
    deps;
    reward;
    span;
    bigTurnSpan;
    constructor(deps) {
        this.deps = deps;
        const owner = this;
        this.span = new SpanPipeline({
            repos: deps.repos,
            get config() { return owner.deps.config; },
            get llm() { return owner.deps.llm; },
            get skillLlm() { return owner.deps.skillLlm; },
            traceMeta: deps.traceMeta,
            namespaceIdFromMemory: deps.namespaceIdFromMemory,
            enqueueJob: deps.enqueueJob,
            enqueueEpisodeRewardAfterReflection: deps.enqueueEpisodeRewardAfterReflection,
            scheduleEmbeddingAfterTextUpdate: deps.scheduleEmbeddingAfterTextUpdate
        });
        this.bigTurnSpan = new BigTurnSpanPipeline({
            repos: deps.repos,
            get llm() { return owner.deps.llm; },
            buildMemory: deps.buildMemory,
            enqueueJob: deps.enqueueJob,
            namespaceIdFromMemory: deps.namespaceIdFromMemory,
            embedAfterCapture: () => owner.deps.config.algorithm.capture.embedAfterCapture
        });
        this.reward = new RewardPipeline({
            get config() { return owner.deps.config; },
            repos: deps.repos,
            get llm() { return owner.deps.llm; },
            nowIso,
            newId,
            traceMeta: deps.traceMeta,
            namespaceIdFromMemory: deps.namespaceIdFromMemory,
            enqueueJob: deps.enqueueJob,
            finalizeClosedEpisode: deps.finalizeClosedEpisode,
            resolvePendingSkillTrialsForReward: deps.resolvePendingSkillTrialsForReward,
            decisionRepairTraceSources: deps.decisionRepairTraceSources,
            synthesizeDecisionRepairDraft: deps.synthesizeDecisionRepairDraft,
            repairEvidenceValueDiff: deps.repairEvidenceValueDiff
        });
    }
    reflectTrace(job) {
        return this.span.reflectTrace(job);
    }
    applyReward(job) {
        return this.reward.applyReward(job);
    }
    splitBigTurn(job) {
        return this.bigTurnSpan.splitAndStore(job);
    }
    summarizeTraceForCapture(input, options = {}) {
        return this.span.summarizeTraceForCapture(input, options);
    }
    decideTurnMemoryForCapture(input) {
        return this.span.decideTurnMemoryForCapture(input);
    }
}
