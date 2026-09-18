import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { stableHash } from "../utils/id.js";
import { bearer, postJsonWithRetry, trimTrailingSlash } from "./http.js";
import { aggregateOpenAiEmbeddingVectors, planOpenAiEmbeddingInputs } from "./openai-embedding-inputs.js";
import { HttpByokTokenUsageRecorder, extractModelTokenUsage } from "./token-usage.js";
const logger = createMemoryLogger("embedding");
const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDED_EMBEDDING_MODEL_ROOT = "embedding-models";
let localExtractorPromise = null;
let localExtractorModel = null;
export function createEmbedder(config) {
    return new HttpEmbedder(config);
}
class HttpEmbedder {
    config;
    cache = new Map();
    lastOkAt;
    lastError;
    usageRecorder = new HttpByokTokenUsageRecorder();
    constructor(config) {
        this.config = config;
    }
    isRemote() {
        return this.config.provider !== "local";
    }
    async embedOne(text, role = "document") {
        const [vector] = await this.embed([text], role);
        if (!vector) {
            throw new Error(`${this.config.provider} embedding provider returned no vector`);
        }
        return vector;
    }
    async embed(texts, role = "document") {
        if (this.config.selectionError) {
            throw Object.assign(new Error("Assigned embedding model is unavailable"), {
                code: this.config.selectionError,
                actualModelContext: this.config.actualModelContext
            });
        }
        if (texts.length === 0)
            return [];
        const out = new Array(texts.length);
        const missing = [];
        for (let index = 0; index < texts.length; index += 1) {
            const text = texts[index] ?? "";
            const key = this.cacheKey(text, role);
            const cached = this.config.cache ? this.cache.get(key) : undefined;
            if (cached) {
                out[index] = cached;
            }
            else {
                missing.push({ text, index });
            }
        }
        if (missing.length > 0) {
            const vectors = this.isRemote()
                ? await this.embedRemote(missing.map((item) => item.text), role)
                : await this.embedLocal(missing.map((item) => item.text), role);
            for (let index = 0; index < missing.length; index += 1) {
                const item = missing[index];
                const rawVector = vectors[index];
                if (!rawVector) {
                    throw new Error(`${this.config.provider} embedding row ${index} is missing vector`);
                }
                const vector = this.postProcess(rawVector);
                out[item.index] = vector;
                if (this.config.cache) {
                    this.cache.set(this.cacheKey(item.text, role), vector);
                }
            }
        }
        return out;
    }
    status() {
        return {
            provider: this.config.provider,
            model: this.config.model,
            configured: this.isRemote()
                ? Boolean(this.config.model && (this.config.apiKey || this.config.endpoint))
                : Boolean(this.config.model),
            remote: this.isRemote(),
            lastOkAt: this.lastOkAt,
            lastError: this.lastError
        };
    }
    async embedRemote(texts, role) {
        const startedAt = Date.now();
        const fields = {
            provider: this.config.provider,
            model: this.config.model,
            role,
            batchSize: texts.length
        };
        logger.debug("request.started", fields);
        try {
            const vectors = await this.embedRemoteOnce(texts, role);
            this.lastOkAt = new Date().toISOString();
            this.lastError = undefined;
            logger.info("request.succeeded", { ...fields, durationMs: Date.now() - startedAt });
            return vectors;
        }
        catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            logger.error("request.failed", {
                ...fields,
                durationMs: Date.now() - startedAt,
                ...memoryErrorFields(error)
            });
            throw error;
        }
    }
    async embedLocal(texts, role) {
        const startedAt = Date.now();
        const fields = {
            provider: this.config.provider,
            model: this.config.model,
            role,
            batchSize: texts.length
        };
        logger.debug("request.started", fields);
        try {
            const model = this.config.model || DEFAULT_LOCAL_EMBEDDING_MODEL;
            const extractor = await ensureLocalExtractor(model);
            const vectors = [];
            for (const text of texts) {
                const result = await extractor(text, { pooling: "mean", normalize: false });
                if (!result.data) {
                    throw new Error("local embedding extractor returned no data");
                }
                vectors.push(Array.from(result.data));
            }
            this.lastOkAt = new Date().toISOString();
            this.lastError = undefined;
            logger.info("request.succeeded", { ...fields, durationMs: Date.now() - startedAt });
            return vectors;
        }
        catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            logger.error("request.failed", {
                ...fields,
                durationMs: Date.now() - startedAt,
                ...memoryErrorFields(error)
            });
            throw error;
        }
    }
    embedRemoteOnce(texts, role) {
        switch (this.config.provider) {
            case "openai_compatible":
                return this.embedOpenAiCompatible(texts, role);
            case "gemini":
                return this.embedGemini(texts, role);
            case "cohere":
                return this.embedCohere(texts, role);
            case "voyage":
                return this.embedOpenAiShape(texts, "voyage", this.config.endpoint || "https://api.voyageai.com/v1/embeddings", role);
            case "mistral":
                return this.embedOpenAiShape(texts, "mistral", this.config.endpoint || "https://api.mistral.ai/v1/embeddings", role);
            case "local":
                throw new Error("local embedding provider must use the local extractor");
        }
    }
    async embedOpenAiCompatible(texts, role) {
        const base = trimTrailingSlash(this.config.endpoint || "https://api.openai.com/v1");
        const url = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
        return this.embedOpenAiShape(texts, "openai_compatible", url, role);
    }
    async embedOpenAiShape(texts, provider, url, role) {
        if (!this.config.apiKey && !this.config.endpoint) {
            throw new Error(`${provider} embedding provider requires apiKey or endpoint`);
        }
        const plan = provider === "openai_compatible"
            ? planOpenAiEmbeddingInputs(texts, this.config.model, this.config.maxInputTokens)
            : null;
        if (!plan)
            return this.requestOpenAiShape(texts, provider, url, role);
        const chunkVectors = [];
        for (const batch of plan.batches) {
            chunkVectors.push(...await this.requestOpenAiShape(batch.map((chunk) => chunk.input), provider, url, role));
        }
        return aggregateOpenAiEmbeddingVectors(plan, chunkVectors);
    }
    async requestOpenAiShape(inputs, provider, url, role) {
        const response = await postJsonWithRetry({
            actualModelContext: this.config.actualModelContext,
            provider: this.config.sourceProvider ?? provider,
            operation: `embedding.${role}`,
            model: this.config.model,
            url,
            headers: {
                ...bearer(this.config.apiKey),
                ...(this.config.extraHeaders ?? {})
            },
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries,
            body: {
                model: this.config.model,
                input: inputs,
                ...(this.config.extraBody ?? {})
            }
        });
        const vectors = validateVectors(provider, response.data?.map((row) => row.embedding), inputs.length);
        this.recordEmbeddingUsage(response, provider, role);
        return vectors;
    }
    async embedGemini(texts, role) {
        if (!this.config.apiKey) {
            throw new Error("gemini embedding provider requires apiKey");
        }
        const base = trimTrailingSlash(this.config.endpoint || "https://generativelanguage.googleapis.com/v1beta");
        const model = this.config.model || "text-embedding-004";
        const url = `${base}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(this.config.apiKey)}`;
        const response = await postJsonWithRetry({
            actualModelContext: this.config.actualModelContext,
            provider: "gemini",
            operation: `embedding.${role}`,
            model,
            url,
            headers: this.config.extraHeaders,
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries,
            body: {
                requests: texts.map((text) => ({
                    model: `models/${model}`,
                    content: { parts: [{ text }] }
                })),
                ...(this.config.extraBody ?? {})
            }
        });
        const vectors = validateVectors("gemini", response.embeddings?.map((row) => row.values), texts.length);
        this.recordEmbeddingUsage(response, "gemini", role);
        return vectors;
    }
    async embedCohere(texts, role) {
        if (!this.config.apiKey) {
            throw new Error("cohere embedding provider requires apiKey");
        }
        const url = this.config.endpoint || "https://api.cohere.com/v2/embed";
        const response = await postJsonWithRetry({
            actualModelContext: this.config.actualModelContext,
            provider: "cohere",
            operation: `embedding.${role}`,
            model: this.config.model || "embed-v4.0",
            url,
            headers: {
                ...bearer(this.config.apiKey),
                ...(this.config.extraHeaders ?? {})
            },
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries,
            body: {
                model: this.config.model || "embed-v4.0",
                texts,
                input_type: role === "query" ? "search_query" : "search_document",
                embedding_types: ["float"],
                ...(this.config.extraBody ?? {})
            }
        });
        const vectors = Array.isArray(response.embeddings)
            ? response.embeddings
            : response.embeddings?.float;
        const validated = validateVectors("cohere", vectors, texts.length);
        this.recordEmbeddingUsage(cohereUsagePayload(response), "cohere", role);
        return validated;
    }
    postProcess(vector) {
        if (!this.config.normalize)
            return vector;
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return norm > 0 ? vector.map((value) => value / norm) : vector;
    }
    cacheKey(text, role) {
        return stableHash(`${this.config.provider}:${this.config.model}:${role}:${text}`);
    }
    recordEmbeddingUsage(response, provider, role) {
        this.usageRecorder.record({
            kind: "embedding",
            operation: `embedding.${role}`,
            provider,
            model: this.config.model,
            endpoint: this.config.endpoint,
            actualModelContext: this.config.actualModelContext,
            usage: extractModelTokenUsage(response),
            metadata: { role }
        });
    }
}
async function ensureLocalExtractor(model) {
    if (localExtractorPromise && localExtractorModel === model) {
        return localExtractorPromise;
    }
    localExtractorModel = model;
    localExtractorPromise = (async () => {
        const mod = await import("@huggingface/transformers");
        const transformers = mod;
        transformers.env.cacheDir = join(homedir(), ".memmy", "memory-service", "model-cache");
        transformers.env.allowLocalModels = true;
        transformers.env.allowRemoteModels = true;
        const pipelineOptions = {
            dtype: "q8",
            device: "cpu"
        };
        const embeddedModelRoot = resolveEmbeddedEmbeddingModelRoot(model);
        if (embeddedModelRoot) {
            transformers.env.localModelPath = embeddedModelRoot;
            transformers.env.allowRemoteModels = false;
            pipelineOptions.local_files_only = true;
        }
        const pipeline = transformers.pipeline;
        return await pipeline("feature-extraction", model, pipelineOptions);
    })().catch((error) => {
        localExtractorPromise = null;
        throw error;
    });
    return localExtractorPromise;
}
function resolveEmbeddedEmbeddingModelRoot(model) {
    for (const root of candidateEmbeddedEmbeddingModelRoots()) {
        if (existsSync(join(root, model))) {
            return root;
        }
    }
    return null;
}
function candidateEmbeddedEmbeddingModelRoots() {
    const roots = [];
    const explicitRoot = process.env.MEMMY_EMBEDDING_MODEL_ROOT?.trim();
    if (explicitRoot) {
        roots.push(explicitRoot);
    }
    const resourcesPath = process.resourcesPath;
    if (resourcesPath) {
        roots.push(join(resourcesPath, EMBEDDED_EMBEDDING_MODEL_ROOT));
    }
    return roots;
}
function cohereUsagePayload(response) {
    const billedUnits = response.meta?.billed_units;
    if (!billedUnits) {
        return response;
    }
    const inputTokens = billedUnits.input_tokens ?? 0;
    const outputTokens = billedUnits.output_tokens ?? 0;
    return {
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens
        }
    };
}
function validateVectors(provider, vectors, expected) {
    if (!vectors || vectors.length !== expected) {
        throw new Error(`${provider} returned ${vectors?.length ?? 0} embeddings for ${expected} inputs`);
    }
    return vectors.map((vector, index) => {
        if (!Array.isArray(vector)) {
            throw new Error(`${provider} embedding row ${index} is missing vector`);
        }
        return vector;
    });
}
