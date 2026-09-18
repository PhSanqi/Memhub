export const SQLITE_VEC_VERSION = "0.1.9";
export const VECTOR_SEARCH_WINDOW = 2_000;
/** Keeps sqlite-vec details out of the repository and retrieval layers. */
export class SqliteVecStore {
    db;
    constructor(db) {
        this.db = db;
    }
    replace(memoryId, vectors, updatedAt) {
        this.db.transaction(() => {
            this.deleteMemory(memoryId);
            for (const vector of vectors) {
                this.upsert(memoryId, vector, updatedAt);
            }
        })();
    }
    upsert(memoryId, value, updatedAt) {
        assertVector(value.vector);
        const prior = this.db
            .prepare(`SELECT id, embedding_dim
         FROM memory_vector_entries
         WHERE memory_id = ? AND vector_field = ?`)
            .get(memoryId, value.vectorField);
        if (prior && prior.embedding_dim !== value.vector.length) {
            this.deleteVectorRow(prior.id, prior.embedding_dim);
            this.db.prepare(`DELETE FROM memory_vector_entries WHERE id = ?`).run(prior.id);
        }
        this.db
            .prepare(`INSERT INTO memory_vector_entries (
          memory_id, vector_field, embedding_model, embedding_provider, embedding_dim, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id, vector_field) DO UPDATE SET
          embedding_model = excluded.embedding_model,
          embedding_provider = excluded.embedding_provider,
          embedding_dim = excluded.embedding_dim,
          updated_at = excluded.updated_at`)
            .run(memoryId, value.vectorField, value.embeddingModel ?? null, value.embeddingProvider ?? null, value.vector.length, updatedAt);
        const entry = this.db
            .prepare(`SELECT id
         FROM memory_vector_entries
         WHERE memory_id = ? AND vector_field = ?`)
            .get(memoryId, value.vectorField);
        const table = this.ensureVectorTable(value.vector.length);
        this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(entry.id));
        this.db
            .prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`)
            .run(BigInt(entry.id), vectorToBuffer(value.vector));
    }
    deleteMemory(memoryId) {
        const rows = this.db
            .prepare(`SELECT id, embedding_dim FROM memory_vector_entries WHERE memory_id = ?`)
            .all(memoryId);
        for (const row of rows) {
            this.deleteVectorRow(row.id, row.embedding_dim);
        }
        this.db.prepare(`DELETE FROM memory_vector_entries WHERE memory_id = ?`).run(memoryId);
    }
    delete(memoryId, vectorField) {
        const row = this.db
            .prepare(`SELECT id, embedding_dim
         FROM memory_vector_entries
         WHERE memory_id = ? AND vector_field = ?`)
            .get(memoryId, vectorField);
        if (!row)
            return;
        this.deleteVectorRow(row.id, row.embedding_dim);
        this.db.prepare(`DELETE FROM memory_vector_entries WHERE id = ?`).run(row.id);
    }
    getMany(memoryIds) {
        if (memoryIds.length === 0)
            return new Map();
        const rows = this.db
            .prepare(`SELECT id, memory_id, vector_field, embedding_model, embedding_provider, embedding_dim
         FROM memory_vector_entries
         WHERE memory_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         ORDER BY id`)
            .all(JSON.stringify(memoryIds));
        const result = new Map();
        for (const [dimension, grouped] of groupByDimension(rows)) {
            const table = vectorTableName(dimension);
            if (!this.tableExists(table))
                continue;
            const ids = grouped.map((row) => row.id);
            const vectorRows = this.db
                .prepare(`SELECT rowid, embedding
           FROM ${table}
           WHERE rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`)
                .all(JSON.stringify(ids));
            const byId = new Map(vectorRows.map((row) => [Number(row.rowid), bufferToVector(row.embedding)]));
            for (const row of grouped) {
                const vector = byId.get(row.id);
                if (!vector)
                    continue;
                const values = result.get(row.memory_id) ?? [];
                values.push({
                    vectorField: row.vector_field,
                    vector,
                    embeddingModel: row.embedding_model,
                    embeddingProvider: row.embedding_provider
                });
                result.set(row.memory_id, values);
            }
        }
        return result;
    }
    search(query, candidates, limit) {
        if (query.length === 0 || candidates.length === 0 || limit <= 0)
            return [];
        const compatible = candidates.filter((candidate) => candidate.embeddingDim === query.length);
        if (compatible.length === 0)
            return [];
        const table = vectorTableName(query.length);
        if (!this.tableExists(table))
            return [];
        const ids = compatible.map((candidate) => candidate.id);
        const memoryIdByEntryId = new Map(compatible.map((candidate) => [candidate.id, candidate.memoryId]));
        const rows = this.db
            .prepare(`SELECT rowid, distance
         FROM ${table}
         WHERE embedding MATCH ?
           AND k = ?
           AND rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
         ORDER BY distance`)
            .all(vectorToBuffer(query), Math.min(limit, compatible.length), JSON.stringify(ids));
        return rows.flatMap((row) => {
            const id = memoryIdByEntryId.get(Number(row.rowid));
            return id ? [{ id, score: 1 - Number(row.distance) }] : [];
        });
    }
    exportRows() {
        const rows = this.db
            .prepare(`SELECT id, memory_id, vector_field, embedding_model, embedding_provider, embedding_dim, updated_at
         FROM memory_vector_entries
         ORDER BY id`)
            .all();
        const vectors = this.getMany([...new Set(rows.map((row) => row.memory_id))]);
        return rows.flatMap((row) => {
            const value = vectors.get(row.memory_id)?.find((entry) => entry.vectorField === row.vector_field);
            return value
                ? [{
                        memory_id: row.memory_id,
                        vector_field: row.vector_field,
                        embedding: vectorToBuffer(value.vector).toString("base64"),
                        embedding_model: row.embedding_model,
                        embedding_provider: row.embedding_provider,
                        embedding_dim: row.embedding_dim,
                        updated_at: row.updated_at
                    }]
                : [];
        });
    }
    maintenanceDimensionCounts() {
        const totalSlots = Number(this.db.prepare(`SELECT COUNT(*)
       FROM memories
       WHERE deleted_at IS NULL AND status != 'deleted'`).pluck().get() ?? 0);
        const dimensions = this.db.prepare(`SELECT entries.embedding_dim AS dimension, COUNT(DISTINCT entries.memory_id) AS count
       FROM memory_vector_entries AS entries
       INNER JOIN memories ON memories.id = entries.memory_id
       WHERE memories.deleted_at IS NULL AND memories.status != 'deleted'
       GROUP BY entries.embedding_dim
       ORDER BY count DESC, dimension DESC`).all();
        return { totalSlots, dimensions };
    }
    importRows(rows) {
        this.db.transaction(() => {
            for (const row of rows) {
                const vector = bufferToVector(Buffer.from(row.embedding, "base64"));
                if (vector.length !== row.embedding_dim) {
                    throw new Error(`invalid vector dimension for ${row.memory_id}:${row.vector_field}`);
                }
                this.upsert(row.memory_id, {
                    vectorField: row.vector_field,
                    vector,
                    embeddingModel: row.embedding_model,
                    embeddingProvider: row.embedding_provider
                }, row.updated_at);
            }
        })();
    }
    ensureVectorTable(dimension) {
        const table = vectorTableName(dimension);
        this.db
            .prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
         USING vec0(embedding float[${dimension}] distance_metric=cosine)`)
            .run();
        return table;
    }
    deleteVectorRow(id, dimension) {
        const table = vectorTableName(dimension);
        if (this.tableExists(table)) {
            this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(id));
        }
    }
    tableExists(table) {
        return Boolean(this.db
            .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
            .get(table));
    }
}
function vectorTableName(dimension) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
        throw new Error(`invalid vector dimension: ${dimension}`);
    }
    return `memory_vec_${dimension}`;
}
function assertVector(vector) {
    if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("vector must contain finite values");
    }
}
function groupByDimension(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const values = grouped.get(row.embedding_dim) ?? [];
        values.push(row);
        grouped.set(row.embedding_dim, values);
    }
    return grouped;
}
export function vectorToBuffer(vector) {
    const values = Float32Array.from(vector);
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}
export function bufferToVector(buffer) {
    if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0)
        return [];
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const result = [];
    for (let offset = 0; offset < buffer.byteLength; offset += 4) {
        result.push(view.getFloat32(offset, true));
    }
    return result;
}
