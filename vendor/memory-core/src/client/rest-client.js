import { resolveTimeZone } from "../utils/time.js";
import { assertMemoryNetworkTarget } from "../privacy/network-policy.js";
export class MemoryRestClient {
    endpoint;
    token;
    headers;
    timeZone;
    constructor(options) {
        assertMemoryNetworkTarget(options.endpoint, {
            allowRemote: options.allowRemote,
            purpose: "memory REST client"
        });
        this.endpoint = options.endpoint.replace(/\/+$/, "");
        this.token = options.token;
        this.headers = options.headers ?? {};
        this.timeZone = resolveTimeZone(options.timeZone);
    }
    health() {
        return this.request("GET", "/api/v1/health");
    }
    reloadConfig(request = {}) {
        return this.request("POST", "/api/v1/admin/reload-config", request);
    }
    openSession(request) {
        return this.request("POST", "/api/v1/sessions/open", request);
    }
    closeSession(sessionId, request = {}) {
        return this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, request);
    }
    startTurn(request) {
        return this.request("POST", "/api/v1/turns/start", request);
    }
    completeTurn(turnId, request) {
        return this.request("POST", `/api/v1/turns/${encodeURIComponent(turnId)}/complete`, request);
    }
    search(request) {
        return this.request("POST", "/api/v1/memory/search", request);
    }
    addMemory(request) {
        return this.request("POST", "/api/v1/memory/add", request);
    }
    getMemory(id) {
        return this.request("GET", `/api/v1/memory/${encodeURIComponent(id)}`);
    }
    deleteMemory(id, request) {
        return this.request("DELETE", `/api/v1/memory/${encodeURIComponent(id)}`, request);
    }
    panelOverview(query = {}) {
        return this.request("GET", `/api/v1/panel/overview${queryString(query)}`);
    }
    panelAnalysis(query = {}) {
        return this.request("GET", `/api/v1/panel/analysis${queryString(query)}`);
    }
    panelItems(query = {}) {
        return this.request("GET", `/api/v1/panel/items${queryString(query)}`);
    }
    async request(method, path, body, requestHeaders = {}) {
        const response = await fetch(`${this.endpoint}${path}`, {
            method,
            headers: {
                ...this.headers,
                ...requestHeaders,
                "x-memmy-time-zone": this.timeZone,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : undefined;
        if (!response.ok) {
            throw new MemoryRestClientError(response.status, payload, text);
        }
        return payload;
    }
}
export class MemoryRestClientError extends Error {
    status;
    payload;
    rawBody;
    constructor(status, payload, rawBody) {
        super(`memory service HTTP ${status}: ${rawBody}`);
        this.status = status;
        this.payload = payload;
        this.rawBody = rawBody;
    }
}
function queryString(query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
            params.set(key, Array.isArray(value) ? value.join(",") : String(value));
        }
    }
    const rendered = params.toString();
    return rendered ? `?${rendered}` : "";
}
