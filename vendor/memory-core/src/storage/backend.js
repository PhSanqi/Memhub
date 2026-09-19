import { Repositories } from "./repositories.js";
import { MemoryDb } from "./db.js";
import { assertMemoryNetworkTarget } from "../privacy/network-policy.js";
export class SqliteStorageBackend {
    db;
    mode;
    id = "sqlite-local";
    kind = "sqlite";
    constructor(db, mode = "local") {
        this.db = db;
        this.mode = mode;
    }
    capabilities() {
        return sqliteBackendCapabilities(this.db);
    }
    repositories() {
        return new Repositories(this.db.db);
    }
    close() {
        this.db.close();
    }
}
export function sqliteBackendCapabilities(db) {
    const schema = db.schemaVersion();
    return {
        backendId: "sqlite-local",
        backend: "sqlite",
        schemaVersion: String(schema.version),
        fullText: "fts5",
        vector: "native",
        changeLog: true,
        idempotency: true,
        jobs: true,
        importExport: true
    };
}
export class RemoteRestStorageBackend {
    endpoint;
    token;
    schema;
    id = "openmem-cloud-rest";
    kind = "openmem-cloud-rest";
    mode;
    constructor(endpoint, token, mode = "cloud", schema = "remote", allowRemote = false) {
        this.endpoint = endpoint;
        this.token = token;
        this.schema = schema;
        assertMemoryNetworkTarget(endpoint, {
            allowRemote,
            purpose: "remote memory storage"
        });
        this.mode = mode;
    }
    capabilities() {
        return {
            backendId: "openmem-cloud-rest",
            backend: "openmem-cloud-rest",
            schemaVersion: this.schema,
            fullText: "remote",
            vector: "remote",
            changeLog: true,
            idempotency: true,
            jobs: true,
            importExport: true
        };
    }
    repositories() {
        throw new Error("openmem-cloud-rest is an agent-side REST backend; use MemoryRestClient instead of local repositories");
    }
    close() {
        // Remote REST mode owns no local database handle.
    }
}
export function createStorageBackend(options = {}) {
    const backend = options.backend ?? "sqlite";
    const mode = options.mode ?? "local";
    if (backend === "openmem-cloud-rest") {
        return new RemoteRestStorageBackend(options.endpoint ?? "https://memos-api.openmem.net", options.token, mode, options.schemaVersion, options.allowRemote);
    }
    return new SqliteStorageBackend(new MemoryDb({ path: options.sqlitePath }), mode);
}
