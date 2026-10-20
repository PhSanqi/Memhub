import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { getSchemaVersion, migrate, SCHEMA_VERSION } from "./schema.js";
import { SQLITE_VEC_VERSION } from "./sqlite-vec-store.js";
export class MemoryDb {
    path;
    db;
    constructor(options = {}) {
        this.path = options.path ?? defaultDatabasePath();
        mkdirSync(dirname(this.path), { recursive: true });
        const nativeBinding = packagedNativeBindingPath();
        this.db = new Database(this.path, {
            readonly: options.readonly ?? false,
            ...(nativeBinding ? { nativeBinding } : {})
        });
        const extensionPath = packagedNativeAssetPath(getSqliteVecLoadablePath());
        const unpackedPath = extensionPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
        this.db.loadExtension(existsSync(unpackedPath) ? unpackedPath : extensionPath);
        const loadedVersion = this.db.prepare(`SELECT vec_version() AS version`).get().version;
        if (loadedVersion !== `v${SQLITE_VEC_VERSION}`) {
            this.db.close();
            throw new Error(`sqlite-vec version mismatch: expected v${SQLITE_VEC_VERSION}, got ${loadedVersion}`);
        }
        try {
            this.configure();
            if (!options.readonly) {
                this.createPreMigrationBackup(options.freeSpaceProbe);
                migrate(this.db);
            }
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() {
        this.db.close();
    }
    schemaVersion() {
        return getSchemaVersion(this.db);
    }
    configure() {
        // Set the busy handler before the first lock-taking pragma so concurrent
        // openers wait instead of failing on a transient journal-mode change.
        this.db.pragma("busy_timeout = 5000");
        this.db.pragma("foreign_keys = ON");
        configureWalJournalMode(this.db);
        this.db.pragma("synchronous = NORMAL");
    }
    createPreMigrationBackup(freeSpaceProbe) {
        if (this.path === ":memory:" || !existsSync(this.path))
            return;
        let version = 0;
        try {
            version = getSchemaVersion(this.db).version;
        }
        catch {
            return;
        }
        if (version <= 0 || version >= SCHEMA_VERSION)
            return;
        const directory = dirname(this.path);
        const sizeBytes = databaseSizeBytes(this.path);
        const requiredBytes = sizeBytes * 2 + PRE_MIGRATION_BACKUP_MARGIN_BYTES;
        const availableBytes = freeSpaceProbe
            ? Number(freeSpaceProbe(directory))
            : availableFreeSpaceBytes(directory);
        if (Number.isNaN(availableBytes) || availableBytes < requiredBytes) {
            throw new Error(`Insufficient free space for pre-migration backup: need ${requiredBytes} bytes ` +
                `(database ${sizeBytes} x 2 + margin ${PRE_MIGRATION_BACKUP_MARGIN_BYTES}), ` +
                `available ${Number.isFinite(availableBytes) ? availableBytes : "unknown"} bytes at ${directory}; ` +
                `the database was left unchanged`);
        }
        this.db.pragma("wal_checkpoint(FULL)");
        const base = basename(this.path);
        // A crash mid-backup leaves a DB-sized temp file. Skip temps owned by a
        // live process: concurrent openers may share the directory (tests) even
        // though the Core lock normally makes this process the only migrator.
        removeStaleBackupTemps(directory, base);
        const temporaryPath = join(directory, `.${base}.pre-v${SCHEMA_VERSION}.${process.pid}.${randomUUID()}.tmp`);
        try {
            this.db.prepare("VACUUM INTO ?").run(temporaryPath);
            fsyncPath(temporaryPath);
            verifyBackup(temporaryPath, this.db);
            if (backupSchemaVersion(temporaryPath) >= SCHEMA_VERSION) {
                // Another opener migrated the database between our version probe
                // and this snapshot. That backup would be mislabelled as
                // pre-migration: a redundant backup is acceptable, a wrong one is
                // not, so discard it. migrate() will see the new version.
                rmSync(temporaryPath, { force: true });
                return;
            }
            const finalPath = join(directory, `${base}.pre-v${SCHEMA_VERSION}.${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
            renameSync(temporaryPath, finalPath);
            fsyncDirectory(directory);
            prunePreMigrationBackups(directory, base, PRE_MIGRATION_BACKUP_KEEP);
        }
        catch (error) {
            rmSync(temporaryPath, { force: true });
            throw error;
        }
    }
}
const PRE_MIGRATION_BACKUP_MARGIN_BYTES = 64 * 1024 * 1024;
const PRE_MIGRATION_BACKUP_KEEP = 3;
function databaseSizeBytes(path) {
    let total = statSync(path).size;
    for (const suffix of ["-wal", "-shm"]) {
        try {
            total += statSync(`${path}${suffix}`).size;
        }
        catch {
            // Missing sidecar files are expected outside WAL activity.
        }
    }
    return total;
}
function availableFreeSpaceBytes(directory) {
    const stats = statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
}
function fsyncPath(path) {
    const fd = openSync(path, "r");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function fsyncDirectory(directory) {
    try {
        fsyncPath(directory);
    }
    catch (error) {
        // Windows cannot open directories for fsync; the rename is still atomic there.
        if (!error || !["EISDIR", "EPERM", "EACCES", "EINVAL"].includes(error.code))
            throw error;
    }
}
function verifyBackup(backupPath, source) {
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
        const integrity = backup.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") {
            throw new Error(`Pre-migration backup integrity check failed: ${integrity}`);
        }
        const backupPages = Number(backup.pragma("page_count", { simple: true }));
        const sourcePages = Number(source.pragma("page_count", { simple: true }));
        if (!(backupPages > 0) || backupPages > sourcePages) {
            throw new Error(`Pre-migration backup page count ${backupPages} is invalid for source page count ${sourcePages}`);
        }
    }
    finally {
        backup.close();
    }
}
function removeStaleBackupTemps(directory, base) {
    for (const name of readdirSync(directory)) {
        if (!name.startsWith(`.${base}.pre-v`) || !name.endsWith(".tmp"))
            continue;
        // Temp names end with .<pid>.<uuid>.tmp; keep a live VACUUM INTO writer.
        const pid = Number(name.split(".").at(-3));
        if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid))
            continue;
        rmSync(join(directory, name), { force: true });
    }
}
function configureWalJournalMode(db) {
    // Switching a rollback-journal database to WAL takes an exclusive lock and
    // can return SQLITE_BUSY without consulting busy_timeout. Concurrent openers
    // of a fresh file race here, so retry briefly instead of failing the open.
    const deadline = Date.now() + 5_000;
    for (;;) {
        try {
            db.pragma("journal_mode = WAL");
            return;
        }
        catch (error) {
            if (error.code !== "SQLITE_BUSY" || Date.now() >= deadline)
                throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function backupSchemaVersion(path) {
    const backup = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const row = backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
        return Number(row?.version ?? 0);
    }
    catch {
        return 0;
    }
    finally {
        backup.close();
    }
}
function prunePreMigrationBackups(directory, base, keep) {
    const prefix = `${base}.pre-v`;
    const entries = readdirSync(directory)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
        .map((name) => {
        try {
            return { name, modifiedAt: statSync(join(directory, name)).mtimeMs };
        }
        catch {
            return undefined;
        }
    })
        .filter((entry) => Boolean(entry))
        .sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const entry of entries.slice(keep)) {
        rmSync(join(directory, entry.name), { force: true });
    }
}
function packagedNativeBindingPath() {
    if (!process.pkg)
        return undefined;
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    if (!existsSync(source))
        return undefined;
    return packagedNativeAssetPath(source);
}
function packagedNativeAssetPath(source) {
    if (!process.pkg)
        return source;
    if (!existsSync(source))
        return source;
    const contents = readFileSync(source);
    const digest = createHash("sha256").update(contents).digest("hex");
    // Keep upgrades separate from native libraries already loaded by older processes.
    const targetDirectory = join(tmpdir(), "memmy-memory-native", digest);
    const target = join(targetDirectory, basename(source));
    const isComplete = () => existsSync(target) && readFileSync(target).equals(contents);
    if (isComplete())
        return target;
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporaryPath, contents, { flag: "wx", mode: 0o600 });
        renameSync(temporaryPath, target);
    }
    catch (error) {
        // Another extractor may publish and load the same asset before our rename.
        if (!isComplete())
            throw error;
    }
    finally {
        rmSync(temporaryPath, { force: true });
    }
    return target;
}
export function defaultDatabasePath() {
    const baseDir = process.env.MEMMY_MEMORY_HOME ??
        process.env.MEMORY_SERVICE_HOME ??
        join(homedir(), ".memmy", "memory-service");
    return join(baseDir, "memory.sqlite");
}
