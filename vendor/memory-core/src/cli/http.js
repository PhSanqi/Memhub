import { DEFAULT_MEMORY_URL, loadCliMemoryConfig } from "./config.js";
export async function sendRequest(request, options = {}) {
    const fetchImpl = options.fetch ?? fetch;
    const baseUrl = resolveBaseUrl(options);
    const url = new URL(withApiPrefix(request.path), baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
        if (value !== undefined && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }
    const token = resolveToken(options);
    const headers = {
        ...(options.headers ?? {})
    };
    if (request.body !== undefined) {
        headers["content-type"] = "application/json";
    }
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const payload = contentType.includes("application/json") && text.trim()
        ? JSON.parse(text)
        : text;
    if (!response.ok) {
        const message = errorMessage(payload) ?? `HTTP ${response.status}`;
        throw new Error(message);
    }
    return payload;
}
export function withApiPrefix(path) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized.startsWith("/api/v1/") || normalized === "/api/v1") {
        return normalized;
    }
    return `/api/v1${normalized}`;
}
function resolveBaseUrl(options) {
    if (options.url) {
        return options.url;
    }
    const { config } = loadCliMemoryConfig(options.configPath);
    return config.endpoint ?? DEFAULT_MEMORY_URL;
}
function resolveToken(options) {
    if (options.token) {
        return options.token;
    }
    const { config } = loadCliMemoryConfig(options.configPath);
    return config.token;
}
function errorMessage(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload;
        const error = record.error;
        if (error && typeof error === "object" && !Array.isArray(error)) {
            const message = error.message;
            if (typeof message === "string")
                return message;
        }
    }
    if (typeof payload === "string" && payload.trim()) {
        return payload;
    }
    return undefined;
}
