#!/usr/bin/env node
import { mutateMemoryConfig } from "../config/writer.js";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorageBackend } from "../storage/backend.js";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { MemoryService } from "../service/memory-service.js";
import { closeMemoryHttpServer, listenMemoryHttpServer } from "./http.js";
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
            startAgentSourceAutomation: true
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = openSync(lockPath, "wx");
            try {
                writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            }
            finally {
                closeSync(fd);
            }
            let released = false;
            const release = () => {
                if (released)
                    return;
                released = true;
                process.off("exit", release);
                try {
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
            if (!isNodeError(error) || error.code !== "EEXIST") {
                throw error;
            }
            const existing = readServerLock(lockPath);
            if (!existing || !isProcessAlive(existing.pid)) {
                try {
                    unlinkSync(lockPath);
                }
                catch (unlinkError) {
                    if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
                        throw unlinkError;
                    }
                }
                continue;
            }
            throw new Error(`Memory service is already served by pid ${existing.pid}` +
                `${existing.host && existing.port ? ` at ${existing.host}:${existing.port}` : ""}. ` +
                `Stop that process before starting another Memory server. Lock: ${lockPath}`);
        }
    }
    throw new Error(`failed to acquire Memory sqlite server lock: ${lockPath}`);
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
function readServerLock(lockPath) {
    try {
        return JSON.parse(readFileSync(lockPath, "utf8"));
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
export function assertLoopbackBindHost(host) {
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
        throw new Error(`Memory service must listen on a loopback address, received: ${host}`);
    }
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
