import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const DEFAULT_TIMEOUT_MS = 5_000;
const EVENT_PATH = "/api/app/byok-token-usage/events";
const RUNTIME_TOKEN_HEADER = "x-memmy-local-token";
export function resolveDefaultRuntimeConfigPath() {
    return join(homedir(), ".memmy", "runtime.json");
}
export function extractModelTokenUsage(response) {
    const root = asRecord(response);
    const usage = firstRecord(root.usage, root.usageMetadata, root.usage_metadata);
    const promptDetails = firstRecord(usage.prompt_tokens_details, usage.promptTokensDetails, usage.input_tokens_details, usage.inputTokensDetails, usage.input_token_details, usage.inputTokenDetails);
    const inputTokens = nonNegativeInteger(firstNumber(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens, usage.promptTokenCount, usage.inputTokenCount));
    const outputTokens = nonNegativeInteger(firstNumber(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens, usage.candidatesTokenCount, usage.outputTokenCount));
    const cachedInputTokens = nonNegativeInteger(firstNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens, usage.cached_input_tokens, usage.cachedInputTokens, usage.cachedContentTokenCount, promptDetails.cached_tokens, promptDetails.cachedTokens, promptDetails.cache_read_input_tokens, promptDetails.cacheReadInputTokens));
    const cacheCreationInputTokens = nonNegativeInteger(firstNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens, usage.cache_write_input_tokens, usage.cacheWriteInputTokens, promptDetails.cache_creation_input_tokens, promptDetails.cacheCreationInputTokens, promptDetails.cache_write_input_tokens, promptDetails.cacheWriteInputTokens));
    const totalTokens = nonNegativeInteger(firstNumber(usage.total_tokens, usage.totalTokens, usage.totalTokenCount, inputTokens + outputTokens));
    return {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        totalTokens,
        rawUsage: usage
    };
}
export class HttpByokTokenUsageRecorder {
    runtimeConfig;
    runtimeConfigPath;
    timeoutMs;
    fetchImpl;
    constructor(options = {}) {
        const env = options.env ?? process.env;
        this.runtimeConfig = options.runtimeConfig;
        this.runtimeConfigPath = options.runtimeConfigPath ?? env.MEMMY_RUNTIME_CONFIG_PATH ?? resolveDefaultRuntimeConfigPath();
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    record(event) {
        const context = event.actualModelContext;
        if (!context || context.source !== "byok" || context.capability !== event.kind || isEmptyUsage(event.usage)) {
            return;
        }
        const runtime = this.runtimeConfig ?? readRuntimeConfig(this.runtimeConfigPath);
        if (!runtime) {
            return;
        }
        void this.postEvent(runtime, toByokTokenUsageEvent(event)).catch(() => undefined);
    }
    async postEvent(runtime, event) {
        const response = await this.fetchImpl(new URL(EVENT_PATH, runtime.baseUrl), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                [RUNTIME_TOKEN_HEADER]: runtime.localToken
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) {
            throw new Error(`BYOK token usage upload failed: ${response.status} ${response.statusText}`);
        }
    }
}
function toByokTokenUsageEvent(event) {
    const id = `byok_usage_${randomUUID()}`;
    return {
        id,
        kind: event.kind,
        source: "memory",
        operationId: `${event.operation}:${id}`,
        presetId: event.actualModelContext.presetId,
        provider: event.actualModelContext.provider,
        model: event.actualModelContext.model,
        capability: event.actualModelContext.capability,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
        cachedInputTokens: event.usage.cachedInputTokens,
        cacheCreationInputTokens: event.usage.cacheCreationInputTokens,
        metadata: {
            operation: event.operation,
            model: event.actualModelContext.model,
            ...event.metadata,
            provider: event.actualModelContext.provider
        },
        rawUsage: event.usage.rawUsage,
        createdAt: new Date().toISOString()
    };
}
function readRuntimeConfig(filePath) {
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        if (!isRecord(parsed)) {
            return null;
        }
        const baseUrl = optionalString(parsed.baseUrl);
        const localToken = optionalString(parsed.localToken);
        if (!baseUrl || !localToken) {
            return null;
        }
        return { baseUrl, localToken };
    }
    catch {
        return null;
    }
}
function isEmptyUsage(usage) {
    return usage.inputTokens + usage.outputTokens + usage.totalTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens === 0;
}
function firstRecord(...values) {
    for (const value of values) {
        if (isRecord(value)) {
            return value;
        }
    }
    return {};
}
function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}
function nonNegativeInteger(value) {
    if (value === undefined) {
        return 0;
    }
    return Math.max(0, Math.trunc(value));
}
function optionalString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
