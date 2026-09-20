import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
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
    const adapterId = input.adapterId || `memmy-${input.source}-adapter`;
    const profileId = input.profileId || "default";
    return openLegacyRuntimeSession(client, config, input, adapterId, profileId);
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
export async function closeRuntimeSession(session) {
    const client = new RuntimeHttpClient(session.config);
    await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/close`, { source: session.source });
}
export async function startRuntimeTurn(session, turnId, query) {
    const client = new RuntimeHttpClient(session.config);
    const body = { source: session.source, adapterId: session.adapterId, requestId: `${session.source}-start:${turnId}`, sessionId: session.sessionId, turnId, query };
    return objectValue(await client.post("/api/v1/turns/start", body));
}
export async function completeRuntimeTurn(session, input) {
    const client = new RuntimeHttpClient(session.config);
    const body = {
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
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
function objectValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
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
