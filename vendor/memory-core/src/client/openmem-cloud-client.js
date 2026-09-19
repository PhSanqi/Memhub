import { assertMemoryNetworkTarget } from "../privacy/network-policy.js";
export class OpenMemCloudClient {
    options;
    endpoint;
    fetchImpl;
    headers;
    constructor(options) {
        this.options = options;
        assertMemoryNetworkTarget(options.endpoint, {
            allowRemote: options.allowRemote,
            purpose: "OpenMem cloud client"
        });
        this.endpoint = options.endpoint.replace(/\/+$/, "");
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.headers = options.headers ?? {};
    }
    addMessage(request) {
        return this.post("/add/message", request);
    }
    addFeedback(request) {
        return this.post("/add/feedback", request);
    }
    async post(path, body) {
        const response = await this.fetchImpl(`${this.endpoint}${path}`, {
            method: "POST",
            headers: {
                ...this.headers,
                "content-type": "application/json",
                ...(this.options.apiKey ? { authorization: `Token ${this.options.apiKey}` } : {})
            },
            body: JSON.stringify(body)
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : undefined;
        if (!response.ok) {
            throw new OpenMemCloudClientError(response.status, payload, text);
        }
        return payload;
    }
}
export class OpenMemCloudClientError extends Error {
    status;
    payload;
    rawBody;
    constructor(status, payload, rawBody) {
        super(`OpenMem cloud HTTP ${status}: ${rawBody}`);
        this.status = status;
        this.payload = payload;
        this.rawBody = rawBody;
    }
}
export function openMemAddMessageFromTurnComplete(input) {
    const messages = [];
    const toolCalls = normalizeOpenMemToolCalls(input.request.toolCalls);
    if (input.request.query.trim()) {
        messages.push({
            role: "user",
            content: input.request.query
        });
    }
    if (input.request.answer.trim() || toolCalls.length) {
        messages.push({
            role: "assistant",
            content: input.request.answer.trim(),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        });
    }
    messages.push(...normalizeOpenMemToolResults(input.request.toolResults, toolCalls));
    return {
        user_id: input.userId,
        conversation_id: input.conversationId,
        messages,
        agent_id: input.agentId,
        app_id: input.appId,
        tags: distinct([...(input.tags ?? []), ...(input.request.tags ?? [])]),
        allow_knowledgebase_ids: input.allowKnowledgebaseIds,
        allow_public: input.allowPublic,
        async_mode: input.asyncMode,
        info: compactRecord({
            ...(input.info ?? {}),
            memory_layer: "L1",
            turn_id: input.turnId,
            episode_id: input.request.episodeId,
            source_memory_ids: normalizeStringArray(input.request.sourceMemoryIds),
            status: input.request.status
        })
    };
}
export function openMemFeedbackFromFeedback(input) {
    const magnitude = input.request.magnitude === undefined
        ? ""
        : ` magnitude=${input.request.magnitude}`;
    const feedbackContent = input.request.rationale?.trim() ||
        `${input.request.channel} ${input.request.polarity}${magnitude}`;
    return {
        user_id: input.userId,
        conversation_id: input.conversationId ?? input.request.sessionId,
        feedback_content: feedbackContent,
        agent_id: input.agentId,
        app_id: input.appId,
        feedback_time: input.feedbackTime,
        allow_knowledgebase_ids: input.allowKnowledgebaseIds,
        allow_public: input.allowPublic,
        info: compactRecord({
            ...(input.info ?? {}),
            memory_layer: "feedback",
            episode_id: input.request.episodeId,
            l1_memory_id: input.request.l1MemoryId,
            raw_turn_id: input.request.rawTurnId,
            recall_event_id: input.request.recallEventId,
            channel: input.request.channel,
            polarity: input.request.polarity,
            magnitude: input.request.magnitude,
            raw_payload: input.request.rawPayload
        })
    };
}
function stringifyJsonArgument(value) {
    if (typeof value === "string") {
        try {
            JSON.parse(value);
            return value;
        }
        catch {
            return JSON.stringify(value);
        }
    }
    return JSON.stringify(value ?? {});
}
function stringifyToolResult(value) {
    if (typeof value === "string")
        return value;
    if (isRecord(value) && typeof value.content === "string")
        return value.content;
    return JSON.stringify(value ?? {});
}
function toolCallIdFromResult(value) {
    if (!isRecord(value))
        return undefined;
    return stringField(value, "tool_call_id") ??
        stringField(value, "toolCallId") ??
        stringField(value, "callId") ??
        stringField(value, "id");
}
function normalizeOpenMemToolCalls(values) {
    return (Array.isArray(values) ? values : [])
        .map((value, index) => normalizeOpenMemToolCall(value, index))
        .filter((value) => Boolean(value));
}
function normalizeOpenMemToolCall(value, index) {
    if (!isRecord(value))
        return null;
    const fn = isRecord(value.function) ? value.function : {};
    const name = stringField(value, "name") ?? stringField(fn, "name");
    if (!name)
        return null;
    const rawArguments = firstDefined(value.input, value.args, value.arguments, fn.arguments, {});
    return {
        id: stringField(value, "id") ?? stringField(value, "tool_call_id") ?? stringField(value, "call_id") ?? `tool-call-${index + 1}`,
        type: "function",
        function: {
            name,
            arguments: stringifyJsonArgument(rawArguments)
        }
    };
}
function normalizeOpenMemToolResults(values, toolCalls) {
    return (Array.isArray(values) ? values : []).map((value, index) => ({
        role: "tool",
        tool_call_id: toolCallIdFromResult(value) ?? toolCalls[index]?.id ?? `tool-call-${index + 1}`,
        content: stringifyToolResult(value)
    }));
}
function normalizeStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const values = value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    return values.length ? values : undefined;
}
function firstDefined(...values) {
    return values.find((value) => value !== undefined);
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === "string" && value ? value : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compactRecord(input) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined &&
        (!Array.isArray(value) || value.length > 0)));
}
function distinct(values) {
    const out = [...new Set(values.filter(Boolean))];
    return out.length ? out : undefined;
}
