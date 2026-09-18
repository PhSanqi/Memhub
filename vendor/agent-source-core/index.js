import { createHash } from "node:crypto";
export function compareMessageOrder(left, right) {
    return left.conversationId.localeCompare(right.conversationId)
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.messageId.localeCompare(right.messageId)
        || (left.ordinal ?? 0) - (right.ordinal ?? 0);
}
export function compareCursor(left, right) {
    return left.conversationId.localeCompare(right.conversationId)
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.messageId.localeCompare(right.messageId)
        || (left.ordinal ?? 0) - right.ordinal;
}
export async function* orderedTurns(messages) {
    let current = [];
    let conversationId = "";
    let turnIndex = 0;
    for await (const message of messages) {
        if (message.conversationId !== conversationId) {
            if (isCompleteTurn(current))
                yield { sourceId: current[0].sourceId, conversationId, turnIndex, messages: current };
            current = [];
            conversationId = message.conversationId;
            turnIndex = 0;
        }
        if (message.role === "user" && current.length > 0) {
            if (isCompleteTurn(current))
                yield { sourceId: current[0].sourceId, conversationId, turnIndex, messages: current };
            turnIndex += 1;
            current = [];
        }
        current.push(message);
    }
    if (isCompleteTurn(current))
        yield { sourceId: current[0].sourceId, conversationId, turnIndex, messages: current };
}
export function isCompleteTurn(messages) {
    const first = messages[0];
    const last = messages[messages.length - 1];
    return first?.role === "user" && Boolean(first.content.trim())
        && last?.role === "assistant" && Boolean(last.content.trim());
}
export function renderMessageContent(message) {
    if (message.role !== "tool" || /^Tool:\s*/im.test(message.content))
        return message.content;
    const toolName = stringMeta(message.rawMeta, "toolName") ?? stringMeta(message.rawMeta, "hermesToolName");
    const callId = stringMeta(message.rawMeta, "toolCallId") ?? stringMeta(message.rawMeta, "hermesToolCallId");
    return [toolName ? `Tool: ${toolName}` : undefined, callId ? `Call ID: ${callId}` : undefined, message.content]
        .filter(Boolean).join("\n\n");
}
export function renderTurn(messages) {
    return messages.map((message) => `## ${message.role}\n\n${renderMessageContent(message)}`).join("\n\n");
}
export function conversationContentHash(messages) {
    const hash = createHash("sha256");
    hash.update("[");
    let first = true;
    for (const message of messages) {
        if (!first)
            hash.update(",");
        first = false;
        hash.update(JSON.stringify({
            messageId: message.messageId,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            toolName: hashMetaString(message.rawMeta, "toolName") ?? hashMetaString(message.rawMeta, "hermesToolName"),
            toolCallId: hashMetaString(message.rawMeta, "toolCallId") ?? hashMetaString(message.rawMeta, "hermesToolCallId")
        }));
    }
    hash.update("]");
    return hash.digest("hex");
}
export function stableTurnIdentity(turn) {
    const firstUser = turn.messages.find((message) => message.role === "user");
    if (!firstUser)
        throw new Error("turn is missing user message");
    return `${turn.sourceId}::${turn.conversationId}::${firstUser.messageId}`;
}
/** Preserves the pre-staging idempotency key for an unsplit turn. */
export function legacyTurnRequestId(turn) {
    const first = turn.messages[0];
    if (!first)
        throw new Error("turn is empty");
    return createHash("sha256").update([stableTurnIdentity(turn), first.createdAt, renderTurn(turn.messages)].join("\u0000")).digest("hex");
}
/** Preserves the pre-staging stable turn id for an unsplit turn. */
export function legacyTurnId(turn) {
    return `${turn.sourceId}:${createHash("sha256").update(stableTurnIdentity(turn)).digest("hex").slice(0, 24)}`;
}
/** Raw UTF-8 content limit; JSON escaping has a separate transport budget. */
export const TURN_CONTENT_MAX_BYTES = 512 * 1024;
const TURN_CONTENT_MAX_JSON_BYTES = 1024 * 1024;
/**
 * Renders a whole turn as one memory body. Agent-source scans deliberately keep
 * one turn == one memory: splitting an agentic turn fans a single exchange out
 * into hundreds of near-empty tool-call fragments. Oversized turns are clipped
 * on a UTF-8 boundary instead so the add-memory request stays under the wire
 * limit without inventing extra memories.
 */
export function renderTurnClipped(messages, maxBytes = TURN_CONTENT_MAX_BYTES) {
    const content = renderTurn(messages);
    const bytes = Buffer.byteLength(content);
    if (bytes <= maxBytes && jsonContentBytes(content) + 2 <= TURN_CONTENT_MAX_JSON_BYTES)
        return content;
    const marker = (omitted) => `\n\n[... truncated ${omitted} bytes of tool output ...]`;
    // Reserving the largest possible omission count also bounds the final marker.
    const reservedMarker = marker(bytes);
    const markerBytes = Buffer.byteLength(reservedMarker);
    const rawBudget = Math.max(0, maxBytes);
    if (rawBudget <= markerBytes)
        return clipUtf8(reservedMarker, rawBudget, TURN_CONTENT_MAX_JSON_BYTES - 2);
    const prefix = clipUtf8(content, rawBudget - markerBytes, TURN_CONTENT_MAX_JSON_BYTES - 2 - jsonContentBytes(reservedMarker));
    return `${prefix}${marker(bytes - Buffer.byteLength(prefix))}`;
}
function jsonContentBytes(value) {
    return Buffer.byteLength(JSON.stringify(value)) - 2;
}
function clipUtf8(value, maxBytes, maxJsonBytes) {
    let bytes = 0;
    let jsonBytes = 0;
    let end = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character);
        const characterJsonBytes = jsonContentBytes(character);
        if (bytes + characterBytes > maxBytes || jsonBytes + characterJsonBytes > maxJsonBytes)
            break;
        bytes += characterBytes;
        jsonBytes += characterJsonBytes;
        end += character.length;
    }
    return value.slice(0, end);
}
export function estimateTokens(value) { return Math.ceil(value.length / 4); }
function stringMeta(meta, key) {
    const value = meta[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function hashMetaString(meta, key) {
    const value = meta[key];
    return typeof value === "string" ? value : undefined;
}
//# sourceMappingURL=index.js.map
