#!/usr/bin/env node
import { mutateMemoryConfig } from "../config/writer.js";
import { existsSync, linkSync, mkdirSync, readdirSync, rmdirSync, statSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorageBackend } from "../storage/backend.js";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { MemoryService } from "../service/memory-service.js";
import { closeMemoryHttpServer, listenMemoryHttpServer } from "./http.js";
import { assertLoopbackBindHost } from "./bind-host.js";
import { loadCloudServiceEnv } from "../cli/load-env.js";
import { requestMemoryServiceRestart } from "./service-restart.js";
import { MEMORY_PROTOCOL_VERSION, MEMORY_SERVICE_VERSION } from "../version.js";
const logger = createMemoryLogger("server");
export async function main(argv = process.argv.slice(2)) {
    loadCloudServiceEnv();
    let shuttingDown = false;
    let stopService;
    const shutdown = () => {
        shuttingDown = true;
        stopService?.();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
        while (!shuttingDown) {
            const restart = await runMemoryService(argv, {
                shutdown,
                setStopService(stop) {
                    stopService = stop;
                    if (shuttingDown)
                        stop();
                }
            });
            if (!restart)
                break;
        }
    }
    finally {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
    }
}
async function runMemoryService(argv, lifecycle) {
    const options = parseServeArgs(argv);
    const { config, path: configPath } = loadMemmyConfig(options.configPath);
    const host = options.host ?? process.env.MEMMY_MEMORY_HOST ?? process.env.MEMORY_SERVICE_HOST ?? "127.0.0.1";
    assertLoopbackBindHost(host);
    const port = options.port ??
        numberEnv("MEMMY_MEMORY_PORT") ??
        numberEnv("MEMORY_SERVICE_PORT") ??
        18960;
    const sqlitePath = options.dbPath ?? config.storage.sqlitePath;
    const serviceHome = resolve(dirname(configPath), "memory-service");
    logger.info("service.starting", {
        host,
        port,
        mode: config.storage.mode,
        storageBackend: config.storage.backend,
        sqlitePath,
        configPath
    });
    const serviceLock = acquireUserServiceLock({ serviceHome, host, port });
    let sqliteLock;
    let backend;
    let server;
    let requestShutdown;
    let restartRequested = false;
    const shutdownRequested = new Promise((resolveShutdown) => {
        requestShutdown = resolveShutdown;
    });
    lifecycle.setStopService(requestShutdown);
    try {
        sqliteLock = config.storage.backend === "openmem-cloud-rest"
            ? undefined
            : acquireSqliteServerLock({ sqlitePath, host, port });
        backend = createStorageBackend({
            mode: config.storage.mode,
            backend: config.storage.backend,
            sqlitePath,
            endpoint: config.storage.endpoint,
            token: config.storage.token
        });
        const service = new MemoryService({
            backend,
            mode: config.storage.mode,
            configPath,
            config
        });
        const listening = await listenMemoryHttpServer({
            service,
            host,
            port,
            timeZone: config.timeZone,
            onShutdownRequested: lifecycle.shutdown,
            onRestartRequested: () => requestMemoryServiceRestart({
                restartLocal: () => {
                    restartRequested = true;
                    requestShutdown();
                }
            }),
            auth: config.storage.token
                ? { localServiceToken: config.storage.token }
                : { allowAnonymous: true },
            configPath,
            // Off by default: Memhub ingests turns through MCP, so third-party
            // agent transcript scans are only wanted when explicitly enabled.
            startAgentSourceAutomation: agentSourceAutomationEnabled()
        });
        server = listening.server;
        const { url } = listening;
        if (configPath) {
            await writeCurrentEndpoint(configPath, url);
        }
        writeRuntimeState(serviceHome, {
            pid: process.pid,
            endpoint: url,
            serviceVersion: MEMORY_SERVICE_VERSION,
            protocolVersion: MEMORY_PROTOCOL_VERSION,
            configPath,
            sqlitePath,
            startedAt: new Date().toISOString()
        });
        logger.info("service.listening", {
            url,
            mode: config.storage.mode,
            storageBackend: config.storage.backend
        });
        await shutdownRequested;
    }
    finally {
        if (server) {
            await closeMemoryHttpServer(server);
        }
        backend?.close();
        removeRuntimeState(serviceHome);
        sqliteLock?.release();
        serviceLock.release();
    }
    return restartRequested;
}
export function acquireUserServiceLock(input) {
    const serviceHome = resolve(input.serviceHome);
    mkdirSync(serviceHome, { recursive: true });
    return acquireLockFile(join(serviceHome, "service.lock"), {
        pid: process.pid,
        host: input.host,
        port: input.port,
        serviceHome,
        serviceVersion: MEMORY_SERVICE_VERSION,
        protocolVersion: MEMORY_PROTOCOL_VERSION,
        startedAt: new Date().toISOString()
    });
}
export function acquireSqliteServerLock(input) {
    if (!input.sqlitePath)
        return undefined;
    const sqlitePath = resolve(input.sqlitePath);
    const lockPath = `${sqlitePath}.server.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    return acquireLockFile(lockPath, {
        pid: process.pid,
        host: input.host,
        port: input.port,
        sqlitePath,
        startedAt: new Date().toISOString()
    });
}
function acquireLockFile(lockPath, payload) {
    const releaseGuard = acquireLockGuard(lockPath);
    payload = { ...payload, token: randomUUID() };
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
                writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
                try {
                    linkSync(temporaryPath, lockPath);
                }
                finally {
                    unlinkSync(temporaryPath);
                }
                let released = false;
                const release = () => {
                    if (released)
                        return;
                    released = true;
                    process.off("exit", release);
                    try {
                        const owner = readServerLock(readFileSync(lockPath, "utf8"));
                        if (owner?.pid === payload.pid && owner?.token === payload.token)
                            unlinkSync(lockPath);
                    }
                    catch {
                        // Stale lock cleanup is handled on the next startup.
                    }
                };
                process.once("exit", release);
                return { path: lockPath, release };
            }
            catch (error) {
                // Node/libuv maps Windows ERROR_ALREADY_EXISTS to EEXIST.
                if (!isNodeError(error) || (error.code !== "EEXIST" &&
                    !(error.code === "EPERM" && existsSync(lockPath)))) {
                    throw error;
                }
                let before, contents;
                try {
                    before = statSync(lockPath);
                    contents = readFileSync(lockPath, "utf8");
                }
                catch (readError) {
                    if (readError.code === "ENOENT") continue;
                    throw readError;
                }
                const existing = readServerLock(contents);
                if (!existing) {
                    if (Date.now() - before.mtimeMs < 30_000)
                        throw new Error(`Memory service is starting. Lock: ${lockPath}`);
                }
                if (!existing || !isProcessAlive(existing.pid)) {
                    const claimed = `${lockPath}.stale-${randomUUID()}`;
                    try {
                        renameSync(lockPath, claimed);
                    }
                    catch (claimError) {
                        if (claimError.code === "ENOENT") continue;
                        throw claimError;
                    }
                    const moved = statSync(claimed);
                    if (moved.dev !== before.dev || moved.ino !== before.ino ||
                        moved.mtimeMs !== before.mtimeMs || readFileSync(claimed, "utf8") !== contents) {
                        try {
                            linkSync(claimed, lockPath);
                            unlinkSync(claimed);
                        }
                        catch (restoreError) {
                            if (restoreError.code !== "EEXIST" &&
                                !(restoreError.code === "EPERM" && existsSync(lockPath))) throw restoreError;
                        }
                        throw new Error(`Memory service lock changed during stale recovery. Lock: ${lockPath}`);
                    }
                    unlinkSync(claimed);
                    continue;
                }
                throw new Error(`Memory service is already served by pid ${existing.pid}` +
                    `${existing.host && existing.port ? ` at ${existing.host}:${existing.port}` : ""}. ` +
                    `Stop that process before starting another Memory server. Lock: ${lockPath}`);
            }
        }
        throw new Error(`failed to acquire Memory sqlite server lock: ${lockPath}`);
    }
    finally {
        releaseGuard();
    }
}
function acquireLockGuard(lockPath) {
    const path = `${lockPath}.guard`;
    const marker = join(path, `${process.pid}.${randomUUID()}`);
    const busy = () => new Error(`Memory service lock update in progress. Lock: ${lockPath}`);
    const release = () => {
        try { unlinkSync(marker); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        try { rmdirSync(path); }
        catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error; }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            mkdirSync(path, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST") throw error;
            try {
                const age = Math.abs(Date.now() - statSync(path).mtimeMs);
                if (age < 5_000) throw busy();
                // Unique marker names plus rmdir prevent a stale reclaimer
                // from unlinking a replacement guard's owner (including ABA).
                for (const entry of readdirSync(path)) {
                    const ownerPath = join(path, entry);
                    const pid = Number(entry.split(".")[0]);
                    if (age <= 60_000 && (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid))) throw busy();
                    try { unlinkSync(ownerPath); }
                    catch (removeError) { if (removeError.code !== "ENOENT") throw removeError; }
                }
                try { rmdirSync(path); }
                catch (removeError) {
                    if (removeError.code === "ENOTEMPTY" || removeError.code === "EEXIST") throw busy();
                    if (removeError.code !== "ENOENT") throw removeError;
                }
            }
            catch (recoveryError) { if (recoveryError.code !== "ENOENT") throw recoveryError; }
            continue;
        }
        try {
            writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
            // A paused creator may have lost its empty directory to recovery.
            if (readdirSync(path).some((entry) => join(path, entry) !== marker)) throw busy();
            return release;
        }
        catch (error) {
            release();
            throw error;
        }
    }
    throw busy();
}
function writeRuntimeState(serviceHome, state) {
    mkdirSync(serviceHome, { recursive: true });
    const path = join(serviceHome, "runtime.json");
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
}
function removeRuntimeState(serviceHome) {
    const path = join(serviceHome, "runtime.json");
    try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        if (state.pid === process.pid)
            unlinkSync(path);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            logger.warn("runtime_state.remove_failed", { path, ...memoryErrorFields(error) });
        }
    }
}
function readServerLock(contents) {
    try {
        const value = JSON.parse(contents);
        return value && Number.isInteger(value.pid) && value.pid > 0 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function isProcessAlive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isNodeError(error) && error.code === "EPERM";
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function parseServeArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--config") {
            result.configPath = valueAfter(argv, index, arg);
            index += 1;
        }
        else if (arg?.startsWith("--config=")) {
            result.configPath = arg.slice("--config=".length);
        }
        else if (arg === "--db" || arg === "--sqlite-path") {
            result.dbPath = valueAfter(argv, index, arg);
            index += 1;
        }
        else if (arg?.startsWith("--db=")) {
            result.dbPath = arg.slice("--db=".length);
        }
        else if (arg?.startsWith("--sqlite-path=")) {
            result.dbPath = arg.slice("--sqlite-path=".length);
        }
        else if (arg === "--host") {
            result.host = valueAfter(argv, index, arg);
            index += 1;
        }
        else if (arg?.startsWith("--host=")) {
            result.host = arg.slice("--host=".length);
        }
        else if (arg === "--port") {
            result.port = parsePort(valueAfter(argv, index, arg));
            index += 1;
        }
        else if (arg?.startsWith("--port=")) {
            result.port = parsePort(arg.slice("--port=".length));
        }
    }
    return result;
}
function valueAfter(argv, index, option) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}
function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid port: ${value}`);
    }
    return port;
}
function numberEnv(name) {
    const value = process.env[name];
    if (!value)
        return undefined;
    return parsePort(value);
}
export { assertLoopbackBindHost };
export function agentSourceAutomationEnabled(env = process.env) {
    return env?.MEMHUB_CORE_AGENT_SOURCE_AUTOMATION === "1";
}
export async function writeCurrentEndpoint(configPath, endpoint) {
    try {
        await mutateMemoryConfig(configPath, (root) => {
            const memmyMemory = mutableRecord(root.memmyMemory);
            const storage = mutableRecord(memmyMemory.storage);
            storage.endpoint = endpoint;
            memmyMemory.storage = storage;
            root.memmyMemory = memmyMemory;
        });
    }
    catch (error) {
        logger.warn("config.endpoint_write_failed", {
            configPath,
            endpoint,
            ...memoryErrorFields(error)
        });
    }
}
function mutableRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ...value }
        : {};
}
export function isDirectRun(argvPath = process.argv[1], modulePath = fileURLToPath(import.meta.url)) {
    return argvPath !== undefined && realpathOrSelf(argvPath) === realpathOrSelf(modulePath);
}
function realpathOrSelf(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
if (isDirectRun()) {
    main().catch((error) => {
        logger.error("service.fatal", memoryErrorFields(error));
        process.exitCode = 1;
    });
}
