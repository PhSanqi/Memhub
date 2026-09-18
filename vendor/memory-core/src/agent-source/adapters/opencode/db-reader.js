/** Db reader module. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
const SQLITE_ROW_YIELD_INTERVAL = 100;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
/** Db reader module. */
export async function* readOpencodeDatabase(path) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        if (!hasTable(db, "message") || !hasTable(db, "part") || !hasTable(db, "session")) {
            return;
        }
        const messages = await readMessages(db);
        for (const message of messages) {
            yield message;
        }
    }
    finally {
        db.close();
    }
}
/** Streams OpenCode messages while retaining only the current message's parts. */
export async function* streamOpencodeDatabase(path) {
    const db = new Database(path, { readonly: true });
    try {
        if (!hasTable(db, "message") || !hasTable(db, "part") || !hasTable(db, "session"))
            return;
        const statement = db.prepare(`
      SELECT m.id AS message_id, m.session_id AS session_id, m.time_created AS message_time_created,
        m.data AS message_data, s.directory AS session_directory, p.id AS part_id,
        p.time_created AS part_time_created, p.data AS part_data
      FROM message m LEFT JOIN session s ON s.id = m.session_id LEFT JOIN part p ON p.message_id = m.id
      ORDER BY m.session_id ASC, m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC
    `);
        let current = null;
        let rows = 0;
        for (const row of statement.iterate()) {
            rows += 1;
            if (rows % SQLITE_ROW_YIELD_INTERVAL === 0)
                await yieldToEventLoop();
            if (!current || current.messageId !== row.message_id) {
                if (current?.contentParts.length)
                    yield toDatabaseMessage(current);
                current = Buffer.byteLength(row.message_data) <= MAX_RECORD_BYTES ? createAccumulator(row) : null;
            }
            if (!current || !row.part_data || !row.part_id || Buffer.byteLength(row.part_data) > MAX_RECORD_BYTES)
                continue;
            const text = getPartText(parseJson(row.part_data));
            if (!text)
                continue;
            current.partIds.push(row.part_id);
            current.contentParts.push(text);
        }
        if (current?.contentParts.length)
            yield toDatabaseMessage(current);
    }
    finally {
        db.close();
    }
}
async function readMessages(db) {
    const statement = db.prepare(`
    SELECT
      m.id AS message_id,
      m.session_id AS session_id,
      m.time_created AS message_time_created,
      m.data AS message_data,
      s.directory AS session_directory,
      p.id AS part_id,
      p.time_created AS part_time_created,
      p.data AS part_data
    FROM message m
    LEFT JOIN session s ON s.id = m.session_id
    LEFT JOIN part p ON p.message_id = m.id
    ORDER BY m.session_id ASC, m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC
  `);
    const accumulators = new Map();
    let rows = 0;
    for (const row of statement.iterate()) {
        rows += 1;
        if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
        const accumulator = getOrCreateAccumulator(accumulators, row);
        if (!accumulator || !row.part_data || !row.part_id || Buffer.byteLength(row.part_data) > MAX_RECORD_BYTES) {
            continue;
        }
        const text = getPartText(parseJson(row.part_data));
        if (!text) {
            continue;
        }
        accumulator.partIds.push(row.part_id);
        accumulator.contentParts.push(text);
    }
    return [...accumulators.values()]
        .filter((message) => message.contentParts.length > 0)
        .map((message) => ({
        messageId: message.messageId,
        conversationId: message.conversationId,
        role: message.role,
        content: message.contentParts.join("\n"),
        createdAt: message.createdAt,
        workspacePath: message.workspacePath,
        gitRoot: message.gitRoot,
        rawMeta: Object.freeze({
            opencodePartIds: message.partIds
        })
    }));
}
function getOrCreateAccumulator(accumulators, row) {
    if (Buffer.byteLength(row.message_data) > MAX_RECORD_BYTES)
        return null;
    const existing = accumulators.get(row.message_id);
    if (existing) {
        return existing;
    }
    const messageData = parseJson(row.message_data);
    if (!isRecord(messageData)) {
        return null;
    }
    const role = normalizeRole(messageData.role);
    if (!role) {
        return null;
    }
    const workspacePath = getNestedString(messageData, "path", "cwd") ?? row.session_directory;
    const explicitRoot = getNestedString(messageData, "path", "root");
    const gitRoot = explicitRoot && explicitRoot !== "/" ? explicitRoot : workspacePath ? findGitRoot(workspacePath) : null;
    const accumulator = createAccumulator(row);
    if (!accumulator)
        return null;
    accumulators.set(row.message_id, accumulator);
    return accumulator;
}
function createAccumulator(row) {
    const messageData = parseJson(row.message_data);
    if (!isRecord(messageData))
        return null;
    const role = normalizeRole(messageData.role);
    if (!role)
        return null;
    const workspacePath = getNestedString(messageData, "path", "cwd") ?? row.session_directory;
    const explicitRoot = getNestedString(messageData, "path", "root");
    const gitRoot = explicitRoot && explicitRoot !== "/" ? explicitRoot : workspacePath ? findGitRoot(workspacePath) : null;
    return {
        messageId: row.message_id,
        conversationId: row.session_id,
        role,
        createdAt: normalizeTimestamp(getNestedNumber(messageData, "time", "created") ?? row.message_time_created),
        workspacePath,
        gitRoot,
        partIds: [],
        contentParts: []
    };
}
function toDatabaseMessage(message) {
    return {
        messageId: message.messageId,
        conversationId: message.conversationId,
        role: message.role,
        content: message.contentParts.join("\n"),
        createdAt: message.createdAt,
        workspacePath: message.workspacePath,
        gitRoot: message.gitRoot,
        rawMeta: Object.freeze({ opencodePartIds: message.partIds })
    };
}
function getPartText(partData) {
    if (!isRecord(partData) || partData.type !== "text") {
        return null;
    }
    return getString(partData.text);
}
function normalizeRole(role) {
    if (role === "user" || role === "assistant") {
        return role;
    }
    return null;
}
function normalizeTimestamp(timestamp) {
    return new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000).toISOString();
}
function findGitRoot(workspacePath) {
    let current = workspacePath;
    while (current !== dirname(current)) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }
        current = dirname(current);
    }
    return existsSync(join(current, ".git")) ? current : null;
}
function parseJson(input) {
    try {
        return JSON.parse(input);
    }
    catch {
        return null;
    }
}
function hasTable(db, tableName) {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
function getNestedString(record, parentKey, childKey) {
    const parent = record[parentKey];
    if (!isRecord(parent)) {
        return null;
    }
    return getString(parent[childKey]);
}
function getNestedNumber(record, parentKey, childKey) {
    const parent = record[parentKey];
    if (!isRecord(parent)) {
        return null;
    }
    const value = parent[childKey];
    return typeof value === "number" ? value : null;
}
function getString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
