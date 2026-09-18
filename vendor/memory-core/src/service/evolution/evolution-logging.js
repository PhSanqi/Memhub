import { createMemoryLogger } from "../../logging/logger.js";
const evolutionLogger = createMemoryLogger("evolution");
export function evolutionJobLogFields(job) {
    return {
        jobId: job.id,
        jobType: job.jobType,
        status: job.status,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        sessionId: job.sessionId,
        episodeId: job.episodeId,
        targetMemoryId: job.targetMemoryId,
        targetField: typeof job.payload.targetField === "string" ? job.payload.targetField : undefined,
        scopeKey: job.scopeKey,
        scopeSeq: job.scopeSeq
    };
}
export function logEvolutionDecision(job, stage, reason, fields = {}) {
    const context = {
        ...evolutionJobLogFields(job),
        stage,
        reason,
        ...fields
    };
    if (/llm-failed|llm-refusal|invalid|verification_failed|malformed|truncat/i.test(reason)) {
        evolutionLogger.warn("generation.skipped", context);
    }
    else {
        evolutionLogger.info("gate.skipped", context);
    }
}
