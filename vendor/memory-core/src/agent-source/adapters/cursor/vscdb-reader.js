/** Vscdb reader module. */
import Database from "better-sqlite3";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
const SQLITE_ROW_YIELD_INTERVAL = 100;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
/** Vscdb reader module. */
export async function* readCursorVscdb(path) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const messages = [...(await readItemTableMessages(db)), ...(await readCursorDiskKvMessages(db))].sort(compareRawCursorMessages);
        for (const message of messages) {
            yield message;
        }
    }
    finally {
        db.close();
    }
}
/** Streams Cursor rows without building a database-wide message array. */
export async function* streamCursorVscdb(path) {
    const db = new Database(path, { readonly: true });
    try {
        if (hasTable(db, "ItemTable")) {
            const statement = db.prepare("SELECT key, value FROM ItemTable WHERE value IS NOT NULL ORDER BY key ASC");
            let rows = 0;
            for (const row of statement.iterate()) {
                rows += 1;
                if (rows % SQLITE_ROW_YIELD_INTERVAL === 0)
                    await yieldToEventLoop();
                if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES)
                    continue;
                for (const message of extractMessagesFromItemRow(row))
                    yield message;
            }
        }
        if (hasTable(db, "cursorDiskKV")) {
            const statement = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value IS NOT NULL ORDER BY key ASC");
            let rows = 0;
            for (const row of statement.iterate()) {
                rows += 1;
                if (rows % SQLITE_ROW_YIELD_INTERVAL === 0)
                    await yieldToEventLoop();
                if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES)
                    continue;
                const message = extractMessageFromBubbleRow(row);
                if (message)
                    yield message;
            }
        }
    }
    finally {
        db.close();
    }
}
/** Reads read item table messages. */
async function readItemTableMessages(db) {
    if (!hasTable(db, "ItemTable")) {
        return [];
    }
    const statement = db.prepare("SELECT key, value FROM ItemTable WHERE value IS NOT NULL ORDER BY key ASC");
    const messages = [];
    let rows = 0;
    for (const row of statement.iterate()) {
        rows += 1;
        if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
        if (Buffer.byteLength(row.value) <= MAX_RECORD_BYTES)
            messages.push(...extractMessagesFromItemRow(row));
    }
    return messages;
}
/** Reads read cursor disk kv messages. */
async function readCursorDiskKvMessages(db) {
    if (!hasTable(db, "cursorDiskKV")) {
        return [];
    }
    const statement = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value IS NOT NULL ORDER BY key ASC");
    const messages = [];
    let rows = 0;
    for (const row of statement.iterate()) {
        rows += 1;
        if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
        if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES)
            continue;
        const message = extractMessageFromBubbleRow(row);
        if (message) {
            messages.push(message);
        }
    }
    return messages;
}
/** Handles extract messages from item row. */
function extractMessagesFromItemRow(row) {
    const parsed = parseJson(row.value);
    const container = toMessageContainer(row.key, parsed);
    if (!container) {
        return [];
    }
    return container.messages.flatMap((message, index) => {
        const parsedMessage = toRawCursorMessage(container.conversationId, row.key, index, message);
        return parsedMessage ? [parsedMessage] : [];
    });
}
/** Handles extract message from bubble row. */
function extractMessageFromBubbleRow(row) {
    const parsed = parseJson(row.value);
    if (!isRecord(parsed)) {
        return null;
    }
    const keyParts = parseBubbleKey(row.key);
    if (!keyParts) {
        return null;
    }
    return toRawCursorBubbleMessage(keyParts.conversationId, row.key, keyParts.bubbleId, parsed);
}
/** Handles to message container. */
function toMessageContainer(fallbackConversationId, value) {
    if (Array.isArray(value)) {
        return {
            conversationId: fallbackConversationId,
            messages: value.filter(isRecord)
        };
    }
    if (!isRecord(value)) {
        return null;
    }
    const messages = value.messages;
    if (!Array.isArray(messages)) {
        return null;
    }
    return {
        conversationId: typeof value.conversationId === "string" ? value.conversationId : fallbackConversationId,
        messages: messages.filter(isRecord)
    };
}
/** Handles to raw cursor message. */
function toRawCursorMessage(conversationId, rowKey, index, message) {
    const content = getMessageContent(message);
    const role = normalizeRole(message.role);
    if (!content || !role) {
        return null;
    }
    return {
        messageId: getString(message.messageId) ?? getString(message.id) ?? `${conversationId}:${index}`,
        conversationId,
        role,
        content,
        createdAt: normalizeTimestamp(message.createdAt ?? message.timestamp),
        rawMeta: Object.freeze({
            cursorItemKey: rowKey,
            cursorMessageIndex: index
        })
    };
}
/**
 * Converts a Cursor bubble object into a RawCursorMessage.
 *
 * @param conversationId composer conversation id.
 * @param rowKey cursorDiskKV key.
 * @param fallbackBubbleId The bubble id from the key.
 * @param bubble Unknown bubble object.
 * @returns A usable message, or null when required fields are missing.
 */
function toRawCursorBubbleMessage(conversationId, rowKey, fallbackBubbleId, bubble) {
    const content = getString(bubble.text);
    const role = normalizeBubbleRole(bubble.type);
    if (!content || !role) {
        return null;
    }
    const bubbleId = getString(bubble.bubbleId) ?? fallbackBubbleId;
    return {
        messageId: bubbleId,
        conversationId,
        role,
        content,
        createdAt: normalizeTimestamp(bubble.createdAt ?? bubble.timestamp),
        rawMeta: Object.freeze({
            cursorDiskKvKey: rowKey,
            cursorBubbleId: bubbleId,
            cursorBubbleType: bubble.type
        })
    };
}
/**
 * Parses the message body.
 *
 * @param message Unknown message object.
 * @returns The text content, or null when absent.
 */
function getMessageContent(message) {
    return getString(message.content) ?? getString(message.text);
}
/**
 * Normalizes the message role.
 *
 * @param role Unknown role field.
 * @returns A unified role, or null when it cannot be recognized.
 */
function normalizeRole(role) {
    if (role === "user" || role === "assistant" || role === "tool" || role === "system") {
        return role;
    }
    return null;
}
/**
 * Normalizes the Cursor bubble type.
 *
 * @param type Cursor bubble type.
 * @returns A unified role, or null when it cannot be recognized.
 */
function normalizeBubbleRole(type) {
    if (type === 1) {
        return "user";
    }
    if (type === 2) {
        return "assistant";
    }
    return null;
}
/**
 * Normalizes a timestamp.
 *
 * @param timestamp A string or millisecond timestamp.
 * @returns An ISO 8601 time.
 */
function normalizeTimestamp(timestamp) {
    if (typeof timestamp === "string") {
        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
    }
    if (typeof timestamp === "number") {
        return new Date(timestamp).toISOString();
    }
    return new Date(0).toISOString();
}
/**
 * JSON parsing helper.
 *
 * @param input SQLite value text.
 * @returns The parsed unknown value, or null on failure.
 */
function parseJson(input) {
    try {
        return JSON.parse(input);
    }
    catch {
        return null;
    }
}
/**
 * Parses a cursorDiskKV bubble key.
 *
 * @param key cursorDiskKV key.
 * @returns The composer conversation id and bubble id.
 */
function parseBubbleKey(key) {
    const parts = key.split(":");
    if (parts.length !== 3 || parts[0] !== "bubbleId" || !parts[1] || !parts[2]) {
        return null;
    }
    return {
        conversationId: parts[1],
        bubbleId: parts[2]
    };
}
/**
 * Determines whether a SQLite table exists.
 *
 * @param db SQLite connection.
 * @param tableName Table name.
 * @returns true when the table exists.
 */
function hasTable(db, tableName) {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
/**
 * Sorts raw messages so that messages in the same conversation stay contiguous.
 *
 * @param left Left-hand message.
 * @param right Right-hand message.
 * @returns The Array.sort comparison result.
 */
function compareRawCursorMessages(left, right) {
    return (left.conversationId.localeCompare(right.conversationId) ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.messageId.localeCompare(right.messageId));
}
/**
 * String type guard.
 *
 * @param value Unknown value.
 * @returns The string, or null.
 */
function getString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
/**
 * Plain-object type guard.
 *
 * @param value Unknown value.
 * @returns Whether it is an indexable record.
 */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
