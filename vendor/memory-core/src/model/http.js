import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { assertMemoryNetworkTarget } from "../privacy/network-policy.js";
const logger = createMemoryLogger("model-http");
export class ModelHttpError extends Error {
    provider;
    httpStatus;
    errorCode;
    detail;
    actualModelContext;
    name = "ModelHttpError";
    constructor(message, provider, httpStatus, errorCode, detail, actualModelContext) {
        super(message);
        this.provider = provider;
        this.httpStatus = httpStatus;
        this.errorCode = errorCode;
        this.detail = detail;
        this.actualModelContext = actualModelContext;
    }
}
export async function postJsonWithRetry(input) {
    assertMemoryNetworkTarget(input.url, {
        allowRemote: input.allowRemote,
        purpose: input.operation ?? `model provider ${input.provider}`
    });
    let lastError;
    for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
            try {
                const response = await fetch(input.url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        ...(input.headers ?? {})
                    },
                    body: JSON.stringify(input.body),
                    signal: controller.signal
                });
                const text = await response.text();
                const failure = parseProviderFailure(text);
                if (!response.ok || failure.isBusinessError) {
                    throw new ModelHttpError(formatHttpFailure(input.provider, response, text), input.provider, response.status, failure.errorCode, failure.detail, input.actualModelContext);
                }
                return parseJsonResponse(input.provider, response, text);
            }
            finally {
                clearTimeout(timeout);
            }
        }
        catch (error) {
            lastError = error;
            if (attempt < input.maxRetries && isRetryableModelRequestError(error)) {
                const delayMs = Math.min(1_000 * Math.pow(2, attempt), 8_000);
                logger.warn("request.retry_scheduled", {
                    provider: input.provider,
                    operation: input.operation,
                    model: input.model,
                    endpoint: safeEndpoint(input.url),
                    attempt: attempt + 1,
                    maxAttempts: input.maxRetries + 1,
                    delayMs,
                    ...memoryErrorFields(error)
                });
                await sleep(delayMs);
                continue;
            }
            logger.error("request.failed", {
                provider: input.provider,
                operation: input.operation,
                model: input.model,
                endpoint: safeEndpoint(input.url),
                attempt: attempt + 1,
                maxAttempts: input.maxRetries + 1,
                ...memoryErrorFields(error)
            });
            break;
        }
    }
    const normalized = lastError instanceof Error ? lastError : new Error(String(lastError));
    if (input.actualModelContext && !("actualModelContext" in normalized)) {
        Object.assign(normalized, { actualModelContext: input.actualModelContext });
    }
    throw normalized;
}
export function trimTrailingSlash(value) {
    return value.replace(/\/+$/, "");
}
export function bearer(apiKey) {
    return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryableModelRequestError(error) {
    if (error instanceof ModelHttpError) {
        return error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500;
    }
    return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}
function clip(value, max) {
    return value.length <= max ? value : `${value.slice(0, max)}...`;
}
function parseJsonResponse(provider, response, text) {
    const trimmed = text.trim();
    if (!trimmed) {
        throw new Error(`${provider} HTTP ${response.status}: expected JSON but received an empty response`);
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const responseType = describeResponseType(response, trimmed);
        throw new Error(`${provider} HTTP ${response.status}: expected JSON but received ${responseType}; check the configured model endpoint`);
    }
}
function formatHttpFailure(provider, response, text) {
    const prefix = `${provider} HTTP ${response.status}`;
    const trimmed = text.trim();
    if (!trimmed) {
        return `${prefix}: empty response`;
    }
    if (looksLikeHtml(response, trimmed)) {
        return `${prefix}: endpoint returned HTML instead of JSON; check the configured model endpoint`;
    }
    const providerMessage = extractProviderErrorMessage(trimmed);
    return `${prefix}: ${clip(providerMessage ?? compact(trimmed), 800)}`;
}
function extractProviderErrorMessage(text) {
    return parseProviderFailure(text).message;
}
function parseProviderFailure(text) {
    try {
        const parsed = JSON.parse(text);
        const rawCode = parsed.error && typeof parsed.error === "object"
            ? parsed.error.code ?? parsed.code
            : parsed.code;
        const errorCode = typeof rawCode === "string" || typeof rawCode === "number"
            ? String(rawCode)
            : undefined;
        const normalizedCode = errorCode?.trim().toLowerCase();
        const isQuotaCode = normalizedCode === "40309";
        if (typeof parsed.error === "string" && parsed.error.trim()) {
            return { detail: parsed.error, errorCode, isBusinessError: true, message: parsed.error.trim() };
        }
        if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
            return {
                detail: parsed.error.message,
                errorCode,
                isBusinessError: true,
                message: parsed.error.message.trim() || undefined
            };
        }
        if (typeof parsed.message === "string" && parsed.message.trim()) {
            return {
                detail: parsed.message,
                errorCode,
                isBusinessError: isQuotaCode,
                message: parsed.message.trim()
            };
        }
        return { detail: text, errorCode, isBusinessError: isQuotaCode };
    }
    catch {
        return { detail: text, isBusinessError: false };
    }
}
function describeResponseType(response, text) {
    if (looksLikeHtml(response, text))
        return "HTML instead of a model API response";
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    return contentType ? `invalid JSON (${contentType})` : "invalid JSON";
}
function looksLikeHtml(response, text) {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    return contentType.includes("text/html") || /^\s*(?:<!doctype\s+html|<html)\b/i.test(text);
}
function compact(value) {
    return value.replace(/\s+/g, " ").trim();
}
function safeEndpoint(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    }
    catch {
        return value.split("?", 1)[0] ?? "<invalid-url>";
    }
}
