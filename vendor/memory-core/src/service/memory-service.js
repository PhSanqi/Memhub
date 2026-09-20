import { assertJsonValue, canonicalJson, sha256Hex } from "../contracts/index.js";
import { skillMetaFromMemory, traceMetaFromMemory } from "../algorithm/plugin-algorithms.js";
import { PROJECT_VERSION } from "../cli/project-version.js";
import { MEMORY_CAPABILITIES, MEMORY_PROTOCOL_VERSION, MEMORY_VIEWER_VERSION } from "../version.js";
import { DEFAULT_MEMMY_CONFIG, loadMemmyConfig, resolveEvolutionConfig } from "../config/index.js";
import { createMemoryLogger } from "../logging/logger.js";
import { createEmbedder } from "../model/embedder.js";
import { createLlmClient } from "../model/llm.js";
import { MemoryModelTaskRouter } from "../model/task-routing.js";
import { sqliteBackendCapabilities } from "../storage/backend.js";
import { Repositories, jobToRef, kindFromMemory } from "../storage/repositories.js";
import { MemoryServiceError } from "../utils/error.js";
import { newId, stableHash, stableStringify } from "../utils/id.js";
import { isRecord, stringifyForMemory } from "../utils/json.js";
import { memoryCaptureQaHash, normalizeMemoryCaptureSource } from "../utils/memory-capture-claim.js";
import { clip, firstLine } from "../utils/text.js";
import { nowIso, resolveTimeZone } from "../utils/time.js";
import { EmbeddingJobProcessor } from "./embedding/embedding-job-processor.js";
import { EvolutionJobProcessor } from "./evolution/evolution-job-processor.js";
import { traceReflectionWasScored, traceSortKey } from "./evolution/span-pipeline.js";
import { FeedbackExperienceService, polarityFromTurnFeedback, synthesizeDecisionRepairDraft } from "./feedback/feedback-experience.js";
import { ImportJobProcessor, memoryHasImportPipeline } from "./import/import-job-processor.js";
import { isAgentSourceImportMemoryAdd, memoryAddImportTrace, memoryAddKey, memoryAddQaPair, memoryAddTags, normalizeMemoryAddCreatedAt, titleFromImportTrace, toolCallsFromUnknown } from "./import/memory-import-pipeline.js";
import { recordApiLog } from "./model-audit/model-call-audit.js";
import { namespaceForMemory, namespaceForRawTurn, namespaceForSession, normalizeNamespace } from "./namespace/namespace-scope.js";
import { EpisodeReadModel, episodeRef } from "./read-model/episode.js";
import { detailFromMemory, memoryDetailWithLayerPayload, memoryEtag, procedureFromSkillMemory } from "./read-model/memory.js";
import { PanelReadModel } from "./read-model/panel-read.js";
import { SkillReadModel } from "./read-model/skill.js";
import { RetrievalService, memoryLayersForIntent, memoryMatchesTags, readableMemoryIdKind, retrievedMemorySourceIds } from "./retrieval/retrieval-service.js";
import { SessionTurnService, rawTurnSummary as sessionRawTurnSummary, repairEvidenceValueDiff as sessionRepairEvidenceValueDiff } from "./session/session-turn-service.js";
import { SkillTrialResolver } from "./trials/skill-trial-resolver.js";
import { buildSearchQuery, sanitizeMemoryAddRequest, turnStartContextHints } from "./turn/turn-normalization.js";
import { createWorkerJobHandlers } from "./worker/job-handlers.js";
import { WorkerRunner } from "./worker/worker-runner.js";
const serviceLogger = createMemoryLogger("memory-service");
function createConfiguredMemoryLlm(config, modelRole) {
    return createLlmClient(modelRole === "memory_summary" ? config.summary : resolveEvolutionConfig(config), { modelRole });
}
function requireMemoryDb(options) {
    if (!options.db) {
        throw new Error("MemoryService requires either db or backend");
    }
    return options.db;
}
export class MemoryService {
    options;
    embeddingJobs;
    evolutionJobs;
    feedbackExperience;
    skillTrials;
    episodeReadModel;
    importJobs;
    panelReadModel;
    retrieval;
    sessionTurns;
    skillReadModel;
    workerHandlers;
    workerRunner;
    repos;
    startedAt = Date.now();
    mode;
    config;
    modelTasks;
    llm;
    skillLlm;
    embedder;
    embeddingRetryWorkerId = `embedding-retry-${newId("worker")}`;
    constructor(options) {
        this.options = options;
        this.repos = options.backend?.repositories() ?? new Repositories(requireMemoryDb(options).db);
        this.mode = options.mode ?? "local";
        this.config = cloneMemmyConfig(options.config ?? DEFAULT_MEMMY_CONFIG);
        this.modelTasks = new MemoryModelTaskRouter(() => this.resolveModelTaskContext());
        this.llm = this.modelTasks.client("summary");
        this.skillLlm = this.modelTasks.client("evolution");
        this.embedder = this.modelTasks.embedder();
        const workerHandlerOwner = this;
        this.workerHandlers = createWorkerJobHandlers({
            repos: this.repos,
            get capture() { return workerHandlerOwner.config.algorithm.capture; },
            get reward() { return workerHandlerOwner.config.algorithm.reward; },
            nowIso,
            requireSession: this.requireSession.bind(this),
            feedbackTargetFromEpisode: (episode) => this.feedbackExperience.feedbackTargetFromEpisode(episode),
            traceReflectionWasScored,
            traceSortKey,
            processors: {
                import: {
                    summarizeCapturedTrace: this.summarizeCapturedTrace.bind(this),
                    summarizeImportedTrace: this.summarizeImportedTrace.bind(this)
                },
                evolution: {
                    splitBigTurn: (job) => this.evolutionJobs.splitBigTurn(job)
                },
                feedback: {
                    applyReward: (job) => this.evolutionJobs.applyReward(job),
                    reflectTrace: (job) => this.evolutionJobs.reflectTrace(job),
                    resolveSkillTrial: (job) => this.skillTrials.resolveSkillTrial(job)
                },
                embedding: {
                    embedMemory: this.embedMemory.bind(this)
                }
            }
        });
        const evolutionOwner = this;
        this.evolutionJobs = new EvolutionJobProcessor({
            repos: this.repos,
            get config() { return evolutionOwner.config; },
            get llm() { return evolutionOwner.llm; },
            get skillLlm() { return evolutionOwner.skillLlm; },
            traceMeta: this.traceMeta.bind(this),
            namespaceIdFromMemory,
            buildMemory: (input) => this.buildMemory(input),
            enqueueJob: this.workerHandlers.enqueueJob,
            enqueueEpisodeRewardAfterReflection: this.workerHandlers.enqueueEpisodeRewardAfterReflection,
            finalizeClosedEpisode: this.workerHandlers.finalizeClosedEpisode,
            resolvePendingSkillTrialsForReward: (input) => this.skillTrials.resolvePendingSkillTrialsForReward(input),
            decisionRepairTraceSources: (memories) => this.feedbackExperience.decisionRepairTraceSources(memories),
            synthesizeDecisionRepairDraft: (input) => synthesizeDecisionRepairDraft(input, {
                useLlm: this.config.algorithm.feedback.useLlm,
                llm: this.skillLlm
            }),
            scheduleEmbeddingAfterTextUpdate: (input) => this.embeddingJobs.scheduleEmbeddingAfterTextUpdate(input),
            repairEvidenceValueDiff: sessionRepairEvidenceValueDiff
        });
        const trialOwner = this;
        this.skillTrials = new SkillTrialResolver({
            repos: this.repos,
            get config() { return trialOwner.config; },
            requireRawTurn: this.requireRawTurn.bind(this),
            assertRawTurnInScope: this.assertRawTurnInScope.bind(this),
            requireExistingMemory: this.requireExistingMemory.bind(this),
            assertMemoryInScope: this.assertMemoryInScope.bind(this),
            traceMeta: this.traceMeta.bind(this),
            feedbackTargetFromRawTurn: (rawTurn) => this.feedbackExperience.feedbackTargetFromRawTurn(rawTurn)
        });
        const feedbackOwner = this;
        this.feedbackExperience = new FeedbackExperienceService({
            repos: this.repos,
            get config() { return feedbackOwner.config; },
            get skillLlm() { return feedbackOwner.skillLlm; },
            get embedder() { return feedbackOwner.embedder; },
            memoryAddEnabled: this.memoryAddEnabled.bind(this),
            resolveContext: this.resolveContext.bind(this),
            assertSessionInScope: this.assertSessionInScope.bind(this),
            assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
            assertRawTurnInScope: this.assertRawTurnInScope.bind(this),
            assertMemoryInScope: this.assertMemoryInScope.bind(this),
            requireEpisode: this.requireEpisode.bind(this),
            requireRawTurn: this.requireRawTurn.bind(this),
            requireExistingMemory: this.requireExistingMemory.bind(this),
            traceMeta: this.traceMeta.bind(this),
            enqueueJob: this.workerHandlers.enqueueJob,
            encodeChangeCursor: this.encodeChangeCursor.bind(this),
            readOnlyCursor: this.readOnlyCursor.bind(this),
            pendingTrialsForFeedback: this.skillTrials.pendingTrialsForFeedback.bind(this.skillTrials)
        });
        const importJobOwner = this;
        this.importJobs = new ImportJobProcessor({
            get config() { return importJobOwner.config; },
            nowIso,
            transaction: this.repos.transaction.bind(this.repos),
            createError: (code, message) => new MemoryServiceError(code, message),
            assertMemoryAddEnabled: this.assertMemoryAddEnabled.bind(this),
            assertMemoryInScope: this.assertMemoryInScope.bind(this),
            sanitizeMemoryAddRequest,
            resolveContext: this.resolveContext.bind(this),
            requireSession: this.requireSession.bind(this),
            assertSessionInScope: this.assertSessionInScope.bind(this),
            normalizeMemoryAddCreatedAt,
            memoryAddImportTrace,
            memoryAddQaPair,
            memoryCaptureQaHash,
            normalizeMemoryCaptureSource,
            isAgentSourceImportMemoryAdd,
            titleFromImportTrace,
            memoryAddTags,
            memoryAddKey,
            toolCallsFromUnknown,
            renderTraceMemoryValue,
            buildMemory: (input) => this.buildMemory(input),
            kindFromMemory,
            namespaceIdFromMemory,
            enqueueJob: this.enqueueJob.bind(this),
            jobToRef,
            recordApiLog: (operation, request, result, latencyMs, success, at, agentId) => recordApiLog(this.repos.runtime, operation, request, result, latencyMs, success, at, agentId),
            memories: this.repos.memories,
            captureClaims: this.repos.captureClaims,
            processing: this.repos.processing,
            runtime: this.repos.runtime
        });
        const embeddingJobOwner = this;
        this.embeddingJobs = new EmbeddingJobProcessor({
            repos: this.repos,
            get embedder() { return embeddingJobOwner.embedder; },
            get llm() { return embeddingJobOwner.llm; },
            get capture() { return embeddingJobOwner.config.algorithm.capture; },
            nowIso,
            enqueueJob: this.enqueueJob.bind(this),
            enqueueImportSummaryIfMissing: this.workerHandlers.enqueueImportSummaryIfMissing,
            enqueueEmbeddingRetry: this.workerHandlers.enqueueEmbeddingRetry,
            appendEmbeddingRetryChange: this.workerHandlers.appendEmbeddingRetryChange,
            summarizeTraceForCapture: this.evolutionJobs.summarizeTraceForCapture.bind(this.evolutionJobs),
            decideTurnMemoryForCapture: this.evolutionJobs.decideTurnMemoryForCapture.bind(this.evolutionJobs),
            finalizeClosedEpisode: (episode, at) => this.workerHandlers.finalizeClosedEpisode(episode, at, "capture_decided")
        });
        const workerRunnerOwner = this;
        this.workerRunner = new WorkerRunner({
            repos: this.repos,
            get embedder() { return workerRunnerOwner.embedder; },
            get capture() { return workerRunnerOwner.config.algorithm.capture; },
            embeddingRetryWorkerId: this.embeddingRetryWorkerId,
            memoryAddEnabled: this.memoryAddEnabled.bind(this),
            nowIso,
            encodeChangeCursor: this.encodeChangeCursor.bind(this),
            namespaceIdFromMemory,
            runWorkerNoWrite: this.runWorkerNoWrite.bind(this),
            restartFailedProcessing: this.restartFailedProcessing.bind(this),
            enqueueJob: this.workerHandlers.enqueueJob,
            enqueueEmbeddingRetry: this.workerHandlers.enqueueEmbeddingRetry,
            appendJobChange: this.workerHandlers.appendJobChange,
            appendEmbeddingRetryChange: this.workerHandlers.appendEmbeddingRetryChange,
            jobHandlers: {
                processJob: (job) => this.withModelTaskContext(() => this.workerHandlers.processJob(job))
            },
            embeddingJobs: this.embeddingJobs
        });
        this.episodeReadModel = new EpisodeReadModel({
            repos: this.repos,
            assertMemorySearchEnabled: this.assertMemorySearchEnabled.bind(this),
            resolveContext: this.resolveContext.bind(this),
            requireSession: this.requireSession.bind(this),
            requireEpisode: this.requireEpisode.bind(this),
            assertSessionInScope: this.assertSessionInScope.bind(this),
            assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
            assertMemoryInScope: this.assertMemoryInScope.bind(this),
            namespaceForSession,
            readableMemoryIdKind,
            invalidArgument: (message) => new MemoryServiceError("invalid_argument", message),
            notFound: (message) => new MemoryServiceError("not_found", message),
            memoryMatchesTags,
            rawTurnSummary: sessionRawTurnSummary,
            rawTurnIdFromMemory,
            episodeIdFromMemory: (memory) => traceMetaFromMemory(memory)?.episodeId,
            traceSortKey,
            detailFromMemory,
            memoryDetailWithLayerPayload,
            memoryEtag,
            stableHash,
            nowIso
        });
        this.skillReadModel = new SkillReadModel({
            repositories: this.repos,
            assertMemorySearchEnabled: this.assertMemorySearchEnabled.bind(this),
            assertMemoryAddEnabled: this.assertMemoryAddEnabled.bind(this),
            assertMemoryInScope: this.assertMemoryInScope.bind(this),
            assertSessionInScope: this.assertSessionInScope.bind(this),
            requireOpenSession: this.requireOpenSession.bind(this),
            ensureEpisode: this.ensureEpisode.bind(this),
            resolveSkillTrialEvidence: this.skillTrials.resolveSkillTrialEvidence.bind(this.skillTrials),
            encodeChangeCursor: this.encodeChangeCursor.bind(this),
            skillMetaFromMemory,
            detailFromMemory,
            procedureFromSkillMemory,
            namespaceForSession,
            namespaceForMemory,
            nowIso,
            newId,
            stableHash,
            createError: (code, message) => new MemoryServiceError(code, message)
        });
        const panelReadOwner = this;
        this.panelReadModel = new PanelReadModel({
            repos: this.repos,
            config: () => panelReadOwner.config,
            storageCapabilities: this.storageCapabilities.bind(this),
            schemaVersion: this.schemaVersion.bind(this),
            health: this.health.bind(this),
            models: () => ({
                summary: {
                    ...panelReadOwner.llm.status(),
                    routing: panelReadOwner.config.roleRouting.summary
                },
                evolution: {
                    ...panelReadOwner.skillLlm.status(),
                    routing: panelReadOwner.config.roleRouting.evolution
                },
                embedding: {
                    ...panelReadOwner.embedder.status(),
                    mode: panelReadOwner.config.embedding.mode
                }
            }),
            resolveContext: this.resolveContext.bind(this),
            encodeChangeCursor: this.encodeChangeCursor.bind(this),
            decodeChangeCursor: this.decodeChangeCursor.bind(this),
            episodeRef,
            rawTurnSummary: sessionRawTurnSummary,
            now: nowIso
        });
        const retrievalOwner = this;
        this.retrieval = new RetrievalService({
            repos: this.repos,
            get config() { return retrievalOwner.config; },
            get llm() { return retrievalOwner.llm; },
            get skillLlm() { return retrievalOwner.skillLlm; },
            get embedder() { return retrievalOwner.embedder; },
            assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
            assertMemorySearchEnabled: this.assertMemorySearchEnabled.bind(this),
            memoryAddEnabled: this.memoryAddEnabled.bind(this),
            memorySearchEnabled: this.memorySearchEnabled.bind(this),
            queryRewriteEnabled: this.queryRewriteEnabled.bind(this),
            requireEpisode: this.requireEpisode.bind(this),
            resolveContext: this.resolveContext.bind(this),
            turnStartRetrievalLimit: this.turnStartRetrievalLimit.bind(this),
            memoryHasImportPipeline,
            namespaceIdFromContext,
            withTimeout
        });
        const sessionTurnOwner = this;
        this.sessionTurns = new SessionTurnService({
            repos: this.repos,
            get config() { return sessionTurnOwner.config; },
            get llm() { return sessionTurnOwner.llm; },
            get skillLlm() { return sessionTurnOwner.skillLlm; },
            assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
            assertMemoryAddEnabled: this.assertMemoryAddEnabled.bind(this),
            assertRawTurnInScope: this.assertRawTurnInScope.bind(this),
            assertSessionInScope: this.assertSessionInScope.bind(this),
            buildMemory: this.buildMemory.bind(this),
            closeSessionNoWrite: this.closeSessionNoWrite.bind(this),
            completeTurnNoWrite: this.completeTurnNoWrite.bind(this),
            decisionRepairTraceSources: this.feedbackExperience.decisionRepairTraceSources.bind(this.feedbackExperience),
            encodeChangeCursor: this.encodeChangeCursor.bind(this),
            enqueueJob: this.enqueueJob.bind(this),
            feedbackTargetFromEpisode: this.feedbackExperience.feedbackTargetFromEpisode.bind(this.feedbackExperience),
            finalizeClosedEpisode: this.finalizeClosedEpisode.bind(this),
            isMemoryReadyForRetrieval: this.isMemoryReadyForRetrieval.bind(this),
            maybeCreateDecisionRepair: this.feedbackExperience.maybeCreateDecisionRepair.bind(this.feedbackExperience),
            memoryAddEnabled: this.memoryAddEnabled.bind(this),
            memorySearchEnabled: this.memorySearchEnabled.bind(this),
            observeToolNoWrite: this.observeToolNoWrite.bind(this),
            openSessionNoWrite: this.openSessionNoWrite.bind(this),
            pendingTrialsForFeedback: this.skillTrials.pendingTrialsForFeedback.bind(this.skillTrials),
            queryVector: this.queryVector.bind(this),
            requireEpisode: this.requireEpisode.bind(this),
            requireOpenSession: this.requireOpenSession.bind(this),
            requireSession: this.requireSession.bind(this),
            retrievalTuningConfig: this.retrievalTuningConfig.bind(this),
            search: this.search.bind(this),
            startTurnNoWrite: this.startTurnNoWrite.bind(this),
            subagentStartNoWrite: this.subagentStartNoWrite.bind(this),
            traceMeta: this.traceMeta.bind(this),
            turnStartRetrievalLimit: this.turnStartRetrievalLimit.bind(this),
            synthesizeDecisionRepairDraft: (input) => synthesizeDecisionRepairDraft(input, {
                useLlm: this.config.algorithm.feedback.useLlm,
                llm: this.skillLlm
            }),
            firstLine,
            memoryLayersForIntent,
            namespaceIdFromContext,
            namespaceIdFromMemory,
            namespaceIdFromSession,
            normalizeRequestTags,
            polarityFromTurnFeedback,
            rawTurnIdFromMemory,
            renderTraceMemoryValue,
            retrievedMemorySourceIds,
            sanitizeTraceToolCalls,
            stringFromMeta,
            stringifyForMemory,
            withDuplicateFlag
        });
        serviceLogger.info("initialized", memoryConfigLogFields(this.config));
    }
    resolveModelTaskContext() {
        const taskConfig = cloneMemmyConfig(this.options.configPath || this.options.configLoader
            ? (this.options.configLoader ?? loadMemmyConfig)(this.options.configPath).config
            : this.config);
        const summary = this.options.llm
            ?? createConfiguredMemoryLlm(taskConfig, "memory_summary");
        const evolution = this.options.skillLlm
            ?? createConfiguredMemoryLlm(taskConfig, "memory_evolution");
        const embedding = this.options.embedder ?? createEmbedder(taskConfig.embedding);
        freezeModelSelectionConfig(taskConfig);
        return {
            config: taskConfig,
            summary,
            evolution,
            embedding
        };
    }
    withModelTaskContext(operation) {
        return this.modelTasks.run(operation);
    }
    memoryAddEnabled() {
        return this.config.algorithm.enableMemoryAdd;
    }
    memorySearchEnabled() {
        return this.config.algorithm.enableMemorySearch;
    }
    queryRewriteEnabled() {
        return this.config.algorithm.enableQueryRewrite;
    }
    turnStartRetrievalLimit() {
        const retrieval = this.config.algorithm.retrieval;
        return Math.max(1, retrieval.tier1TopK + retrieval.tier2TopK + retrieval.tier3TopK);
    }
    health(routes = []) {
        const schema = this.schemaVersion();
        const backend = this.storageCapabilities();
        return {
            ok: true,
            serviceVersion: PROJECT_VERSION,
            protocolVersion: MEMORY_PROTOCOL_VERSION,
            viewerVersion: MEMORY_VIEWER_VERSION,
            viewerUrl: viewerUrlFromEndpoint(this.config.storage.endpoint),
            version: PROJECT_VERSION,
            uptimeMs: Date.now() - this.startedAt,
            mode: this.mode,
            storage: {
                ...backend,
                schemaVersion: String(schema.version),
                ready: schema.version > 0,
                lastMigrationId: schema.lastMigrationId
            },
            models: {
                summary: {
                    ...this.llm.status(),
                    routing: this.config.roleRouting.summary
                },
                evolution: {
                    ...this.skillLlm.status(),
                    routing: this.config.roleRouting.evolution
                },
                embedding: {
                    ...this.embedder.status(),
                    mode: this.config.embedding.mode
                }
            },
            capabilities: {
                routes,
                tools: [
                    "session.open",
                    "session.close",
                    "turn.start",
                    "turn.complete",
                    ...(this.memorySearchEnabled() ? ["memory.search"] : []),
                    ...(this.memoryAddEnabled() ? ["memory.add"] : []),
                    ...(this.memorySearchEnabled() ? ["memory.get"] : []),
                    ...(this.memoryAddEnabled() ? ["memory.delete"] : []),
                    "panel.overview",
                    "panel.analysis",
                    "panel.items"
                ],
                memoryLayers: ["L1", "L2", "L3", "L4", "Skill"],
                supportsCli: true,
                service: [...MEMORY_CAPABILITIES]
            },
            serverTime: nowIso()
        };
    }
    async testModels() {
        const summaryProbe = probeLlm(this.llm, "viewer.model-test.summary");
        const evolutionProbe = this.skillLlm === this.llm
            ? summaryProbe.then((result) => ({ ...result }))
            : probeLlm(this.skillLlm, "viewer.model-test.evolution");
        const [summary, evolution, embedding] = await Promise.all([
            summaryProbe,
            evolutionProbe,
            probeEmbedding(this.embedder)
        ]);
        return {
            ok: summary.ok && evolution.ok && embedding.ok,
            checkedAt: nowIso(),
            models: { summary, evolution, embedding }
        };
    }
    hubRecords(limit = 200) {
        return this.repos.runtime.listKv("legacy_hub:", limit);
    }
    reloadConfig(request = {}) {
        const previousConfig = this.config;
        const loader = this.options.configLoader ?? loadMemmyConfig;
        const nextConfig = cloneMemmyConfig(loader(this.options.configPath).config);
        const changed = stableStringify(previousConfig) !== stableStringify(nextConfig);
        const requiresRestart = stableStringify(previousConfig.storage) !== stableStringify(nextConfig.storage);
        const reloadedAt = nowIso();
        this.config = nextConfig;
        if (!requiresRestart && request.restartFailedProcessing !== false) {
            this.restartFailedProcessing(reloadedAt);
        }
        serviceLogger.info("config.reloaded", {
            changed,
            requiresRestart,
            restartFailedProcessing: !requiresRestart && request.restartFailedProcessing !== false,
            ...memoryConfigLogFields(this.config)
        });
        return {
            changed,
            requiresRestart,
            models: {
                summary: {
                    ...this.llm.status(),
                    routing: this.config.roleRouting.summary
                },
                evolution: {
                    ...this.skillLlm.status(),
                    routing: this.config.roleRouting.evolution
                },
                embedding: {
                    ...this.embedder.status(),
                    mode: this.config.embedding.mode
                }
            },
            reloadedAt
        };
    }
    storageCapabilities() {
        return this.options.backend?.capabilities() ?? sqliteBackendCapabilities(requireMemoryDb(this.options));
    }
    schemaVersion() {
        if (this.options.db) {
            return this.options.db.schemaVersion();
        }
        const capabilities = this.storageCapabilities();
        const version = Number(capabilities.schemaVersion);
        return {
            version: Number.isFinite(version) ? version : 0
        };
    }
    withTimeZone(request) {
        return {
            ...request,
            timeZone: resolveTimeZone(this.config.timeZone ?? request.timeZone)
        };
    }
    async idempotent(operation, request, fingerprint, run) {
        const scopedRun = () => this.withModelTaskContext(run);
        if (!this.memoryAddEnabled()) {
            return scopedRun();
        }
        const idempotencyKey = request.adapterId && request.requestId
            ? `${operation}:${request.adapterId}:${request.requestId}`
            : undefined;
        if (!idempotencyKey) {
            return scopedRun();
        }
        const requestHash = stableHash({ operation, fingerprint });
        const existing = this.repos.runtime.getIdempotency(idempotencyKey);
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
            }
            return withDuplicateFlag(existing.response);
        }
        const response = await scopedRun();
        this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, response);
        return response;
    }
    async idempotentExact(operation, request, fingerprint, run) {
        const scopedRun = () => this.withModelTaskContext(run);
        if (!this.memoryAddEnabled())
            return scopedRun();
        const idempotencyKey = request.adapterId && request.requestId
            ? `${operation}:${request.adapterId}:${request.requestId}`
            : undefined;
        if (!idempotencyKey)
            return scopedRun();
        const requestHash = sha256Hex(canonicalJson(assertJsonValue({ operation, fingerprint })));
        const existing = this.repos.runtime.getIdempotency(idempotencyKey);
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
            }
            return existing.response;
        }
        const response = await scopedRun();
        this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, response);
        return response;
    }
    adapterActivate(request = {}) {
        const namespace = normalizeNamespace(request.namespace);
        return {
            adapterId: request.adapterId ?? "anonymous",
            serviceVersion: PROJECT_VERSION,
            acceptedCapabilities: {
                lifecycle: request.capabilities?.lifecycle ?? true,
                tools: request.capabilities?.tools ?? true,
                observations: request.capabilities?.observations ?? true,
                panel: request.capabilities?.panel ?? true
            },
            effectiveNamespace: {
                userId: namespace.userId,
                projectId: namespace.projectId ?? namespace.workspaceId,
                workspaceId: namespace.workspaceId,
                profileId: namespace.profileId
            },
            serverTime: nowIso()
        };
    }
    openSession(request) {
        return this.sessionTurns.openSession(this.withTimeZone(request));
    }
    closeSession(sessionId, request = {}) {
        return this.sessionTurns.closeSession(sessionId, this.withTimeZone(request));
    }
    compactSession(sessionId, request = {}) {
        return this.sessionTurns.compactSession(sessionId, this.withTimeZone(request));
    }
    async startTurn(request) {
        return this.withModelTaskContext(() => this.sessionTurns.startTurn(this.withTimeZone(request)));
    }
    completeTurn(turnId, request) {
        return this.sessionTurns.completeTurn(turnId, this.withTimeZone(request));
    }
    async observeTool(input) {
        return this.withModelTaskContext(() => this.sessionTurns.observeTool(this.withTimeZone(input)));
    }
    subagentStart(input) {
        return this.sessionTurns.subagentStart(this.withTimeZone(input));
    }
    subagentComplete(input) {
        return this.sessionTurns.subagentComplete(this.withTimeZone(input));
    }
    async repairSuggestion(input) {
        return this.withModelTaskContext(() => this.sessionTurns.repairSuggestion(this.withTimeZone(input)));
    }
    async search(request) {
        return this.withModelTaskContext(() => this.retrieval.search(this.withTimeZone(request)));
    }
    isMemoryReadyForRetrieval(memory) {
        return this.retrieval.isMemoryReadyForRetrieval(memory);
    }
    retrievalTuningConfig() {
        return this.retrieval.retrievalTuningConfig();
    }
    addMemory(request) {
        return this.importJobs.addMemory(this.withTimeZone(request));
    }
    timeline(input) {
        return this.episodeReadModel.timeline(this.withTimeZone(input));
    }
    getMemory(id, request = {}) {
        return this.episodeReadModel.getMemory(id, this.withTimeZone(request));
    }
    listSkills(input = {}) {
        return this.skillReadModel.listSkills(this.withTimeZone(input));
    }
    getSkill(skillId, request = {}) {
        return this.skillReadModel.getSkill(skillId, this.withTimeZone(request));
    }
    useSkill(skillId, request) {
        return this.skillReadModel.useSkill(skillId, this.withTimeZone(request));
    }
    async feedback(request) {
        return this.withModelTaskContext(() => this.feedbackExperience.feedback(request));
    }
    exportBundle(request = {}) {
        this.assertMemorySearchEnabled();
        const context = this.resolveContext(request);
        const tables = scopeBundleTables(this.repos.runtime.exportBundleTables(request.includeRawText === true), context.namespace);
        tables.memory_vectors = this.repos.vectors.exportRows().map((row) => ({ ...row }));
        if (request.includeAudit === false) {
            delete tables.audit_logs;
        }
        if (this.memoryAddEnabled()) {
            this.repos.runtime.insertAudit({
                userId: context.userId,
                actor: request.namespace ? { ...request.namespace } : {},
                action: "export",
                targetKind: "bundle",
                targetId: `export_${stableHash(nowIso()).slice(0, 16)}`,
                meta: {
                    includeRawText: request.includeRawText === true,
                    includeAudit: request.includeAudit !== false,
                    tables: Object.keys(tables)
                },
                createdAt: nowIso()
            });
        }
        return {
            schemaVersion: this.schemaVersion().version,
            exportedAt: nowIso(),
            manifest: {
                service: "memmy-memory-service",
                includeRawText: request.includeRawText === true,
                includeAudit: request.includeAudit !== false,
                backend: this.storageCapabilities().backend,
                tables: Object.keys(tables)
            },
            tables,
            serverTime: nowIso()
        };
    }
    clearAllData() {
        this.assertMemoryAddEnabled();
        const clearedAt = nowIso();
        return {
            ok: true,
            cleared: this.repos.clearAllMemoryData(),
            clearedAt,
            serverTime: nowIso()
        };
    }
    importBundle(request) {
        this.assertMemoryAddEnabled();
        if (!request.bundle || !request.bundle.tables || typeof request.bundle.tables !== "object") {
            throw new MemoryServiceError("invalid_argument", "import bundle must contain tables");
        }
        const context = this.resolveContext(request);
        const importedAt = nowIso();
        const result = this.repos.runtime.importBundleTables(request.bundle.tables, {
            conflictStrategy: request.conflictStrategy ?? "skip"
        });
        const importedVectors = importedMemoryVectors(request.bundle.tables.memory_vectors);
        this.repos.vectors.importRows(importedVectors);
        result.inserted.memory_vectors = importedVectors.length;
        const reembedMemoryIds = importedReembedMemoryIds(request.bundle.tables, this.embedder.config.model ?? this.embedder.config.provider);
        const audit = this.repos.runtime.insertAudit({
            userId: context.userId,
            actor: request.namespace ? { ...request.namespace } : {},
            action: "import",
            targetKind: "bundle",
            targetId: `import_${stableHash(importedAt).slice(0, 16)}`,
            meta: {
                sourceSchemaVersion: request.bundle.schemaVersion,
                sourceExportedAt: request.bundle.exportedAt,
                conflictStrategy: request.conflictStrategy ?? "skip",
                inserted: result.inserted,
                skipped: result.skipped,
                replaced: result.replaced,
                migrationMap: result.migrationMap,
                conflicts: result.conflicts,
                reembedMemoryIds
            },
            createdAt: importedAt
        });
        return {
            ok: true,
            importedAt,
            conflictStrategy: request.conflictStrategy ?? "skip",
            inserted: result.inserted,
            skipped: result.skipped,
            replaced: result.replaced,
            migrationMap: result.migrationMap,
            conflicts: result.conflicts,
            reembedMemoryIds,
            auditId: audit.id,
            serverTime: nowIso()
        };
    }
    archiveMemory(id, request = {}) {
        this.assertMemoryAddEnabled();
        const memory = this.requireExistingMemory(id);
        this.assertMemoryInScope(memory, request.namespace);
        const kind = kindFromMemory(memory);
        const at = nowIso();
        const archived = this.repos.memories.archive(memory.id, at);
        if (!archived) {
            throw new MemoryServiceError("not_found", `memory not found: ${id}`);
        }
        const changeSeq = this.repos.runtime.appendChange({
            memoryId: archived.id,
            namespaceId: namespaceIdFromMemory(archived),
            kind: kindFromMemory(archived),
            op: "archived",
            entityId: archived.id,
            userId: archived.userId,
            changeType: "archive",
            version: archived.version,
            before: memory,
            after: archived,
            source: "panel.archive",
            createdAt: archived.updatedAt
        });
        const audit = this.repos.runtime.insertAudit({
            userId: archived.userId,
            sessionId: archived.sessionId,
            actor: request.namespace ? { ...request.namespace } : {},
            action: "archive",
            targetKind: kindFromMemory(archived),
            targetId: archived.id,
            before: memory,
            after: archived,
            meta: { reason: request.reason },
            createdAt: archived.updatedAt
        });
        return {
            ok: true,
            id: archived.id,
            kind: kindFromMemory(archived),
            status: "archived",
            changeSeq,
            syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? namespaceForMemory(archived)),
            auditId: audit.id,
            serverTime: nowIso()
        };
    }
    deleteMemory(id, request = {}) {
        this.assertMemoryAddEnabled();
        const memory = this.requireExistingMemory(id);
        this.assertMemoryInScope(memory, request.namespace);
        const at = nowIso();
        const deleted = this.repos.memories.softDelete(memory.id, at);
        if (!deleted) {
            throw new MemoryServiceError("not_found", `memory not found: ${id}`);
        }
        const changeSeq = this.repos.runtime.appendChange({
            memoryId: deleted.id,
            namespaceId: namespaceIdFromMemory(deleted),
            kind: kindFromMemory(deleted),
            op: "deleted",
            entityId: deleted.id,
            userId: deleted.userId,
            changeType: "delete",
            version: deleted.version,
            before: memory,
            after: deleted,
            source: "panel.delete",
            createdAt: deleted.updatedAt
        });
        const audit = this.repos.runtime.insertAudit({
            userId: deleted.userId,
            sessionId: deleted.sessionId,
            actor: request.namespace ? { ...request.namespace } : {},
            action: "delete",
            targetKind: kindFromMemory(deleted),
            targetId: deleted.id,
            before: memory,
            after: deleted,
            meta: { reason: request.reason },
            createdAt: deleted.updatedAt
        });
        return {
            ok: true,
            id: deleted.id,
            kind: kindFromMemory(deleted),
            status: "deleted",
            changeSeq,
            syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? namespaceForMemory(deleted)),
            auditId: audit.id,
            serverTime: nowIso()
        };
    }
    recallEvidence(queryId, request = {}) {
        this.assertMemorySearchEnabled();
        const event = this.repos.runtime.getRecallEventByQueryId(queryId);
        if (!event)
            throw new MemoryServiceError("not_found", `recall event not found: ${queryId}`);
        if (request.namespace?.userId && request.namespace.userId !== event.userId) {
            throw new MemoryServiceError("forbidden", "recall event belongs to a different user");
        }
        const eventRequest = isRecord(event.request) ? event.request : {};
        const evidence = isRecord(eventRequest.recallEvidence) ? eventRequest.recallEvidence : {};
        const storedHits = Array.isArray(evidence.hits)
            ? evidence.hits.filter(isRecord)
            : [];
        const hits = storedHits.flatMap((hit) => {
            if (!hit.members?.length) {
                return this.isDeletedRecallMemory(hit.id) ? [] : [hit];
            }
            const members = hit.members.filter((member) => !this.isDeletedRecallMemory(member.id));
            if (members.length === 0)
                return [];
            const memberIds = new Set(members.map((member) => member.id));
            return [{
                    ...hit,
                    members,
                    memberMemoryIds: (hit.memberMemoryIds ?? members.map((member) => member.id))
                        .filter((id) => memberIds.has(id)),
                    retrievalRoutes: [...new Set(members.map((member) => member.retrievalRoute))]
                }];
        });
        const rawTurn = event.sessionId && event.turnId
            ? this.repos.runtime.getRawTurnBySessionTurn(event.sessionId, event.turnId)
            : undefined;
        const turnComplete = rawTurn && isRecord(rawTurn.messagePayload?.turn_complete)
            ? rawTurn.messagePayload.turn_complete
            : undefined;
        const recordedCapture = turnComplete && isRecord(turnComplete.memory_capture)
            ? turnComplete.memory_capture
            : undefined;
        return {
            recallEventId: event.id,
            queryId: event.queryId ?? queryId,
            query: event.query,
            hits,
            diagnostics: {
                candidateMemoryIds: event.candidateMemoryIds ?? [],
                injectedMemoryIds: event.injectedMemoryIds ?? [],
                ...(recordedCapture
                    ? { capture: recordedCapture }
                    : rawTurn ? { capture: { status: "pending" } } : {})
            },
            createdAt: event.createdAt,
            serverTime: nowIso()
        };
    }
    deletePanelTask(id, request = {}) {
        this.assertMemoryAddEnabled();
        const episode = this.requireEpisode(id);
        this.assertEpisodeInScope(episode, request.namespace);
        const deletedMemoryIds = [];
        this.repos.transaction(() => {
            for (const memoryId of episode.l1MemoryIds) {
                if (!this.repos.memories.get(memoryId))
                    continue;
                this.deleteMemory(memoryId, request);
                deletedMemoryIds.push(memoryId);
            }
            if (!this.repos.runtime.deleteEpisode(id)) {
                throw new MemoryServiceError("not_found", `episode not found: ${id}`);
            }
        });
        return {
            ok: true,
            id,
            deletedMemoryIds,
            serverTime: nowIso()
        };
    }
    redactRawTurn(rawTurnId, request = {}) {
        this.assertMemoryAddEnabled();
        const rawTurn = this.repos.runtime.getRawTurn(rawTurnId);
        if (!rawTurn) {
            throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurnId}`);
        }
        this.assertRawTurnInScope(rawTurn, request.namespace);
        const session = this.repos.runtime.getSession(rawTurn.sessionId);
        const rawTurnNamespace = session ? namespaceForSession(session) : namespaceForRawTurn(rawTurn);
        const at = nowIso();
        const mode = request.mode ?? "redact";
        const redacted = {
            ...rawTurn,
            userText: undefined,
            assistantText: undefined,
            reasoningSummary: undefined,
            toolCalls: [],
            toolResults: [],
            messagePayload: {
                ...(rawTurn.messagePayload ?? {}),
                governance: {
                    redacted: true,
                    mode,
                    reason: request.reason,
                    at
                }
            },
            status: mode === "delete" ? "deleted" : rawTurn.status,
            redactedAt: at,
            deletedAt: mode === "delete" ? at : rawTurn.deletedAt
        };
        this.repos.runtime.updateRawTurn(redacted);
        const changeSeq = this.repos.runtime.appendChange({
            memoryId: rawTurn.id,
            namespaceId: namespaceIdFromContext(rawTurnNamespace),
            kind: "raw_turn",
            op: mode === "delete" ? "deleted" : "updated",
            entityId: rawTurn.id,
            userId: rawTurn.userId,
            changeType: mode === "delete" ? "raw_turn_delete" : "raw_turn_redact",
            before: rawTurn,
            after: redacted,
            source: "panel.raw_redact",
            createdAt: at
        });
        const audit = this.repos.runtime.insertAudit({
            userId: rawTurn.userId,
            sessionId: rawTurn.sessionId,
            actor: request.namespace ? { ...request.namespace } : {},
            action: mode === "delete" ? "raw_delete" : "raw_redact",
            targetKind: "raw_turn",
            targetId: rawTurn.id,
            before: sessionRawTurnSummary(rawTurn),
            after: sessionRawTurnSummary(redacted),
            meta: { reason: request.reason },
            createdAt: at
        });
        return {
            ok: true,
            rawTurnId: rawTurn.id,
            mode,
            changeSeq,
            syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? rawTurnNamespace),
            auditId: audit.id,
            serverTime: nowIso()
        };
    }
    auditLogs(input = {}) {
        return this.panelReadModel.auditLogs(input);
    }
    serviceLogs(input = {}) {
        return this.panelReadModel.serviceLogs(input);
    }
    apiLogs(input = {}) {
        return this.panelReadModel.apiLogs(input);
    }
    serviceMetrics(input = {}) {
        return this.panelReadModel.serviceMetrics(input);
    }
    adminStatus(input = {}, routes = []) {
        return this.panelReadModel.adminStatus(input, routes);
    }
    configStatus(_input = {}) {
        return this.panelReadModel.configStatus(_input);
    }
    panelOverview(input = {}) {
        return this.panelReadModel.panelOverview(this.withTimeZone(input));
    }
    panelOverviewSummary(input = {}) {
        return this.panelReadModel.panelOverviewSummary(this.withTimeZone(input));
    }
    panelAnalysis(input = {}) {
        return this.panelReadModel.panelAnalysis(this.withTimeZone(input));
    }
    panelItems(input) {
        return this.panelReadModel.panelItems(this.withTimeZone(input));
    }
    panelTasks(input) {
        return this.panelReadModel.panelTasks(this.withTimeZone(input));
    }
    panelRawTurns(input = {}) {
        return this.panelReadModel.panelRawTurns(this.withTimeZone(input));
    }
    panelChanges(input = {}) {
        return this.panelReadModel.panelChanges(input);
    }
    panelJobs(input = {}) {
        return this.panelReadModel.panelJobs(input);
    }
    memoryProcessingStatus(memoryIds, request = {}) {
        return this.importJobs.memoryProcessingStatus(memoryIds, request);
    }
    retryMemoryProcessing(memoryId, request = {}) {
        return this.importJobs.retryMemoryProcessing(memoryId, request);
    }
    rebuildEmbeddings() {
        this.assertMemoryAddEnabled();
        const at = nowIso();
        let offset = 0;
        let enqueued = 0;
        for (;;) {
            const memories = this.repos.memories.list({}, 250, offset);
            for (const memory of memories) {
                this.workerHandlers.enqueueEmbeddingRetry(memory, memory.memoryValue, at);
                enqueued += 1;
            }
            if (memories.length < 250)
                break;
            offset += memories.length;
        }
        return { accepted: true, enqueued, serverTime: at };
    }
    embeddingMaintenanceStats() {
        const regular = this.repos.vectors.maintenanceDimensionCounts();
        const dimensions = new Map();
        for (const row of regular.dimensions) {
            if (row.dimension > 0)
                dimensions.set(row.dimension, (dimensions.get(row.dimension) ?? 0) + row.count);
        }
        const [dimension = 0] = [...dimensions.entries()]
            .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0] ?? [];
        const stored = [...dimensions.values()].reduce((sum, count) => sum + count, 0);
        const totalSlots = regular.totalSlots;
        const ready = dimension > 0 ? dimensions.get(dimension) ?? 0 : 0;
        const missing = Math.max(0, totalSlots - stored);
        const dimMismatch = Math.max(0, stored - ready);
        return {
            dimension,
            available: this.embedder.status().configured,
            totalSlots,
            ready,
            missing,
            dimMismatch,
            needsRepair: missing + dimMismatch
        };
    }
    restartFailedProcessing(at, limit = 10000) {
        return this.importJobs.restartFailedProcessing(at, limit);
    }
    enqueuePendingImportSummaries(limit = 10000, targetMemoryIds) {
        return this.importJobs.enqueuePendingImportSummaries(limit, targetMemoryIds);
    }
    nextWorkerRunAt() {
        return this.workerRunner.nextWorkerRunAt();
    }
    reconcileWorkerStartup(limit = 10000) {
        return this.workerRunner.reconcileWorkerStartup(limit);
    }
    runWorkerOnce(limit = 100, request = {}) {
        return this.workerRunner.runWorkerOnce(limit, request);
    }
    async queryVector(query) {
        return this.retrieval.queryVector(query);
    }
    async embedMemory(job) {
        return this.embeddingJobs.embedMemory(job);
    }
    async summarizeImportedTrace(job) {
        return this.embeddingJobs.summarizeImportedTrace(job);
    }
    async summarizeCapturedTrace(job) {
        return this.embeddingJobs.summarizeCapturedTrace(job);
    }
    enqueueJob(input) {
        return this.workerHandlers.enqueueJob(input);
    }
    finalizeClosedEpisode(episode, at, trigger) {
        return this.workerHandlers.finalizeClosedEpisode(episode, at, trigger);
    }
    buildMemory(input) {
        const at = input.createdAt ?? nowIso();
        const tags = uniq(input.tags.filter(Boolean));
        const memoryStatus = memoryStatusForLifecycleStatus(input.lifecycleStatus ?? "active");
        const inputInfo = input.info ?? {};
        const info = {
            ...inputInfo,
            tags: uniq([...tags, ...stringArray(inputInfo.tags)]),
            ...(input.projectId ? { project_id: input.projectId } : {}),
            ...(input.profileId ? { profile_id: input.profileId } : {})
        };
        return {
            id: input.id ?? newId(memoryIdPrefix(input.layer, input.kind)),
            timeline: at,
            userId: input.userId,
            conversationId: input.conversationId,
            sessionId: input.sessionId,
            agentId: input.agentId,
            appId: input.appId,
            memoryType: input.memoryType,
            status: memoryStatus,
            visibility: "private",
            memoryKey: input.key,
            memoryValue: input.value,
            tags,
            info,
            properties: {
                memory_type: input.memoryType,
                status: memoryStatus,
                tags,
                info,
                internal_info: {
                    memory_layer: input.layer,
                    memory_kind: input.kind,
                    schema_version: 1,
                    ...(input.internal ?? {})
                }
            },
            memoryLayer: input.layer,
            contentHash: stableHash(input.value),
            version: 1,
            createdAt: at,
            updatedAt: at,
            deletedAt: null
        };
    }
    assertMemoryAddEnabled() {
        if (!this.memoryAddEnabled()) {
            throw new MemoryServiceError("forbidden", "memory add is disabled by config");
        }
    }
    assertMemorySearchEnabled() {
        if (!this.memorySearchEnabled()) {
            throw new MemoryServiceError("forbidden", "memory search is disabled by config");
        }
    }
    readOnlyCursor(namespace) {
        const scoped = namespace ? normalizeNamespace(namespace) : undefined;
        const changeSeq = this.repos.runtime.latestChangeSeq(scoped?.userId, scoped ? namespaceIdFromContext(scoped) : undefined);
        return {
            changeSeq,
            syncCursor: this.encodeChangeCursor(changeSeq, scoped)
        };
    }
    openSessionNoWrite(request) {
        const namespace = normalizeNamespace(request.namespace);
        const existing = request.sessionId
            ? this.repos.runtime.getSession(request.sessionId)
            : namespace.sessionKey
                ? this.repos.runtime.findOpenSessionByHostKey({
                    userId: namespace.userId,
                    source: request.source ?? namespace.source,
                    profileId: request.profileId ?? namespace.profileId,
                    hostSessionKey: namespace.sessionKey
                })
                : undefined;
        if (existing) {
            this.assertSessionInScope(existing, request.namespace);
            return {
                sessionId: existing.id,
                userId: existing.userId,
                source: existing.source,
                profileId: existing.profileId,
                projectId: existing.projectId,
                workspaceId: existing.workspaceId,
                conversationId: existing.conversationId,
                status: "open",
                resumed: true,
                openedAt: existing.openedAt,
                serverTime: nowIso()
            };
        }
        const sessionId = request.sessionId ?? `session_${stableHash({
            userId: namespace.userId,
            source: request.source ?? namespace.source,
            profileId: request.profileId ?? namespace.profileId,
            sessionKey: namespace.sessionKey ?? "readonly"
        }).slice(0, 20)}`;
        return {
            sessionId,
            userId: namespace.userId,
            source: request.source ?? namespace.source,
            profileId: request.profileId ?? namespace.profileId,
            projectId: request.projectId ?? namespace.projectId ?? namespace.workspaceId,
            workspaceId: request.workspaceId ?? namespace.workspaceId,
            conversationId: stringFromMeta(request.meta, "conversationId"),
            status: "open",
            resumed: false,
            openedAt: nowIso(),
            serverTime: nowIso()
        };
    }
    closeSessionNoWrite(sessionId, request) {
        const existing = this.repos.runtime.getSession(sessionId);
        if (existing) {
            this.assertSessionInScope(existing, request.namespace);
        }
        const cursor = this.readOnlyCursor(request.namespace ?? (existing ? namespaceForSession(existing) : undefined));
        return {
            ok: true,
            sessionId,
            status: "closed",
            closedEpisodeIds: [],
            changeSeq: cursor.changeSeq,
            syncCursor: cursor.syncCursor,
            closedAt: nowIso(),
            serverTime: nowIso()
        };
    }
    async startTurnNoWrite(request) {
        const turnId = request.turnId ?? newId("turn");
        const contextHints = turnStartContextHints(request);
        const defaultLayers = ["Skill", "L3", "L4", "L2", "L1"];
        const requestedLayers = request.layers === undefined
            ? defaultLayers
            : defaultLayers.filter((layer) => request.layers?.includes(layer));
        const search = await this.search({
            requestId: request.requestId,
            adapterId: request.adapterId,
            namespace: request.namespace,
            sessionId: request.sessionId,
            turnId,
            query: buildSearchQuery({ ...request, contextHints }, this.config.domain),
            layers: requestedLayers,
            limit: this.turnStartRetrievalLimit(),
            contextBudget: typeof request.contextBudget === "number" ? request.contextBudget : undefined,
            includeInjectedContext: true,
            retrievalMode: "turn_start",
            contextHints,
            injectedContextQuery: request.query
        });
        return {
            contextPacketId: `ctx_${stableHash(`${request.sessionId}:unbound:${turnId}:${search.searchEventId}`).slice(0, 20)}`,
            turnId,
            sessionId: request.sessionId,
            searchEventId: search.searchEventId,
            hits: search.hits,
            injectedContext: search.injectedContext,
            sourceMemoryIds: search.sourceMemoryIds,
            droppedDueToBudget: search.droppedDueToBudget,
            status: uniq([...search.status, "memory_add:disabled:no_turn_write"]),
            serverTime: nowIso()
        };
    }
    completeTurnNoWrite(turnId, request) {
        const cursor = this.readOnlyCursor(request.namespace);
        const rawTurnId = `raw_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
        const episodeId = request.episodeId ?? `episode_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
        return {
            turnId,
            sessionId: request.sessionId,
            episodeId,
            rawTurnId,
            l1MemoryId: "",
            l1MemoryIds: [],
            closedEpisodeIds: [],
            scheduledEvolution: false,
            jobs: [],
            changeSeq: cursor.changeSeq,
            syncCursor: cursor.syncCursor,
            etag: stableHash({ memoryAdd: false, sessionId: request.sessionId, turnId }),
            serverTime: nowIso()
        };
    }
    observeToolNoWrite(input) {
        const cursor = this.readOnlyCursor(input.namespace);
        return Promise.resolve({
            ok: true,
            eventId: `event_${stableHash({ toolName: input.toolName, sessionId: input.sessionId, turnId: input.turnId }).slice(0, 20)}`,
            changeSeq: cursor.changeSeq,
            syncCursor: cursor.syncCursor,
            serverTime: nowIso()
        });
    }
    subagentStartNoWrite(input) {
        const cursor = this.readOnlyCursor(input.namespace);
        const rawTurnId = `raw_${stableHash(`readonly:subagent:${input.sessionId}:${input.subagentId ?? input.task}`).slice(0, 20)}`;
        return {
            ok: true,
            eventId: `event_${stableHash(rawTurnId).slice(0, 20)}`,
            rawTurnId,
            changeSeq: cursor.changeSeq,
            syncCursor: cursor.syncCursor,
            serverTime: nowIso()
        };
    }
    runWorkerNoWrite(request) {
        const cursor = this.readOnlyCursor(request.namespace);
        return Promise.resolve({
            leased: 0,
            succeeded: 0,
            failed: 0,
            jobs: [],
            embeddingRetries: {
                leased: 0,
                succeeded: 0,
                failed: 0,
                items: []
            },
            changeSeq: cursor.changeSeq,
            syncCursor: cursor.syncCursor,
            serverTime: nowIso()
        });
    }
    requireSession(sessionId) {
        const session = this.repos.runtime.getSession(sessionId);
        if (!session) {
            throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
        }
        return session;
    }
    requireOpenSession(sessionId) {
        const session = this.requireSession(sessionId);
        if (session.status !== "open") {
            throw new MemoryServiceError("conflict", `session is closed: ${sessionId}`);
        }
        return session;
    }
    requireExistingMemory(id) {
        const memory = this.repos.memories.get(id);
        if (!memory) {
            throw new MemoryServiceError("not_found", `memory not found: ${id}`);
        }
        return memory;
    }
    isDeletedRecallMemory(id) {
        const memory = this.repos.memories.getIncludingDeleted(id);
        return Boolean(memory && (memory.status === "deleted" || memory.deletedAt));
    }
    requireRawTurn(rawTurnId) {
        const rawTurn = this.repos.runtime.getRawTurn(rawTurnId);
        if (!rawTurn) {
            throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurnId}`);
        }
        return rawTurn;
    }
    traceMeta(memory) {
        if (!memory)
            return null;
        const rawTurnId = rawTurnIdFromMemory(memory);
        const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
        return traceMetaFromMemoryWithRaw(memory, rawTurn);
    }
    requireEpisode(episodeId) {
        const episode = this.repos.runtime.getEpisode(episodeId);
        if (!episode) {
            throw new MemoryServiceError("not_found", `episode not found: ${episodeId}`);
        }
        return episode;
    }
    assertSessionInScope(session, namespace) {
        void session;
        void namespace;
    }
    assertMemoryInScope(memory, namespace) {
        void memory;
        void namespace;
    }
    assertEpisodeInScope(episode, namespace) {
        void episode;
        void namespace;
    }
    assertRawTurnInScope(rawTurn, namespace) {
        void rawTurn;
        void namespace;
    }
    encodeChangeCursor(seq, namespace) {
        const capabilities = this.storageCapabilities();
        const payload = {
            v: 1,
            backendId: capabilities.backendId,
            schemaVersion: capabilities.schemaVersion,
            namespaceId: namespace ? namespaceIdFromContext(normalizeNamespace(namespace)) : "",
            seq
        };
        return `cur_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    }
    decodeChangeCursor(cursor, namespace) {
        if (!cursor)
            return 0;
        if (/^\d+$/.test(cursor))
            return Number(cursor);
        if (!cursor.startsWith("cur_")) {
            throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
        }
        let payload;
        try {
            payload = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8"));
        }
        catch {
            throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
        }
        if (!isRecord(payload) || payload.v !== 1 || typeof payload.seq !== "number") {
            throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
        }
        const capabilities = this.storageCapabilities();
        if (payload.backendId !== capabilities.backendId ||
            payload.schemaVersion !== capabilities.schemaVersion) {
            throw new MemoryServiceError("conflict", "change cursor belongs to a different backend or schema");
        }
        return Math.max(0, Math.floor(payload.seq));
    }
    ensureEpisode(session, episodeId) {
        return this.sessionTurns.ensureEpisode(session, episodeId);
    }
    resolveContext(request) {
        if (request.sessionId) {
            const session = this.repos.runtime.getSession(request.sessionId);
            if (session) {
                this.assertSessionInScope(session, request.namespace);
                return {
                    userId: session.userId,
                    conversationId: session.conversationId,
                    namespace: namespaceForSession(session)
                };
            }
        }
        const namespace = normalizeNamespace(request.namespace);
        const userId = request.userId ?? namespace.userId;
        return {
            userId,
            namespace: {
                ...namespace,
                userId
            }
        };
    }
}
function withDuplicateFlag(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, duplicate: true }
        : value;
}
function stringFromMeta(meta, key) {
    const value = meta?.[key];
    return typeof value === "string" ? value : undefined;
}
function memoryIdPrefix(layer, kind) {
    if (kind === "span")
        return "span";
    if (layer === "L1" || kind === "trace")
        return "trace";
    if (layer === "L2" || kind === "timeline")
        return "timeline";
    if (layer === "L3" || kind === "project_profile")
        return "project_profile";
    if (layer === "L4" || kind === "user_profile")
        return "user_profile";
    return "skill";
}
function normalizeRequestTags(tags) {
    const reserved = new Set(["trace", "turn", "memmy", "openclaw"]);
    const out = [];
    const seen = new Set();
    for (const tag of tags ?? []) {
        const trimmed = tag.trim();
        if (!trimmed)
            continue;
        const key = trimmed.toLowerCase();
        if (reserved.has(key))
            continue;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}
function renderTraceMemoryValue(step) {
    const parts = [
        `Summary: ${step.summary}`,
        step.rawTurnId ? `RawTurn: ${step.rawTurnId}` : undefined,
        typeof step.stepIndex === "number" ? `TraceStep: ${step.stepIndex}` : undefined,
        step.userText ? `User:\n${step.userText}` : undefined,
        step.toolCalls.length
            ? [
                "Tool calls:",
                ...step.toolCalls.map((call) => `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`)
            ].join("\n")
            : undefined,
        step.agentText ? `Agent:\n${step.agentText}` : undefined,
        step.reflection.text ? `Reflection: ${clip(step.reflection.text, 800)}` : undefined,
        `Alpha: ${step.reflection.alpha}`,
        `Value: ${step.value}`,
        `Priority: ${step.priority}`
    ].filter(Boolean);
    return parts.join("\n");
}
function sanitizeTraceToolCalls(toolCalls) {
    return toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        success: call.success,
        errorCode: call.errorCode,
        error: call.error ?? errorMessageFromUnknown(call.output),
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        thinkingBefore: call.thinkingBefore,
        assistantTextBefore: call.assistantTextBefore
    }));
}
function memoryStatusForLifecycleStatus(status) {
    if (status === "archived")
        return "archived";
    return status === "candidate" ? "resolving" : "activated";
}
function withTimeout(promise, timeoutMs) {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeout)
            clearTimeout(timeout);
    });
}
function importedReembedMemoryIds(tables, currentEmbeddingModel) {
    const ids = new Set();
    for (const row of importedMemoryVectors(tables.memory_vectors)) {
        if (shouldReembedImportedVector(row.embedding_model, row.embedding, currentEmbeddingModel)) {
            ids.add(row.memory_id);
        }
    }
    return [...ids];
}
function importedMemoryVectors(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => {
        if (!isRecord(item))
            throw new Error("memory_vectors rows must be objects");
        const vectorField = item.vector_field;
        if (vectorField !== "vec" && vectorField !== "vec_summary" && vectorField !== "vec_action") {
            throw new Error("memory_vectors.vector_field is invalid");
        }
        if (typeof item.memory_id !== "string" ||
            typeof item.embedding !== "string" ||
            typeof item.embedding_dim !== "number" ||
            typeof item.updated_at !== "string") {
            throw new Error("memory_vectors row is incomplete");
        }
        return {
            memory_id: item.memory_id,
            vector_field: vectorField,
            embedding: item.embedding,
            embedding_model: typeof item.embedding_model === "string" ? item.embedding_model : null,
            embedding_provider: typeof item.embedding_provider === "string" ? item.embedding_provider : null,
            embedding_dim: item.embedding_dim,
            updated_at: item.updated_at
        };
    });
}
function shouldReembedImportedVector(embeddingModel, embedding, currentEmbeddingModel) {
    if (typeof embeddingModel === "string" && embeddingModel.trim()) {
        return embeddingModel !== currentEmbeddingModel;
    }
    return embedding !== null && embedding !== undefined;
}
function namespaceIdFromMemory(memory) {
    return namespaceIdFromContext(namespaceForMemory(memory));
}
function namespaceIdFromSession(session) {
    return namespaceIdFromContext(namespaceForSession(session));
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
function scopeBundleTables(tables, namespace) {
    void namespace;
    return tables;
}
function uniq(values) {
    return Array.from(new Set(values));
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
function errorMessageFromUnknown(value) {
    if (value === undefined || value === null)
        return undefined;
    if (value instanceof Error)
        return value.message;
    if (typeof value === "string")
        return value;
    if (isRecord(value)) {
        const message = value.error ?? value.message;
        if (typeof message === "string")
            return message;
    }
    return undefined;
}
function cloneMemmyConfig(config) {
    return structuredClone(config);
}
function freezeModelSelectionConfig(config) {
    for (const model of [config.summary, config.evolution, config.embedding]) {
        if (model.actualModelContext) {
            Object.freeze(model.actualModelContext.capabilities);
            Object.freeze(model.actualModelContext);
        }
        if (model.extraHeaders)
            Object.freeze(model.extraHeaders);
        if (model.extraBody)
            Object.freeze(model.extraBody);
        Object.freeze(model);
    }
}
function memoryConfigLogFields(config) {
    const evolution = resolveEvolutionConfig(config);
    return {
        summaryRouting: config.roleRouting.summary,
        evolutionRouting: config.roleRouting.evolution,
        embeddingMode: config.embedding.mode,
        memoryAddEnabled: config.algorithm.enableMemoryAdd,
        memorySearchEnabled: config.algorithm.enableMemorySearch,
        summaryModel: {
            provider: config.summary.provider,
            vendor: config.summary.vendor,
            model: config.summary.model,
            maxTokens: config.summary.maxTokens,
            timeoutMs: config.summary.timeoutMs,
            maxRetries: config.summary.maxRetries,
            malformedRetries: config.summary.malformedRetries
        },
        evolutionModel: {
            provider: evolution.provider,
            vendor: evolution.vendor,
            model: evolution.model,
            maxTokens: evolution.maxTokens,
            timeoutMs: evolution.timeoutMs,
            maxRetries: evolution.maxRetries,
            malformedRetries: evolution.malformedRetries
        },
        embeddingModel: {
            provider: config.embedding.provider,
            model: config.embedding.model,
            timeoutMs: config.embedding.timeoutMs,
            maxRetries: config.embedding.maxRetries
        },
        evolutionGates: {
            l2UseLlm: config.algorithm.l2Induction.useLlm,
            l2MinEpisodes: config.algorithm.l2Induction.minEpisodesForInduction,
            l2MinGain: config.algorithm.l2Induction.minGain,
            l3UseLlm: config.algorithm.l3Abstraction.useLlm,
            l3MinPolicies: config.algorithm.l3Abstraction.minPolicies,
            l3MinPolicyGain: config.algorithm.l3Abstraction.minPolicyGain,
            l3MinPolicySupport: config.algorithm.l3Abstraction.minPolicySupport,
            l3ClusterMinSimilarity: config.algorithm.l3Abstraction.clusterMinSimilarity,
            skillUseLlm: config.algorithm.skill.useLlm,
            skillMinSupport: config.algorithm.skill.minSupport,
            skillMinGain: config.algorithm.skill.minGain
        }
    };
}
function viewerUrlFromEndpoint(endpoint) {
    const base = new URL(endpoint ?? "http://127.0.0.1:18960");
    base.pathname = "/viewer";
    base.search = "";
    base.hash = "";
    return base.toString().replace(/\/$/, "");
}
async function probeLlm(client, operation) {
    const startedAt = Date.now();
    const status = client.status();
    if (!client.isConfigured()) {
        return {
            ok: false,
            provider: status.provider,
            model: status.model,
            latencyMs: 0,
            error: "model is not configured"
        };
    }
    try {
        const text = await client.complete([{ role: "user", content: "Reply with OK." }], { operation, temperature: 0, maxTokens: 8, timeoutMs: 15_000, maxRetries: 0 });
        if (!text.trim())
            throw new Error("model returned an empty response");
        return {
            ok: true,
            provider: status.provider,
            model: status.model,
            latencyMs: Date.now() - startedAt
        };
    }
    catch (error) {
        return {
            ok: false,
            provider: status.provider,
            model: status.model,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
async function probeEmbedding(embedder) {
    const startedAt = Date.now();
    const status = embedder.status();
    try {
        const vector = await embedder.embedOne("Memmy model connectivity test", "query");
        if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
            throw new Error("embedding model returned an invalid vector");
        }
        return {
            ok: true,
            provider: status.provider,
            model: status.model,
            latencyMs: Date.now() - startedAt,
            dimensions: vector.length
        };
    }
    catch (error) {
        return {
            ok: false,
            provider: status.provider,
            model: status.model,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
