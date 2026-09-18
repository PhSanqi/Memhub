import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { normalizeWorkspaceUri, renderL3WorldModelContext, } from "../../../contracts/index.js";
import { assertMemoryNetworkTarget } from "../../../privacy/network-policy.js";
const DEFAULT_ENDPOINT = "http://127.0.0.1:18960";
export async function readRuntimeConfig(configUrl, pinnedOwner = false) {
    const snapshot = objectValue(await readJson(configUrl));
    const configPath = text(snapshot.memmy_config_path) || resolve(homedir(), ".memmy", "config.yaml");
    const yaml = objectValue(YAML.parse(await readFile(configPath, "utf8").catch(() => "{}")));
    const memory = objectValue(yaml.memmyMemory);
    const storage = objectValue(memory.storage);
    const legacyStorage = objectValue(yaml.storage);
    const app = objectValue(yaml.app);
    return {
        endpoint: text(storage.endpoint) || text(memory.endpoint) || text(legacyStorage.endpoint) || text(snapshot.endpoint) || DEFAULT_ENDPOINT,
        token: text(storage.token) || text(memory.token) || text(legacyStorage.token) || text(snapshot.token),
        userId: pinnedOwner
            ? text(snapshot.userId) || "local-user"
            : text(app.userId) || text(memory.userId) || text(snapshot.userId) || "local-user",
        workspaceHostId: text(snapshot.workspaceHostId),
    };
}
export async function openRuntimeSession(input) {
    const config = await readRuntimeConfig(input.configUrl, input.pinnedOwner === true);
    const client = new RuntimeHttpClient(config);
    const health = await client.get("/api/v1/health").catch(() => null);
    if (!health && input.pinnedOwner === true)
        return null;
    const features = objectValue(objectValue(health).features);
    const supportsV2 = numberArray(features.l3WorldModelProtocolVersions).includes(2);
    const adapterId = input.adapterId || `memmy-${input.source}-adapter`;
    const profileId = input.profileId || "default";
    if (!supportsV2)
        return openLegacyRuntimeSession(client, config, input, adapterId, profileId);
    const resolvedWorkspaceRoot = input.workspaceRoot ? await canonicalWorkspaceRoot(input.workspaceRoot) : null;
    const workspaceRoot = resolvedWorkspaceRoot && config.workspaceHostId ? resolvedWorkspaceRoot : null;
    const envelope = runtimeEnvelope(input.source, input.sessionKey, config.userId, null, adapterId, profileId);
    const workspaceUri = workspaceRoot ? normalizeWorkspaceUri(pathToFileURL(workspaceRoot).href) : null;
    let opened;
    try {
        opened = objectValue(await client.post("/api/v1/sessions/open", compact({
            ...envelope,
            l3WorldModelProtocolVersion: 2,
            l3WorldModelTransition: input.transition,
            workspaceUri: workspaceUri || undefined,
            workspaceHostId: workspaceUri ? config.workspaceHostId : undefined,
        })));
    }
    catch (error) {
        if (input.transition !== "resume_only" || !isV2ResumeConflict(error))
            throw error;
        return openLegacyRuntimeSession(client, config, input, adapterId, profileId);
    }
    const sessionId = text(opened.sessionId);
    if (!sessionId)
        return null;
    return {
        protocol: "v2",
        sessionId,
        projectId: text(opened.projectId) || null,
        sessionKey: input.sessionKey,
        source: input.source,
        adapterId,
        profileId,
        workspaceRoot,
        config,
    };
}
async function openLegacyRuntimeSession(client, config, input, adapterId, profileId) {
    const externalSessionId = input.sessionKey;
    const opened = objectValue(await client.post("/api/v1/sessions/open", {
        sessionId: externalSessionId,
        source: input.source,
        profileId: profileId !== "default" ? profileId : undefined,
        workspacePath: input.workspaceRoot || undefined,
    }));
    return {
        protocol: "legacy",
        sessionId: text(opened.sessionId) || externalSessionId,
        projectId: null,
        sessionKey: input.sessionKey,
        source: input.source,
        adapterId,
        profileId,
        workspaceRoot: null,
        config,
    };
}
export async function loadRuntimeL3(session) {
    if (session.protocol !== "v2")
        return { ...session, additionalContext: "", renderedContext: "", memoryVersion: null };
    const client = new RuntimeHttpClient(session.config);
    const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
    const result = objectValue(await client.get(`/api/v1/l3-world-model/sessions/${encodeURIComponent(session.sessionId)}/context`, envelopeGetTransport(envelope)));
    const renderedContext = text(result.renderedContext);
    return {
        ...session,
        additionalContext: renderedContext ? renderL3WorldModelContext(renderedContext) : "",
        renderedContext,
        memoryVersion: typeof result.memoryVersion === "number" ? result.memoryVersion : null,
    };
}
export async function notifyRuntimeBoundary(session, trigger) {
    if (session.protocol !== "v2")
        return false;
    const client = new RuntimeHttpClient(session.config);
    const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
    const head = objectValue(await client.get(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/l3-world-model-trace-head`, envelopeGetTransport(envelope)));
    const throughL1MemoryId = text(head.throughL1MemoryId);
    if (!throughL1MemoryId)
        return false;
    await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/l3-world-model-boundary`, {
        ...envelope,
        trigger,
        throughL1MemoryId,
    });
    return true;
}
export async function closeRuntimeSession(session) {
    const client = new RuntimeHttpClient(session.config);
    const body = session.protocol === "v2"
        ? runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId)
        : { source: session.source };
    await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/close`, body);
}
export async function startRuntimeTurn(session, turnId, query) {
    const client = new RuntimeHttpClient(session.config);
    const body = session.protocol === "v2"
        ? { ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId), sessionId: session.sessionId, turnId, query }
        : { source: session.source, adapterId: session.adapterId, requestId: `${session.source}-start:${turnId}`, sessionId: session.sessionId, turnId, query };
    return objectValue(await client.post("/api/v1/turns/start", body));
}
export async function completeRuntimeTurn(session, input) {
    const client = new RuntimeHttpClient(session.config);
    const body = session.protocol === "v2"
        ? {
            ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId),
            sessionId: session.sessionId,
            episodeId: input.episodeId,
            query: input.query,
            answer: input.answer,
            status: input.status,
            sourceMemoryIds: input.sourceMemoryIds,
            reasoningSummary: input.reasoningSummary,
            toolCalls: input.toolCalls,
            toolResults: input.toolResults,
        }
        : {
            source: session.source,
            adapterId: session.adapterId,
            requestId: `${session.source}-complete:${input.turnId}:${hashText([input.status, input.query, input.answer].join("\u0000"))}`,
            sessionId: session.sessionId,
            ...input,
        };
    await client.post(`/api/v1/turns/${encodeURIComponent(input.turnId)}/complete`, compact(body));
}
class RuntimeHttpClient {
    config;
    constructor(config) {
        this.config = config;
        assertMemoryNetworkTarget(config.endpoint, {
            purpose: "agent workspace bridge memory transport"
        });
    }
    async get(path, transport = {}) {
        const url = new URL(path, `${this.config.endpoint.replace(/\/+$/u, "")}/`);
        for (const [key, value] of Object.entries(transport.query ?? {}))
            url.searchParams.set(key, value);
        return this.request(url, { method: "GET", headers: transport.headers });
    }
    async post(path, body) {
        const url = new URL(path, `${this.config.endpoint.replace(/\/+$/u, "")}/`);
        return this.request(url, {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
        });
    }
    async request(url, init) {
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        if (this.config.token)
            headers.set("authorization", `Bearer ${this.config.token}`);
        const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(45_000) });
        const textValue = await response.text();
        const parsed = textValue.trim() ? JSON.parse(textValue) : null;
        if (!response.ok) {
            const body = objectValue(parsed);
            const nested = objectValue(body.error);
            throw new RuntimeHttpError(response.status, text(body.code) || text(nested.code), text(body.message) || text(nested.message) || `Memory request failed: ${response.status}`);
        }
        return parsed;
    }
}
class RuntimeHttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "RuntimeHttpError";
    }
}
function isV2ResumeConflict(error) {
    return error instanceof RuntimeHttpError && error.status === 409 &&
        (error.code === "l3_world_model_v2_session_not_open" || error.message === "l3_world_model_v2_session_not_open");
}
function runtimeEnvelope(source, sessionKey, userId, projectId, adapterId, profileId) {
    return {
        requestId: randomUUID(),
        adapterId,
        source,
        namespace: compact({ source, profileId, userId, sessionKey, projectId: projectId || undefined }),
    };
}
function envelopeGetTransport(envelope) {
    const query = { adapterId: envelope.adapterId, source: envelope.namespace.source };
    const headers = { "x-request-id": envelope.requestId };
    const pairs = [
        ["x-memmy-user-id", envelope.namespace.userId],
        ["x-memmy-project-id", envelope.namespace.projectId],
        ["x-memmy-profile-id", envelope.namespace.profileId],
        ["x-memmy-session-key", envelope.namespace.sessionKey],
    ];
    for (const [key, value] of pairs)
        if (value)
            headers[key] = value;
    return { query, headers };
}
async function canonicalWorkspaceRoot(value) {
    if (!value || !isAbsolute(value))
        return null;
    const canonical = await realpath(value).catch(() => "");
    if (!canonical)
        return null;
    const details = await stat(canonical).catch(() => null);
    if (!details?.isDirectory() || canonical === parse(canonical).root || canonical === await realpath(homedir()))
        return null;
    const observed = await lstat(canonical).catch(() => null);
    return observed?.isDirectory() && !observed.isSymbolicLink() ? canonical : null;
}
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
function objectValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function numberArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "number") : [];
}
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
async function readJson(url) {
    const content = await readFile(url, "utf8").catch(() => "{}");
    try {
        return JSON.parse(content);
    }
    catch {
        return {};
    }
}
