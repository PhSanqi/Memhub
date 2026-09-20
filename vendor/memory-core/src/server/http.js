import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createAgentSourceExecutor } from "../agent-source/runtime.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { isMemoryViewerPath, memoryViewerAsset } from "../viewer/static.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../types.js";
import { MemoryService } from "../service/memory-service.js";
import { MemoryServiceError, statusForCode } from "../utils/error.js";
import { resolveTimeZone } from "../utils/time.js";
import { createPluginRuntimeAnalytics, hitCountFromGetResponse, hitCountFromSearchResponse, storedCountFromAddResponse, trackExternalHookCapture, trackExternalHookRecall, trackExternalToolCall, } from "./plugin-runtime-analytics.js";
import { VIEWER_API_ROUTES, assertLocalViewerRequest, isViewerApiRequest, routeViewerRequest, streamViewerEvents } from "./viewer-api.js";
const logger = createMemoryLogger("http");
const workerLogger = createMemoryLogger("worker");
export const API_ROUTES = [
    "GET /health",
    "GET /api/v1/health",
    "POST /api/v1/admin/reload-config",
    "POST /api/v1/admin/shutdown",
    "GET /api/v1/admin/export",
    "DELETE /api/v1/admin/data",
    "POST /api/v1/sessions/open",
    "POST /api/v1/sessions/:sessionId/close",
    "POST /api/v1/turns/start",
    "POST /api/v1/turns/:turnId/complete",
    "POST /api/v1/memory/search",
    "GET /api/v1/memory/recalls/:queryId",
    "POST /api/v1/memory/add",
    "POST /api/v1/memory/processing/status",
    "POST /api/v1/memory/:id/processing/retry",
    "GET /api/v1/memory/:id",
    "DELETE /api/v1/memory/:id",
    "POST /api/v1/worker/run",
    "POST /api/v1/worker/import-summaries/enqueue",
    "GET /api/v1/memory/logs",
    "GET /api/v1/panel/overview",
    "GET /api/v1/panel/analysis",
    "GET /api/v1/panel/items",
    "GET /api/v1/panel/tasks",
    "DELETE /api/v1/panel/tasks/:id",
    ...VIEWER_API_ROUTES
];
const DEFAULT_WORKER_STARTUP_FALLBACK_MS = 5_000;
const DEFAULT_WORKER_POST_HEALTH_DELAY_MS = 250;
const serverCleanup = new WeakMap();
export function createMemoryHttpServer(options) {
    const autoWorker = createAutoWorkerDrain(options.service, {
        startupFallbackMs: options.workerStartupFallbackMs ?? DEFAULT_WORKER_STARTUP_FALLBACK_MS,
        postHealthDelayMs: options.workerPostHealthDelayMs ?? DEFAULT_WORKER_POST_HEALTH_DELAY_MS
    });
    const pluginRuntimeAnalytics = options.pluginRuntimeAnalytics ?? createPluginRuntimeAnalytics();
    const agentSources = options.agentSourceExecutor ?? createAgentSourceExecutor({
        service: options.service,
        configPath: options.configPath,
        scheduleWorker: autoWorker.schedule
    });
    const activeRequests = new Set();
    const server = createServer((request, response) => {
        const handling = handleRequest(request, response);
        activeRequests.add(handling);
        void handling.finally(() => activeRequests.delete(handling));
    });
    async function handleRequest(request, response) {
        const startedAt = Date.now();
        const requestId = requestIdFromHeaders(request) ?? randomUUID();
        const requestPath = request.url?.split("?", 1)[0] ?? "<missing>";
        setSecurityHeaders(response);
        try {
            if (!request.url || !request.method) {
                throw new MemoryServiceError("invalid_argument", "missing request url or method");
            }
            const url = new URL(request.url, "http://127.0.0.1");
            if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/v1/health")) {
                response.once("finish", () => autoWorker.afterHealthCheck());
            }
            if (request.method === "GET" && isMemoryViewerPath(url.pathname)) {
                assertLocalViewerRequest(request, url);
                const asset = memoryViewerAsset(url.pathname);
                if (!asset)
                    throw new MemoryServiceError("not_found", `Viewer asset not found: ${url.pathname}`);
                writeViewerAsset(response, asset);
                return;
            }
            const viewerRequest = isViewerApiRequest(request, url);
            if (viewerRequest)
                assertLocalViewerRequest(request, url);
            if (viewerRequest && request.method === "GET" && url.pathname === "/api/v1/events") {
                streamViewerEvents({
                    service: options.service,
                    configPath: options.configPath,
                    routes: API_ROUTES,
                    scheduleWorker: autoWorker.schedule,
                    timeZone: requestTimeZone(request, options.timeZone),
                    agentSources
                }, request, response, url);
                return;
            }
            const principal = {
                ...(viewerRequest ? viewerPrincipal() : authenticate(request, url, options)),
                timeZone: requestTimeZone(request, options.timeZone)
            };
            const body = await readJson(request);
            if (viewerRequest) {
                const viewerResult = await routeViewerRequest({
                    service: options.service,
                    configPath: options.configPath,
                    routes: API_ROUTES,
                    scheduleWorker: autoWorker.schedule,
                    timeZone: principal.timeZone,
                    viewerCli: options.viewerCli,
                    restartService: options.onRestartRequested,
                    agentSources
                }, request.method, url, body);
                if (viewerResult) {
                    if (viewerResult.afterResponse) {
                        response.once("finish", () => {
                            void Promise.resolve()
                                .then(() => viewerResult.afterResponse?.())
                                .catch((error) => logger.error("service.restart.failed", {
                                requestId,
                                ...memoryErrorFields(error)
                            }));
                        });
                    }
                    writeJson(response, viewerResult.status ?? 200, viewerResult.body, viewerResult.headers);
                    return;
                }
            }
            const result = await routeRequest(options.service, autoWorker, request.method, url, body, principal, Boolean(options.onShutdownRequested), pluginRuntimeAnalytics, requestId);
            if (request.method === "POST" && url.pathname === "/api/v1/admin/shutdown") {
                response.once("finish", () => options.onShutdownRequested?.());
            }
            writeJson(response, 200, result);
            logger.debug("request.succeeded", {
                requestId,
                method: request.method,
                path: requestPath,
                status: 200,
                durationMs: Date.now() - startedAt
            });
        }
        catch (error) {
            const status = error instanceof MemoryServiceError ? statusForCode(error.code) : 500;
            const fields = {
                requestId,
                method: request.method,
                path: requestPath,
                status,
                durationMs: Date.now() - startedAt,
                ...(error instanceof MemoryServiceError ? { errorCode: error.code } : {}),
                ...memoryErrorFields(error)
            };
            if (status >= 500) {
                logger.error("request.failed", fields);
            }
            else {
                logger.warn("request.rejected", fields);
            }
            writeError(response, error, requestId);
        }
    }
    server.once("listening", () => {
        autoWorker.start();
        if (options.startAgentSourceAutomation)
            agentSources.startAutomation();
    });
    let cleanup;
    const dispose = () => cleanup ??= Promise.all([
        autoWorker.dispose(),
        agentSources.dispose(),
        ...activeRequests,
    ]).then(() => undefined);
    serverCleanup.set(server, dispose);
    server.on("close", () => {
        void dispose().catch((error) => logger.error("service.cleanup.failed", memoryErrorFields(error)));
    });
    return server;
}
export async function closeMemoryHttpServer(server) {
    // Closing sockets alone does not settle workers, scans or async request handlers.
    const cleanup = serverCleanup.get(server)?.();
    await Promise.all([
        cleanup,
        new Promise((resolveClose, rejectClose) => {
            if (!server.listening) {
                resolveClose();
                return;
            }
            server.close((error) => error ? rejectClose(error) : resolveClose());
            server.closeAllConnections();
        }),
    ]);
}
export async function listenMemoryHttpServer(options) {
    const server = createMemoryHttpServer(options);
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 18960;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    return {
        server,
        url: `http://${address.address}:${address.port}`
    };
}
function createAutoWorkerDrain(service, options) {
    let running = false;
    let requested = false;
    let scheduled = false;
    let disposed = false;
    let startupReleased = false;
    let startupReconciled = false;
    let startupTimer;
    let delayedTimer;
    let scheduledTimer;
    let drainStopped;
    let activeDrain;
    const maxCycles = 40;
    const workerBatchSize = 4;
    async function drain() {
        if (disposed) {
            return;
        }
        if (running) {
            requested = true;
            return;
        }
        running = true;
        activeDrain = new Promise((done) => { drainStopped = done; });
        let continueSoon = false;
        try {
            if (!startupReconciled) {
                startupReconciled = true;
                try {
                    service.reconcileWorkerStartup();
                }
                catch (error) {
                    workerLogger.error("startup.reconciliation_failed", memoryErrorFields(error));
                }
            }
            do {
                requested = false;
                for (let cycle = 0; cycle < maxCycles && !disposed; cycle += 1) {
                    const result = await service.runWorkerOnce(workerBatchSize, {
                        priorityCohortOnly: true
                    });
                    if (result.leased === 0 && result.embeddingRetries.leased === 0) {
                        break;
                    }
                    if (cycle === maxCycles - 1) {
                        continueSoon = true;
                    }
                    await yieldToEventLoop();
                }
            } while (requested && !continueSoon && !disposed);
        }
        catch (error) {
            workerLogger.error("drain.failed", memoryErrorFields(error));
        }
        finally {
            running = false;
            drainStopped?.();
            if (disposed) {
                return;
            }
            if (requested || continueSoon) {
                scheduledTimer = setTimeout(() => {
                    scheduledTimer = undefined;
                    requested = true;
                    void drain();
                }, 0);
            }
            else {
                scheduleNextDueJob();
            }
        }
    }
    function scheduleNextDueJob() {
        if (disposed) {
            return;
        }
        if (delayedTimer) {
            return;
        }
        const delayMs = nextWorkerRunAfterDelayMs(service);
        if (delayMs === undefined) {
            return;
        }
        delayedTimer = setTimeout(() => {
            delayedTimer = undefined;
            requested = true;
            void drain();
        }, delayMs);
    }
    function schedule() {
        if (disposed) {
            return;
        }
        startupReleased = true;
        requested = true;
        if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = undefined;
        }
        if (delayedTimer) {
            clearTimeout(delayedTimer);
            delayedTimer = undefined;
        }
        if (scheduled) {
            return;
        }
        scheduled = true;
        scheduledTimer = setTimeout(() => {
            scheduledTimer = undefined;
            scheduled = false;
            void drain();
        }, 0);
    }
    return {
        start() {
            if (disposed || startupReleased || startupTimer) {
                return;
            }
            startupTimer = setTimeout(() => {
                startupTimer = undefined;
                schedule();
            }, Math.max(0, options.startupFallbackMs));
        },
        afterHealthCheck() {
            if (disposed || startupReleased) {
                return;
            }
            startupReleased = true;
            if (startupTimer) {
                clearTimeout(startupTimer);
            }
            startupTimer = setTimeout(() => {
                startupTimer = undefined;
                schedule();
            }, Math.max(0, options.postHealthDelayMs));
        },
        schedule,
        async dispose() {
            disposed = true;
            requested = false;
            if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimer = undefined;
            }
            if (delayedTimer) {
                clearTimeout(delayedTimer);
                delayedTimer = undefined;
            }
            if (scheduledTimer) {
                clearTimeout(scheduledTimer);
                scheduledTimer = undefined;
            }
            await activeDrain;
        }
    };
}
function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
function nextWorkerRunAfterDelayMs(service) {
    const now = Date.now();
    const runAt = service.nextWorkerRunAt();
    return runAt === undefined ? undefined : Math.max(1, runAt - now);
}
async function routeRequest(service, autoWorker, method, url, body, principal, canShutdown, pluginRuntimeAnalytics, requestId) {
    const path = url.pathname;
    if (method === "GET" && (path === "/health" || path === "/api/v1/health")) {
        return service.health([...API_ROUTES]);
    }
    if (method === "POST" && path === "/api/v1/admin/reload-config") {
        requireAdminWrite(principal);
        const request = asObject(body, "admin.reload-config");
        const result = service.reloadConfig({
            requestId: typeof request.requestId === "string" ? request.requestId : undefined,
            adapterId: typeof request.adapterId === "string" ? request.adapterId : undefined,
            reason: typeof request.reason === "string" ? request.reason : undefined,
            timeZone: request.timeZone,
            restartFailedProcessing: typeof request.restartFailedProcessing === "boolean"
                ? request.restartFailedProcessing
                : undefined
        });
        autoWorker.schedule();
        return result;
    }
    if (method === "POST" && path === "/api/v1/admin/shutdown") {
        requireAdminWrite(principal);
        if (!canShutdown) {
            throw new MemoryServiceError("conflict", "memory service restart is not managed by this server");
        }
        return {
            accepted: true,
            serverTime: new Date().toISOString()
        };
    }
    if (method === "POST" && path === "/api/v1/sessions/open") {
        requireMemoryWrite(principal);
        const rawRequest = asObject(body, "sessions.create");
        const request = envelopeWithPrincipal(rawRequest, principal);
        const publicRequest = {
            requestId: request.requestId,
            adapterId: request.adapterId,
            namespace: request.namespace,
            timeZone: request.timeZone,
            sessionId: request.sessionId,
            workspacePath: request.workspacePath,
            meta: request.meta
        };
        const result = await service.idempotent("sessions.create", publicRequest, publicRequest, () => service.openSession(publicRequest));
        return publicOpenSessionResponse(result);
    }
    const sessionClose = match(path, /^\/api\/v1\/sessions\/([^/]+)\/close$/);
    if (method === "POST" && sessionClose) {
        requireMemoryWrite(principal);
        const request = envelopeWithPrincipal(asObject(body, "sessions.close"), principal);
        const sessionId = decodeMatchSegment(sessionClose, 1);
        const result = await service.idempotent("sessions.close", request, { sessionId, request }, () => service.closeSession(sessionId, request));
        scheduleAutoWorkerForEvolution(result, autoWorker);
        return publicCloseSessionResponse(result);
    }
    if (method === "POST" && path === "/api/v1/turns/start") {
        requireMemoryRead(principal);
        const request = requestWithPrincipal(body, "turn.start", principal);
        requireStringField(request, "sessionId", "turn.start");
        requireStringField(request, "query", "turn.start");
        const publicRequest = {
            requestId: request.requestId,
            adapterId: request.adapterId,
            namespace: request.namespace,
            timeZone: request.timeZone,
            sessionId: request.sessionId,
            query: request.query,
            turnId: request.turnId,
            layers: normalizeLayerSelection(request.layers),
            contextHints: request.contextHints,
            contextBudget: request.contextBudget
        };
        const result = await trackExternalHookRecall(pluginRuntimeAnalytics, request, () => service.idempotent("turn.start", publicRequest, { request: publicRequest }, () => service.startTurn(publicRequest)));
        scheduleAutoWorkerForEvolution(result, autoWorker);
        return publicStartTurnResponse(result);
    }
    const turnComplete = match(path, /^\/api\/v1\/turns\/([^/]+)\/complete$/);
    if (method === "POST" && turnComplete) {
        requireMemoryWrite(principal);
        const request = requestWithPrincipal(body, "turn.complete", principal);
        requireStringField(request, "sessionId", "turn.complete");
        requireStringField(request, "query", "turn.complete");
        requireStringField(request, "answer", "turn.complete");
        const turnId = decodeMatchSegment(turnComplete, 1);
        const publicRequest = {
            requestId: request.requestId,
            adapterId: request.adapterId,
            namespace: request.namespace,
            timeZone: request.timeZone,
            sessionId: request.sessionId,
            episodeId: request.episodeId,
            query: request.query,
            answer: request.answer,
            reasoningSummary: request.reasoningSummary,
            tags: request.tags,
            toolCalls: request.toolCalls,
            toolResults: request.toolResults,
            artifacts: request.artifacts,
            sourceMemoryIds: request.sourceMemoryIds,
            usage: request.usage,
            status: request.status
        };
        const result = await trackExternalHookCapture(pluginRuntimeAnalytics, { ...request, turnId }, request, () => service.completeTurn(turnId, publicRequest));
        scheduleAutoWorkerForEvolution(result, autoWorker);
        return publicCompleteTurnResponse(result);
    }
    if (method === "POST" && path === "/api/v1/memory/search") {
        requireMemoryRead(principal);
        const request = requestWithPrincipal(body, "memory.search", principal);
        requireStringField(request, "query", "memory.search");
        const publicRequest = {
            requestId: request.requestId,
            adapterId: request.adapterId,
            namespace: request.namespace,
            timeZone: request.timeZone,
            query: request.query,
            sessionId: request.sessionId,
            episodeId: request.episodeId,
            turnId: request.turnId,
            layers: normalizeLayers(request.layers),
            tags: Array.isArray(request.tags) ? request.tags.filter((tag) => typeof tag === "string") : undefined,
            limit: typeof request.limit === "number" && Number.isFinite(request.limit)
                ? Math.max(1, Math.trunc(request.limit))
                : undefined,
            contextBudget: typeof request.contextBudget === "number" && Number.isFinite(request.contextBudget)
                ? Math.max(0, Math.trunc(request.contextBudget))
                : undefined,
            includeInjectedContext: typeof request.includeInjectedContext === "boolean" ? request.includeInjectedContext : undefined,
            verbose: request.verbose === true
        };
        return publicSearchResponse(await trackExternalToolCall(pluginRuntimeAnalytics, { ...request, toolName: "memmy_memory_search" }, () => service.idempotent("memory.search", publicRequest, { path, request: publicRequest }, () => service.search(publicRequest)), (result) => ({ hit_count: hitCountFromSearchResponse(result) })));
    }
    const recallEvidence = match(path, /^\/api\/v1\/memory\/recalls\/([^/]+)$/);
    if (method === "GET" && recallEvidence) {
        requireMemoryRead(principal);
        const queryId = decodeMatchSegment(recallEvidence, 1);
        const request = envelopeWithPrincipal({}, principal);
        return service.recallEvidence(queryId, request);
    }
    if (method === "POST" && path === "/api/v1/memory/add") {
        requireMemoryWrite(principal);
        const request = requestWithPrincipal(body, "memory.add", principal);
        requireStringField(request, "content", "memory.add");
        const publicRequest = {
            requestId: request.requestId,
            adapterId: request.adapterId,
            namespace: request.namespace,
            timeZone: request.timeZone,
            content: request.content,
            layer: parseLayerValue(request.layer),
            title: request.title,
            tags: Array.isArray(request.tags) ? request.tags.filter((tag) => typeof tag === "string") : undefined,
            source: request.source,
            sessionId: request.sessionId,
            turnId: request.turnId,
            createdAt: typeof request.createdAt === "string" ? request.createdAt : undefined,
            deferProcessing: request.deferProcessing === true,
            sourceAgentId: typeof request.sourceAgentId === "string" ? request.sourceAgentId : undefined,
            sourceSkillId: typeof request.sourceSkillId === "string" ? request.sourceSkillId : undefined,
            sourceSkillPath: typeof request.sourceSkillPath === "string" ? request.sourceSkillPath : undefined,
            sourceSkillVersion: typeof request.sourceSkillVersion === "string" ? request.sourceSkillVersion : undefined,
            sourceContentHash: typeof request.sourceContentHash === "string" ? request.sourceContentHash : undefined,
            sourceArtifactId: typeof request.sourceArtifactId === "string" ? request.sourceArtifactId : undefined
        };
        const result = await trackExternalToolCall(pluginRuntimeAnalytics, { ...request, toolName: "memmy_memory_add" }, () => service.idempotent("memory.add", publicRequest, { path, request: publicRequest }, () => service.addMemory(publicRequest)), (addResult) => ({
            stored_count: storedCountFromAddResponse(addResult),
            ...(publicRequest.layer ? { layer: publicRequest.layer } : {}),
        }));
        if (!publicRequest.deferProcessing) {
            autoWorker.schedule();
        }
        return result;
    }
    if (method === "POST" && path === "/api/v1/worker/import-summaries/enqueue") {
        requireMemoryWrite(principal);
        const request = asObject(body, "worker.import-summaries.enqueue");
        const memoryIds = parseOptionalStringArray(request.memoryIds, "worker.import-summaries.enqueue.memoryIds");
        const result = service.enqueuePendingImportSummaries(10_000, memoryIds);
        if (result.enqueued > 0) {
            autoWorker.schedule();
        }
        return result;
    }
    if (method === "POST" && path === "/api/v1/worker/run") {
        requireMemoryWrite(principal);
        const request = envelopeWithPrincipal(asObject(body, "worker.run"), principal);
        return service.runWorkerOnce(parseNumberValue(request.limit) ?? parseNumber(url.searchParams.get("limit")) ?? 20, {
            ...request,
            targetMemoryIds: parseOptionalStringArray(request.targetMemoryIds, "worker.run.targetMemoryIds"),
            priorityCohortOnly: request.priorityCohortOnly === true
        });
    }
    if (method === "GET" && path === "/api/v1/panel/overview") {
        requirePanelRead(principal);
        return service.panelOverviewSummary({
            namespace: principal.namespace,
            timeZone: principal.timeZone
        });
    }
    if (method === "GET" && path === "/api/v1/admin/export") {
        requirePanelRead(principal);
        return service.exportBundle({
            namespace: principal.namespace,
            timeZone: principal.timeZone,
            includeRawText: url.searchParams.get("includeRawText") === "true",
            includeAudit: url.searchParams.get("includeAudit") === "true"
        });
    }
    if (method === "DELETE" && path === "/api/v1/admin/data") {
        requireMemoryWrite(principal);
        return service.clearAllData();
    }
    if (method === "GET" && path === "/api/v1/panel/analysis") {
        requirePanelRead(principal);
        return service.panelAnalysis({
            namespace: principal.namespace,
            timeZone: principal.timeZone
        });
    }
    if (method === "GET" && path === "/api/v1/panel/items") {
        requirePanelRead(principal);
        return publicPanelItemsResponse(service.panelItems({
            namespace: principal.namespace,
            timeZone: principal.timeZone,
            layer: parseRecallLayer(url.searchParams.get("layer")),
            status: parseStatus(url.searchParams.get("status")),
            q: url.searchParams.get("q") ?? undefined,
            sourceAgent: url.searchParams.get("sourceAgent") ?? undefined,
            excludedSourceAgents: url.searchParams.getAll("excludedSourceAgents"),
            page: parseNumber(url.searchParams.get("page"))
        }));
    }
    if (method === "GET" && path === "/api/v1/panel/tasks") {
        requirePanelRead(principal);
        return publicPanelTasksResponse(service.panelTasks({
            namespace: principal.namespace,
            timeZone: principal.timeZone,
            q: url.searchParams.get("q") ?? undefined,
            page: parseNumber(url.searchParams.get("page"))
        }));
    }
    if (method === "GET" && path === "/api/v1/memory/logs") {
        requirePanelRead(principal);
        return service.apiLogs({
            tools: parseApiLogTools(url.searchParams.get("tools")),
            sourceAgent: url.searchParams.get("sourceAgent") ?? undefined,
            excludedSourceAgents: url.searchParams.getAll("excludedSourceAgents"),
            limit: parseNumber(url.searchParams.get("limit")),
            offset: parseNumber(url.searchParams.get("offset"))
        });
    }
    if (method === "POST" && path === "/api/v1/memory/processing/status") {
        requireMemoryRead(principal);
        const request = envelopeWithPrincipal(asObject(body, "memory.processing.status"), principal);
        return service.memoryProcessingStatus(parseOptionalStringArray(request.memoryIds, "memory.processing.status.memoryIds") ?? [], request);
    }
    const memoryProcessingRetry = match(path, /^\/api\/v1\/memory\/([^/]+)\/processing\/retry$/);
    if (method === "POST" && memoryProcessingRetry) {
        requireMemoryWrite(principal);
        const request = envelopeWithPrincipal(asObject(body, "memory.processing.retry"), principal);
        const result = service.retryMemoryProcessing(decodeMatchSegment(memoryProcessingRetry, 1), request);
        if (result.accepted)
            autoWorker.schedule();
        return result;
    }
    const memoryGet = match(path, /^\/api\/v1\/memory\/([^/]+)$/);
    if (method === "GET" && memoryGet) {
        requireMemoryRead(principal);
        return trackExternalToolCall(pluginRuntimeAnalytics, {
            source: url.searchParams.get("source") ?? undefined,
            adapterId: url.searchParams.get("adapterId") ?? undefined,
            namespace: principal.namespace,
            toolName: "memmy_memory_get",
        }, () => service.getMemory(decodeMatchSegment(memoryGet, 1), { namespace: principal.namespace, timeZone: principal.timeZone }), (result) => ({ hit_count: hitCountFromGetResponse(result) }));
    }
    const panelTaskDelete = match(path, /^\/api\/v1\/panel\/tasks\/([^/]+)$/);
    if (method === "DELETE" && panelTaskDelete) {
        requireMemoryWrite(principal);
        const request = envelopeWithPrincipal(asObject(body, "panel.task.delete"), principal);
        const id = decodeMatchSegment(panelTaskDelete, 1);
        return publicDeletePanelTaskResponse(service.deletePanelTask(id, request));
    }
    const memoryDelete = match(path, /^\/api\/v1\/memory\/([^/]+)$/);
    if (method === "DELETE" && memoryDelete) {
        requireMemoryWrite(principal);
        const request = envelopeWithPrincipal(asObject(body, "memory.delete"), principal);
        const id = decodeMatchSegment(memoryDelete, 1);
        return publicDeleteMemoryResponse(await service.idempotent("memory.delete", request, { id, request }, () => service.deleteMemory(id, request)));
    }
    throw new MemoryServiceError("not_found", `${method} ${path} is not registered`);
}
function publicOpenSessionResponse(result) {
    const record = responseRecord(result);
    return {
        sessionId: record.sessionId,
        status: record.status,
        resumed: record.resumed,
        projectId: record.projectId ?? null,
        serverTime: record.serverTime
    };
}
function scheduleAutoWorkerForEvolution(result, autoWorker) {
    const record = responseRecord(result);
    const closedEpisodeIds = Array.isArray(record.closedEpisodeIds)
        ? record.closedEpisodeIds.filter((id) => typeof id === "string" && id.length > 0)
        : [];
    const jobs = Array.isArray(record.jobs)
        ? record.jobs.filter((job) => typeof job === "object" && job !== null)
        : [];
    if (closedEpisodeIds.length > 0 || jobs.length > 0 || record.scheduledEvolution === true) {
        autoWorker.schedule();
    }
}
function publicCloseSessionResponse(result) {
    const record = responseRecord(result);
    return {
        ok: record.ok,
        sessionId: record.sessionId,
        status: record.status,
        closedEpisodeIds: record.closedEpisodeIds,
        changeSeq: record.changeSeq,
        syncCursor: record.syncCursor,
        serverTime: record.serverTime
    };
}
function publicCompleteTurnResponse(result) {
    const record = responseRecord(result);
    return {
        turnId: record.turnId,
        sessionId: record.sessionId,
        episodeId: record.episodeId,
        rawTurnId: record.rawTurnId,
        l1MemoryId: record.l1MemoryId,
        l1MemoryIds: record.l1MemoryIds,
        closedEpisodeIds: record.closedEpisodeIds,
        scheduledEvolution: record.scheduledEvolution,
        jobs: record.jobs,
        changeSeq: record.changeSeq,
        serverTime: record.serverTime,
        ...(record.duplicate === true ? { duplicate: true } : {})
    };
}
function publicStartTurnResponse(result) {
    const record = responseRecord(result);
    return {
        turnId: record.turnId,
        contextPacketId: record.contextPacketId,
        sessionId: record.sessionId,
        searchEventId: record.searchEventId,
        injectedContext: record.injectedContext,
        sourceMemoryIds: record.sourceMemoryIds,
        hits: record.hits,
        status: record.status,
        serverTime: record.serverTime
    };
}
function publicSearchResponse(result) {
    const record = responseRecord(result);
    if (record.verbose !== true) {
        return {
            injectedContext: publicSearchInjectedContextMarkdown(record.injectedContext)
        };
    }
    const injectedContext = publicSearchInjectedContextRecord(record.injectedContext);
    return {
        injectedContext: publicSearchInjectedContextMarkdown(injectedContext),
        debug: {
            searchEventId: record.searchEventId,
            hits: record.hits,
            sourceMemoryIds: record.sourceMemoryIds,
            status: record.status,
            sections: Array.isArray(injectedContext.sections) ? injectedContext.sections : [],
            tokenEstimate: typeof injectedContext.tokenEstimate === "number" ? injectedContext.tokenEstimate : undefined,
            serverTime: record.serverTime
        }
    };
}
function publicSearchInjectedContextRecord(value) {
    return typeof value === "object" && value !== null
        ? value
        : {};
}
function publicSearchInjectedContextMarkdown(value) {
    const record = publicSearchInjectedContextRecord(value);
    return typeof record.markdown === "string" ? record.markdown : "";
}
function publicPanelItemsResponse(result) {
    const record = responseRecord(result);
    return {
        items: record.items,
        page: record.page,
        pageSize: record.pageSize,
        total: record.total,
        totalPages: record.totalPages,
        hasNext: record.hasNext,
        hasPrev: record.hasPrev,
        serverTime: record.serverTime
    };
}
function publicPanelTasksResponse(result) {
    const record = responseRecord(result);
    return {
        tasks: record.tasks,
        page: record.page,
        pageSize: record.pageSize,
        total: record.total,
        totalPages: record.totalPages,
        hasNext: record.hasNext,
        hasPrev: record.hasPrev,
        serverTime: record.serverTime
    };
}
function publicDeletePanelTaskResponse(result) {
    const record = responseRecord(result);
    return {
        ok: record.ok,
        id: record.id,
        deletedMemoryIds: record.deletedMemoryIds,
        serverTime: record.serverTime
    };
}
function publicDeleteMemoryResponse(result) {
    const record = responseRecord(result);
    return {
        ok: record.ok,
        id: record.id,
        kind: record.kind,
        status: record.status,
        changeSeq: record.changeSeq,
        syncCursor: record.syncCursor,
        auditId: record.auditId,
        serverTime: record.serverTime
    };
}
function responseRecord(value) {
    return isRecord(value) ? value : {};
}
async function readJson(request) {
    if (request.method === "GET" || request.method === "HEAD") {
        return {};
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 2 * 1024 * 1024) {
            throw new MemoryServiceError("invalid_argument", "request body is too large");
        }
        chunks.push(buffer);
    }
    if (chunks.length === 0) {
        return {};
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) {
        return {};
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new MemoryServiceError("invalid_argument", "request body must be valid JSON");
    }
}
function writeJson(response, status, body, headers = {}) {
    const payload = JSON.stringify(body, null, 2);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        ...headers
    });
    response.end(payload);
}
function writeViewerAsset(response, asset) {
    response.writeHead(200, {
        "content-type": asset.contentType,
        "content-length": asset.body.byteLength,
        "cache-control": asset.cacheControl
    });
    response.end(asset.body);
}
function writeError(response, error, requestId) {
    if (error instanceof MemoryServiceError) {
        writeJson(response, statusForCode(error.code), {
            error: {
                code: error.code,
                message: error.message,
                requestId: error.requestId ?? requestId
            }
        });
        return;
    }
    writeJson(response, 500, {
        error: {
            code: "internal",
            message: error instanceof Error ? error.message : String(error),
            requestId
        }
    });
}
function requestIdFromHeaders(request) {
    return headerString(request, "x-request-id") ?? headerString(request, "x-correlation-id");
}
function authenticate(request, url, options) {
    if (url.pathname === "/health" || url.pathname === "/api/v1/health") {
        return { kind: "anonymous", scopes: ["health:read"] };
    }
    const auth = options.auth;
    const localToken = auth?.localServiceToken ?? options.apiKey;
    const candidate = tokenFromRequest(request, url);
    if (localToken && candidate === localToken) {
        return {
            kind: "local",
            tokenId: "local-service-token",
            namespace: namespaceFromRequest(request, url),
            scopes: ["*"]
        };
    }
    const cloudNamespace = candidate ? auth?.cloudAccessTokens?.[candidate] : undefined;
    if (cloudNamespace) {
        return {
            kind: "cloud",
            tokenId: stableTokenId(candidate),
            namespace: mergeNamespaces(cloudNamespace, namespaceFromRequest(request, url)),
            scopes: ["*"]
        };
    }
    const scoped = candidate ? auth?.scopedApiKeys?.[candidate] : undefined;
    if (scoped) {
        return {
            kind: "scoped",
            tokenId: stableTokenId(candidate),
            namespace: mergeNamespaces(scoped.namespace, namespaceFromRequest(request, url)),
            scopes: scoped.scopes ?? ["memory:read", "memory:write"]
        };
    }
    if (!localToken && (!auth || auth.allowAnonymous === true)) {
        return {
            kind: "anonymous",
            namespace: namespaceFromRequest(request, url),
            scopes: ["*"]
        };
    }
    throw new MemoryServiceError("unauthorized", "invalid memory service token", 401, requestIdFromHeaders(request));
}
function viewerPrincipal() {
    return { kind: "viewer", scopes: ["*"] };
}
function tokenFromRequest(request, url) {
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
    const headerKey = request.headers["x-api-key"];
    const apiKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    return bearer ?? apiKey ?? url.searchParams.get("token") ?? url.searchParams.get("access_token") ?? undefined;
}
function namespaceFromRequest(request, url) {
    const userId = headerString(request, "x-memmy-user-id");
    const tenantId = headerString(request, "x-memmy-tenant-id");
    const projectId = headerString(request, "x-memmy-project-id");
    const workspaceId = headerString(request, "x-memmy-workspace-id");
    const workspacePath = headerString(request, "x-memmy-workspace-path");
    const source = sourceString(url.searchParams.get("source"));
    const profileId = headerString(request, "x-memmy-profile-id");
    const profileLabel = headerString(request, "x-memmy-profile-label");
    const sessionKey = headerString(request, "x-memmy-session-key");
    const any = userId || tenantId || projectId || workspaceId || workspacePath || source ||
        profileId || profileLabel || sessionKey;
    if (!any)
        return undefined;
    return {
        userId,
        tenantId,
        projectId,
        workspaceId,
        workspacePath,
        source: source ?? DEFAULT_NAMESPACE_SOURCE,
        profileId: profileId ?? "default",
        profileLabel,
        sessionKey
    };
}
function sourceString(value) {
    return value && value.trim() ? value.trim() : undefined;
}
function headerString(request, key) {
    const value = request.headers[key];
    const out = Array.isArray(value) ? value[0] : value;
    return out && out.trim() ? out.trim() : undefined;
}
function stableTokenId(token) {
    let hash = 0;
    for (let index = 0; index < token.length; index += 1) {
        hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
    }
    return `tok_${hash.toString(16).padStart(8, "0")}`;
}
function requireMemoryRead(principal) {
    requireAnyScope(principal, ["memory:read", "memory:write", "panel:read", "panel:write", "admin:read", "admin:write"]);
}
function requireMemoryWrite(principal) {
    requireAnyScope(principal, ["memory:write", "panel:write", "admin:write"]);
}
function requirePanelRead(principal) {
    requireAnyScope(principal, ["panel:read", "panel:write", "memory:read", "memory:write", "admin:read", "admin:write"]);
}
function requireAdminWrite(principal) {
    requireAnyScope(principal, ["admin:write"]);
}
function requireAnyScope(principal, allowed) {
    if (principal.scopes.includes("*")) {
        return;
    }
    if (allowed.some((scope) => hasScope(principal, scope))) {
        return;
    }
    throw new MemoryServiceError("forbidden", `token scope does not allow this route`);
}
function hasScope(principal, scope) {
    if (principal.scopes.includes(scope)) {
        return true;
    }
    const [domain] = scope.split(":");
    return principal.scopes.includes(`${domain}:*`);
}
function asObject(body, routeName) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
        return body;
    }
    throw new MemoryServiceError("invalid_argument", `${routeName} request body must be a JSON object`);
}
function requestWithPrincipal(body, routeName, principal) {
    return envelopeWithPrincipal(asObject(body, routeName), principal);
}
function envelopeWithPrincipal(body, principal) {
    const existing = isRecord(body.namespace) ? body.namespace : undefined;
    const namespace = mergeNamespaces(mergeNamespaces(namespaceFromSource(body.source), existing), principal.namespace);
    assertNamespaceScope(existing, principal.namespace);
    return {
        ...body,
        namespace,
        timeZone: principal.timeZone ?? (typeof body.timeZone === "string" ? body.timeZone : undefined)
    };
}
function strictEnvelopeWithPrincipal(body, principal) {
    const requestNamespace = isRecord(body.namespace)
        ? body.namespace
        : undefined;
    const principalNamespace = principal.namespace;
    const fields = [
        "userId",
        "tenantId",
        "projectId",
        "workspaceId",
        "profileId",
        "sessionKey",
        "source"
    ];
    for (const field of fields) {
        const requested = requestNamespace?.[field];
        const scoped = principalNamespace?.[field];
        if (typeof requested === "string" && requested && typeof scoped === "string" && scoped && requested !== scoped) {
            throw new MemoryServiceError("forbidden", `namespace.${field} conflicts with authenticated scope`);
        }
    }
    const namespace = mergeNamespaces(mergeNamespaces(namespaceFromSource(body.source), requestNamespace), principalNamespace);
    if (!namespace) {
        throw new MemoryServiceError("invalid_argument", "protocol v2 requires namespace");
    }
    const source = namespace.source ?? (typeof body.source === "string" ? body.source : undefined);
    return {
        ...body,
        ...(source ? { source } : {}),
        namespace,
        timeZone: principal.timeZone ?? (typeof body.timeZone === "string" ? body.timeZone : undefined)
    };
}
function requestTimeZone(request, configuredTimeZone) {
    try {
        return resolveTimeZone(configuredTimeZone ?? headerString(request, "x-memmy-time-zone"));
    }
    catch (error) {
        throw new MemoryServiceError("invalid_argument", error instanceof Error ? error.message : "invalid timezone");
    }
}
function namespaceFromSource(source) {
    if (typeof source !== "string" || !source.trim()) {
        return undefined;
    }
    return {
        source: source.trim(),
        profileId: "default"
    };
}
function mergeNamespaces(requestNamespace, principalNamespace) {
    if (!requestNamespace && !principalNamespace)
        return undefined;
    const principalSource = principalNamespace?.source;
    return {
        ...(requestNamespace ?? {}),
        ...(principalNamespace ?? {}),
        source: principalSource && principalSource !== DEFAULT_NAMESPACE_SOURCE
            ? principalSource
            : requestNamespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
        profileId: principalNamespace?.profileId ?? requestNamespace?.profileId ?? "default"
    };
}
function assertNamespaceScope(requestNamespace, principalNamespace) {
    void requestNamespace;
    void principalNamespace;
}
function requireStringField(record, field, routeName) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new MemoryServiceError("invalid_argument", `${routeName} requires ${field}`);
    }
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function setSecurityHeaders(response) {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
}
function match(path, pattern) {
    return path.match(pattern);
}
function decodeMatchSegment(matchResult, index) {
    const segment = matchResult[index];
    if (segment === undefined) {
        throw new MemoryServiceError("invalid_argument", "missing path segment");
    }
    return decodeURIComponent(segment);
}
function parseNumber(value) {
    if (value === null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseNumberValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return typeof value === "string" ? parseNumber(value) : undefined;
}
function parseOptionalStringArray(value, field) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
        throw new MemoryServiceError("invalid_argument", `${field} must be an array of non-empty strings`);
    }
    return [...new Set(value)];
}
function parseOptionalNullableString(value, field) {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    if (typeof value !== "string" || !value.trim()) {
        throw new MemoryServiceError("invalid_argument", `${field} must be a non-empty string or null`);
    }
    return value.trim();
}
function parseApiLogTools(value) {
    if (!value) {
        return undefined;
    }
    const allowed = new Set(["memory_add", "memory_search", "skill_generate", "skill_evolve"]);
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => allowed.has(item));
}
function parseLayer(value) {
    return parseLayerValue(value);
}
function parseRecallLayer(value) {
    return parseLayerValue(value);
}
function parseLayerValue(value) {
    if (value === "L1" || value === "L2" || value === "L3" || value === "L4" || value === "Skill") {
        return value;
    }
    return undefined;
}
function normalizeLayers(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const layers = value
        .map(parseLayerValue)
        .filter((layer) => Boolean(layer));
    return layers.length > 0 ? layers : undefined;
}
function normalizeLayerSelection(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const layers = value.map((item) => {
        const layer = parseLayerValue(item);
        if (!layer) {
            throw new MemoryServiceError("invalid_argument", "turn.start layers must contain only L1, L2, L3, L4, or Skill");
        }
        return layer;
    });
    return [...new Set(layers)];
}
function parseStatus(value) {
    if (value === "activated" || value === "resolving" || value === "archived" || value === "deleted") {
        return value;
    }
    return undefined;
}
