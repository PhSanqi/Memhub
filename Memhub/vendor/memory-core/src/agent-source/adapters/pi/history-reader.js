import { basename } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";
export async function* readPiHistory(filePath, signal) {
    let conversationId = basename(filePath, ".jsonl");
    let workspacePath = null;
    let lineNumber = 0;
    for await (const record of readJsonlObjects(filePath, signal)) {
        lineNumber += 1;
        if (record.type === "session") {
            conversationId = stringValue(record.id) ?? conversationId;
            workspacePath = stringValue(record.cwd);
            continue;
        }
        const message = extractPiMessage(record, conversationId, lineNumber, workspacePath);
        if (message) {
            yield message;
        }
    }
}
export function extractPiMessage(record, fallbackConversationId, lineNumber, fallbackWorkspacePath = null) {
    if (record.type !== "message") {
        return null;
    }
    const message = recordValue(record.message);
    const role = normalizeRole(message?.role);
    if (!message || !role) {
        return null;
    }
    const text = visibleText(message.content);
    if (!text) {
        return null;
    }
    const conversationId = stringValue(record.sessionId) ?? fallbackConversationId;
    const messageId = stringValue(record.id) ?? `${conversationId}:${lineNumber}`;
    const content = role === "tool"
        ? [`Tool: ${stringValue(message.toolName) ?? "tool"}`, text].join("\n\n")
        : text;
    return {
        messageId,
        conversationId,
        role,
        content,
        createdAt: normalizeTimestamp(record.timestamp ?? message.timestamp),
        workspacePath: stringValue(record.cwd) ?? fallbackWorkspacePath
    };
}
function visibleText(value) {
    if (typeof value === "string") {
        return value.trim() || null;
    }
    if (!Array.isArray(value)) {
        return null;
    }
    const parts = value.flatMap((item) => {
        const block = recordValue(item);
        return block?.type === "text" && typeof block.text === "string" && block.text.trim()
            ? [block.text.trim()]
            : [];
    });
    return parts.length > 0 ? parts.join("\n") : null;
}
function normalizeRole(value) {
    if (value === "user")
        return "user";
    if (value === "assistant")
        return "assistant";
    if (value === "toolResult")
        return "tool";
    return null;
}
function normalizeTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value > 10_000_000_000 ? value : value * 1000);
        return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
    }
    if (typeof value === "string") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
    }
    return new Date(0).toISOString();
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function recordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : null;
}
