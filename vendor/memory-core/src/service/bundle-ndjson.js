import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { canonicalJson } from "../contracts/index.js";
import { BUNDLE_TABLES, redactBundleRow, serializeBundleRow } from "../storage/repositories.js";
export const NDJSON_BUNDLE_FORMAT = "memhub-bundle-ndjson-v1";
export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
/** A single encoded row line larger than this fails the export before it is written. */
export const NDJSON_MAX_LINE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_CACHE_SIZE_KIB = 16 * 1024;
const SNAPSHOT_BUSY_TIMEOUT_MS = 5_000;
const ROW_YIELD_INTERVAL = 500;
const ROW_TYPES = new Set(["header", "table_start", "row", "table_end", "footer"]);
/**
 * Opens a private read-only snapshot connection to the live SQLite file. Reads
 * through one deferred transaction pin a WAL snapshot that covers both ordinary
 * tables and sqlite-vec tables; the extension is loaded so vector rows can be
 * read. Callers own closing the returned handle.
 */
export function openBundleSnapshot(path) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        db.pragma(`busy_timeout = ${SNAPSHOT_BUSY_TIMEOUT_MS}`);
        db.pragma("cache_size = -" + SNAPSHOT_CACHE_SIZE_KIB);
        db.loadExtension(getSqliteVecLoadablePath());
        return db;
    }
    catch (error) {
        try {
            db.close();
        }
        catch {
            // Preserve the original open/configuration error.
        }
        throw error;
    }
}
/** Formats a table name for interpolation. Only trusted schema names are ever passed here. */
function quoteIdentifier(name) {
    return `"${String(name).replaceAll('"', '""')}"`;
}
function quoteLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}
/**
 * Derives the deterministic total order for a bundle table from trusted schema
 * metadata. Fails when a table has neither a primary key nor a rowid.
 */
export function bundleTableOrder(db, table) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    if (columns.length === 0) {
        throw new Error(`bundle table ${table} does not exist`);
    }
    const primaryKey = columns
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk));
    if (primaryKey.length > 0) {
        return primaryKey.map((column) => `${quoteIdentifier(column.name)} COLLATE BINARY ASC`).join(", ");
    }
    const definition = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table);
    if (/WITHOUT\s+ROWID/i.test(definition?.sql ?? "")) {
        throw new Error(`bundle table ${table} has no primary key and no rowid`);
    }
    return "rowid ASC";
}
/**
 * Builds the export plan: BUNDLE_TABLES order (audit optional) then logical
 * memory_vectors last, with an explicit total order for every table.
 */
export function buildBundlePlan(db, includeAudit = true) {
    const plan = [];
    for (const table of BUNDLE_TABLES) {
        if (table === "audit_logs" && !includeAudit)
            continue;
        plan.push({ table, kind: "table", orderBy: bundleTableOrder(db, table) });
    }
    plan.push({
        table: "memory_vectors",
        kind: "vectors",
        orderBy: `${quoteIdentifier("memory_id")} COLLATE BINARY ASC, ${quoteIdentifier("vector_field")} COLLATE BINARY ASC`
    });
    return plan;
}
export function bundleTableNames(includeAudit = true) {
    return [
        ...BUNDLE_TABLES.filter((table) => includeAudit || table !== "audit_logs"),
        "memory_vectors"
    ];
}
function createHashWriter() {
    const hash = createHash("sha256");
    return {
        update(bytes) {
            hash.update(bytes);
        },
        digest() {
            return hash.digest("hex");
        }
    };
}
/**
 * Streams a complete NDJSON bundle to `write`, which is awaited for every
 * line. Callers must already have an open read transaction on `db`.
 */
export async function streamBundleNdjson(options) {
    const { db, plan, exportId, snapshotAt, schemaVersion, includeRawText, includeAudit, write } = options;
    const yieldEvery = options.yieldEvery ?? ROW_YIELD_INTERVAL;
    if (typeof write !== "function") {
        throw new Error("bundle export sink is required");
    }
    const emit = async (record) => {
        const line = canonicalJson(record) + "\n";
        const bytes = Buffer.byteLength(line, "utf8");
        if (bytes > NDJSON_MAX_LINE_BYTES) {
            throw new Error(`bundle record for ${record.table ?? record.type} exceeds the ${NDJSON_MAX_LINE_BYTES}-byte line limit`);
        }
        await write(line);
        return { line, bytes };
    };
    const header = {
        type: "header",
        format: NDJSON_BUNDLE_FORMAT,
        schemaVersion,
        exportId,
        snapshotAt,
        tables: plan.map((entry) => entry.table),
        includeRawText,
        includeAudit,
        hash: "sha256"
    };
    const headerLine = (await emit(header)).line;
    const headerSha256 = createHash("sha256").update(headerLine, "utf8").digest("hex");
    const tables = [];
    for (const entry of plan) {
        await emit({ type: "table_start", table: entry.table });
        const tableHash = createHashWriter();
        let rows = 0;
        let bytes = 0;
        const rowsIterator = entry.kind === "vectors"
            ? iterateVectorRows(db, entry.orderBy)
            : iterateTableRows(db, entry.table, entry.orderBy, includeRawText, snapshotAt);
        for (const data of rowsIterator) {
            rows += 1;
            const line = canonicalJson({ type: "row", table: entry.table, ordinal: rows, data }) + "\n";
            const lineBytes = Buffer.byteLength(line, "utf8");
            if (lineBytes > NDJSON_MAX_LINE_BYTES) {
                throw new Error(`bundle row ${entry.table} ordinal ${rows} exceeds the ${NDJSON_MAX_LINE_BYTES}-byte line limit`);
            }
            tableHash.update(line);
            bytes += lineBytes;
            await write(line);
            if (yieldEvery > 0 && rows % yieldEvery === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        const summary = { table: entry.table, rows, bytes, sha256: tableHash.digest() };
        tables.push(summary);
        await emit({ type: "table_end", ...summary });
    }
    const manifestSha256 = createHash("sha256")
        .update(canonicalJson({ headerSha256, tables }), "utf8")
        .digest("hex");
    await emit({ type: "footer", exportId, tables, headerSha256, manifestSha256, complete: true });
    return {
        format: NDJSON_BUNDLE_FORMAT,
        exportId,
        schemaVersion,
        snapshotAt,
        headerSha256,
        manifestSha256,
        tables,
        rows: tables.reduce((total, table) => total + table.rows, 0),
        bytes: tables.reduce((total, table) => total + table.bytes, 0)
    };
}
function* iterateTableRows(db, table, orderBy, includeRawText, snapshotAt) {
    const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`);
    for (const row of statement.iterate()) {
        const redacted = includeRawText ? row : redactBundleRow(table, row, snapshotAt);
        yield serializeBundleRow(table, redacted);
    }
}
function* iterateVectorRows(db, orderBy) {
    const statement = db.prepare(`SELECT id, memory_id, vector_field, embedding_model, embedding_provider, embedding_dim, updated_at
     FROM memory_vector_entries
     ORDER BY ${orderBy}`);
    const embeddingStatements = new Map();
    const existingVectorTables = new Map();
    for (const row of statement.iterate()) {
        const dimension = Number(row.embedding_dim);
        if (!Number.isSafeInteger(dimension) || dimension <= 0)
            continue;
        const vectorTable = `memory_vec_${dimension}`;
        if (!existingVectorTables.has(vectorTable)) {
            const exists = Boolean(db
                .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
                .get(vectorTable));
            existingVectorTables.set(vectorTable, exists);
        }
        if (!existingVectorTables.get(vectorTable))
            continue;
        let embeddingStatement = embeddingStatements.get(vectorTable);
        if (!embeddingStatement) {
            embeddingStatement = db.prepare(`SELECT embedding FROM ${quoteIdentifier(vectorTable)} WHERE rowid = ?`);
            embeddingStatements.set(vectorTable, embeddingStatement);
        }
        const stored = embeddingStatement.get(row.id);
        const embedding = stored?.embedding;
        if (!Buffer.isBuffer(embedding))
            continue;
        yield {
            memory_id: row.memory_id,
            vector_field: row.vector_field,
            embedding: embedding.toString("base64"),
            embedding_model: row.embedding_model,
            embedding_provider: row.embedding_provider,
            embedding_dim: row.embedding_dim,
            updated_at: row.updated_at
        };
    }
}
function verificationError(message) {
    const error = new Error(message);
    error.code = "invalid_bundle";
    return error;
}
async function* readNdjsonLines(readable) {
    let pending = [];
    let pendingBytes = 0;
    for await (const chunk of readable) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        let newline = buffer.indexOf(0x0a);
        while (newline !== -1) {
            const tail = buffer.subarray(start, newline + 1);
            const line = concatenate(pending, tail, pendingBytes + tail.length);
            pending = [];
            pendingBytes = 0;
            if (line.length > NDJSON_MAX_LINE_BYTES) {
                throw verificationError("bundle line exceeds the 8 MiB limit");
            }
            yield line;
            start = newline + 1;
            newline = buffer.indexOf(0x0a, start);
        }
        if (start < buffer.length) {
            const tail = buffer.subarray(start);
            pending.push(tail);
            pendingBytes += tail.length;
            if (pendingBytes > NDJSON_MAX_LINE_BYTES) {
                throw verificationError("bundle line exceeds the 8 MiB limit");
            }
        }
    }
    if (pendingBytes > 0) {
        throw verificationError("bundle ends with an unterminated record (missing trailing newline)");
    }
}
function concatenate(previous, tail, totalBytes) {
    if (previous.length === 0)
        return tail;
    const combined = Buffer.allocUnsafe(totalBytes);
    let offset = 0;
    for (const part of previous) {
        combined.set(part, offset);
        offset += part.length;
    }
    combined.set(tail, offset);
    return combined;
}
function decodeLine(line, lineNumber) {
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    }
    catch {
        throw verificationError(`bundle line ${lineNumber} is not valid UTF-8`);
    }
    if (!text.endsWith("\n")) {
        throw verificationError(`bundle line ${lineNumber} is missing its newline terminator`);
    }
    const body = text.slice(0, -1);
    if (body.trim() === "") {
        throw verificationError(`bundle line ${lineNumber} is blank`);
    }
    let record;
    try {
        record = JSON.parse(body);
    }
    catch {
        throw verificationError(`bundle line ${lineNumber} is not valid JSON`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw verificationError(`bundle line ${lineNumber} is not a JSON object`);
    }
    if (typeof record.type !== "string" || !ROW_TYPES.has(record.type)) {
        throw verificationError(`bundle line ${lineNumber} has an unknown record type`);
    }
    return record;
}
/**
 * Streams and verifies a `memhub-bundle-ndjson-v1` readable with bounded
 * memory. Returns a summary; throws a sanitized error (never row data) on any
 * ordering, count, digest or completeness violation.
 */
export async function verifyNdjsonBundle(readable) {
    let lineNumber = 0;
    let header;
    let headerSha256;
    let exportId;
    let expectedTables;
    let tableIndex = 0;
    let openTable;
    let summaries = [];
    let footerSeen = false;
    let manifestSha256;
    let totalBytes = 0;
    let totalRows = 0;
    for await (const line of readNdjsonLines(readable)) {
        lineNumber += 1;
        totalBytes += line.length;
        if (footerSeen) {
            throw verificationError(`bundle has data after the footer at line ${lineNumber}`);
        }
        const record = decodeLine(line, lineNumber);
        if (lineNumber === 1) {
            if (record.type !== "header") {
                throw verificationError("bundle must start with a header record");
            }
            if (record.format !== NDJSON_BUNDLE_FORMAT) {
                throw verificationError("bundle header has an unsupported format");
            }
            if (record.hash !== "sha256") {
                throw verificationError("bundle header has an unsupported hash algorithm");
            }
            if (!Number.isInteger(record.schemaVersion) || record.schemaVersion < 0) {
                throw verificationError("bundle header is missing a valid schemaVersion");
            }
            if (typeof record.exportId !== "string" || record.exportId === "") {
                throw verificationError("bundle header is missing an exportId");
            }
            if (typeof record.snapshotAt !== "string" || record.snapshotAt === "") {
                throw verificationError("bundle header is missing a snapshotAt timestamp");
            }
            if (typeof record.includeRawText !== "boolean" || typeof record.includeAudit !== "boolean") {
                throw verificationError("bundle header is missing its raw/audit policy");
            }
            if (!Array.isArray(record.tables) || record.tables.length === 0 ||
                record.tables.some((table) => typeof table !== "string" || table === "")) {
                throw verificationError("bundle header is missing its table order");
            }
            if (new Set(record.tables).size !== record.tables.length) {
                throw verificationError("bundle header lists a duplicate table");
            }
            header = record;
            exportId = record.exportId;
            expectedTables = record.tables.slice();
            headerSha256 = createHash("sha256").update(line).digest("hex");
            continue;
        }
        if (!header) {
            throw verificationError("bundle must start with a header record");
        }
        if (record.type === "header") {
            throw verificationError(`bundle has a duplicate header at line ${lineNumber}`);
        }
        if (record.type === "table_start") {
            if (openTable) {
                throw verificationError(`bundle starts table ${record.table} before ending ${openTable.table}`);
            }
            const expected = expectedTables[tableIndex];
            if (expected === undefined) {
                throw verificationError(`bundle has an unknown table ${record.table}`);
            }
            if (record.table !== expected) {
                throw verificationError(`bundle table order mismatch: expected ${expected}, found ${record.table}`);
            }
            openTable = {
                table: record.table,
                rows: 0,
                bytes: 0,
                hash: createHash("sha256")
            };
            continue;
        }
        if (record.type === "row") {
            if (!openTable) {
                throw verificationError(`bundle row outside a table at line ${lineNumber}`);
            }
            if (record.table !== openTable.table) {
                throw verificationError(`bundle row table mismatch at line ${lineNumber}`);
            }
            if (!Number.isInteger(record.ordinal) || record.ordinal !== openTable.rows + 1) {
                throw verificationError(`bundle row ordinal mismatch for ${openTable.table}`);
            }
            if (record.data === undefined || record.data === null || typeof record.data !== "object" || Array.isArray(record.data)) {
                throw verificationError(`bundle row data is invalid for ${openTable.table}`);
            }
            openTable.rows += 1;
            openTable.bytes += line.length;
            openTable.hash.update(line);
            totalRows += 1;
            continue;
        }
        if (record.type === "table_end") {
            if (!openTable) {
                throw verificationError(`bundle table_end outside a table at line ${lineNumber}`);
            }
            if (record.table !== openTable.table) {
                throw verificationError(`bundle table_end table mismatch at line ${lineNumber}`);
            }
            if (record.rows !== openTable.rows) {
                throw verificationError(`bundle row count mismatch for ${openTable.table}`);
            }
            if (record.bytes !== openTable.bytes) {
                throw verificationError(`bundle byte count mismatch for ${openTable.table}`);
            }
            const digest = openTable.hash.digest("hex");
            if (record.sha256 !== digest) {
                throw verificationError(`bundle table digest mismatch for ${openTable.table}`);
            }
            summaries.push({
                table: openTable.table,
                rows: openTable.rows,
                bytes: openTable.bytes,
                sha256: digest
            });
            openTable = undefined;
            tableIndex += 1;
            continue;
        }
        if (record.type === "footer") {
            if (openTable) {
                throw verificationError(`bundle footer arrived before table ${openTable.table} ended`);
            }
            if (tableIndex !== expectedTables.length) {
                throw verificationError("bundle footer arrived before every table was exported");
            }
            if (record.exportId !== exportId) {
                throw verificationError("bundle footer exportId does not match the header");
            }
            if (record.complete !== true) {
                throw verificationError("bundle footer is not marked complete");
            }
            if (!Array.isArray(record.tables) || record.tables.length !== summaries.length) {
                throw verificationError("bundle footer table manifest is incomplete");
            }
            for (const [index, summary] of record.tables.entries()) {
                const actual = summaries[index];
                if (summary?.table !== actual.table ||
                    summary?.rows !== actual.rows ||
                    summary?.bytes !== actual.bytes ||
                    summary?.sha256 !== actual.sha256) {
                    throw verificationError("bundle footer table manifest does not match the records");
                }
            }
            if (record.headerSha256 !== headerSha256) {
                throw verificationError("bundle footer header digest does not match the header");
            }
            const expectedManifestSha256 = createHash("sha256")
                .update(canonicalJson({ headerSha256, tables: summaries }), "utf8")
                .digest("hex");
            if (record.manifestSha256 !== expectedManifestSha256) {
                throw verificationError("bundle footer manifest digest does not match");
            }
            manifestSha256 = expectedManifestSha256;
            footerSeen = true;
            continue;
        }
    }
    if (!header) {
        throw verificationError("bundle is empty");
    }
    if (!footerSeen) {
        throw verificationError("bundle is incomplete: missing footer");
    }
    return {
        ok: true,
        format: header.format,
        exportId,
        schemaVersion: header.schemaVersion,
        snapshotAt: header.snapshotAt,
        includeRawText: header.includeRawText,
        includeAudit: header.includeAudit,
        headerSha256,
        manifestSha256,
        tables: summaries,
        rows: totalRows,
        bytes: totalBytes
    };
}
export { ROW_TYPES };
