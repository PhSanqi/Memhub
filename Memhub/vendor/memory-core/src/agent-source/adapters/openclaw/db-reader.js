/** Db reader module. */
import Database from "better-sqlite3";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
const SQLITE_ROW_YIELD_INTERVAL = 100;
/** Db reader module. */
export async function* readOpenclawDatabase(path) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        if (hasTable(db, "messages") && hasTable(db, "conversations")) {
            for await (const message of readConversationMessages(db)) {
                yield message;
            }
            return;
        }
        if (hasTable(db, "chunks")) {
            for await (const message of readMemoryChunks(db)) {
                yield message;
            }
        }
    }
    finally {
        db.close();
    }
}
async function* readConversationMessages(db) {
    const statement = db.prepare(`
      SELECT
        m.id AS message_id,
        m.conversation_id AS conversation_id,
        m.role AS role,
        m.content AS content,
        m.created_at AS created_at,
        c.workspace_path AS workspace_path,
        c.git_root AS git_root
      FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content IS NOT NULL
        AND m.content != ''
      ORDER BY m.conversation_id ASC, m.created_at ASC, m.id ASC
    `);
    let rows = 0;
    for (const row of statement.iterate()) {
        rows += 1;
        if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
        const message = toRawConversationMessage(row);
        if (message) {
            yield message;
        }
    }
}
async function* readMemoryChunks(db) {
    const columns = getTableColumns(db, "chunks");
    if (!hasColumns(columns, ["id", "session_key", "role", "content"])) {
        return;
    }
    const statement = db.prepare(buildMemoryChunksSql(columns));
    let rows = 0;
    for (const row of statement.iterate()) {
        rows += 1;
        if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
        const message = toRawMemoryChunkMessage(row);
        if (message) {
            yield message;
        }
    }
}
function toRawConversationMessage(row) {
    const role = normalizeConversationRole(row.role);
    if (!role) {
        return null;
    }
    return {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        role,
        content: row.content,
        createdAt: normalizeTimestamp(row.created_at),
        workspacePath: row.workspace_path,
        gitRoot: row.git_root,
        rawMeta: Object.freeze({ schemaKind: "conversation" })
    };
}
function toRawMemoryChunkMessage(row) {
    const role = normalizeMemoryRole(row.role);
    if (!role) {
        return null;
    }
    return {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        role,
        content: row.content,
        createdAt: normalizeTimestamp(row.created_at),
        workspacePath: null,
        gitRoot: null,
        rawMeta: Object.freeze({
            schemaKind: "memory",
            turnId: row.turn_id,
            seq: row.seq,
            kind: row.kind,
            summary: row.summary,
            taskId: row.task_id,
            owner: row.owner,
            dedupStatus: row.dedup_status
        })
    };
}
function normalizeConversationRole(role) {
    if (role === "user" || role === "assistant") {
        return role;
    }
    return null;
}
function normalizeMemoryRole(role) {
    if (role === "user" || role === "assistant" || role === "tool") {
        return role;
    }
    return null;
}
function normalizeTimestamp(value) {
    if (typeof value === "number") {
        const date = new Date(value > 10_000_000_000 ? value : value * 1000);
        return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        return normalizeTimestamp(Number(value));
    }
    const date = new Date(value ?? 0);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
function hasTable(db, tableName) {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
function getTableColumns(db, tableName) {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
    return new Set(rows.map((row) => row.name));
}
function hasColumns(columns, requiredColumns) {
    return requiredColumns.every((column) => columns.has(column));
}
function buildMemoryChunksSql(columns) {
    const where = [`${quoteIdentifier("content")} IS NOT NULL`, `${quoteIdentifier("content")} != ''`];
    if (columns.has("dedup_status")) {
        where.push(`(${quoteIdentifier("dedup_status")} IS NULL OR ${quoteIdentifier("dedup_status")} = 'active')`);
    }
    return `
    SELECT
      ${columnExpression(columns, "id", "message_id", "''")},
      ${columnExpression(columns, "session_key", "conversation_id", "''")},
      ${columnExpression(columns, "role", "role", "''")},
      ${columnExpression(columns, "content", "content", "''")},
      ${columnExpression(columns, "created_at", "created_at", columns.has("updated_at") ? quoteIdentifier("updated_at") : "0")},
      ${columnExpression(columns, "turn_id", "turn_id", "NULL")},
      ${columnExpression(columns, "seq", "seq", "NULL")},
      ${columnExpression(columns, "kind", "kind", "NULL")},
      ${columnExpression(columns, "summary", "summary", "NULL")},
      ${columnExpression(columns, "task_id", "task_id", "NULL")},
      ${columnExpression(columns, "owner", "owner", "NULL")},
      ${columnExpression(columns, "dedup_status", "dedup_status", "NULL")}
    FROM ${quoteIdentifier("chunks")}
    WHERE ${where.join(" AND ")}
    ORDER BY ${memoryChunkOrderBy(columns)}
  `;
}
function columnExpression(columns, columnName, alias, fallbackSql) {
    const expression = columns.has(columnName) ? quoteIdentifier(columnName) : fallbackSql;
    return `${expression} AS ${quoteIdentifier(alias)}`;
}
function memoryChunkOrderBy(columns) {
    const order = [quoteIdentifier("session_key")];
    if (columns.has("created_at")) {
        order.push(quoteIdentifier("created_at"));
    }
    if (columns.has("seq")) {
        order.push(quoteIdentifier("seq"));
    }
    order.push(quoteIdentifier("id"));
    return order.map((column) => `${column} ASC`).join(", ");
}
function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll("\"", "\"\"")}"`;
}
