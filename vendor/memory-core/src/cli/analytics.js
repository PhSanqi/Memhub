import { randomUUID } from "node:crypto";
import { existsSync as nodeExistsSync, mkdirSync as nodeMkdirSync, readFileSync as nodeReadFileSyncFs, writeFileSync as nodeWriteFileSync, } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { join as nodeJoin } from "node:path";
import { hasOption, optionString, parseArgs } from "./args.js";
import { DEFAULT_MEMORY_URL, loadCliMemoryConfig } from "./config.js";
import { PROJECT_VERSION } from "./project-version.js";
export const CLI_ANALYTICS_EVENTS = {
    invoked: "memmy_cli_invoked",
    completed: "memmy_cli_completed",
    failed: "memmy_cli_failed",
};
const DEFAULT_ENGAGEMENT_TIME_MSEC = 100;
const ANALYTICS_PATH = "/api/analytics/events";
const CLIENT_ID_FILENAME = "analytics-client-id";
const INSTALLATION_ID_FILENAME = "installation-id";
const CLI_ANALYTICS_SOURCE = "memmy-memory";
export function resolveAnalyticsBaseUrl(env = process.env) {
    const raw = env.MEMMY_CLOUD_SERVICE?.trim();
    if (!raw)
        return null;
    return raw.replace(/\/+$/, "");
}
export function resolveAnalyticsAppEnv(env = process.env) {
    const explicit = env.MEMMY_APP_ENV?.trim().toLowerCase();
    if (explicit === "dev" || explicit === "prod")
        return explicit;
    return env.NODE_ENV === "production" ? "prod" : "dev";
}
export function resolveAnalyticsDebugMode(env = process.env, appEnv = resolveAnalyticsAppEnv(env)) {
    const explicit = env.MEMMY_GA4_DEBUG === "true" ||
        env.MEMMY_GA4_DEBUG === "1" ||
        env.VITE_GA4_DEBUG === "true";
    return appEnv === "dev" || explicit;
}
export function resolveAnalyticsEnvParams(options = {}) {
    const env = options.env ?? process.env;
    const appEnv = options.appEnv === "dev" || options.appEnv === "prod"
        ? options.appEnv
        : resolveAnalyticsAppEnv(env);
    const debugMode = typeof options.debugMode === "boolean"
        ? options.debugMode
        : resolveAnalyticsDebugMode(env, appEnv);
    return {
        app_env: appEnv,
        ...(debugMode ? { debug_mode: 1 } : {}),
    };
}
export function compactAnalyticsParams(params = {}) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
export function getAnalyticsClientIdPath(env = process.env, homeDir = nodeHomedir()) {
    const memmyHome = (env.MEMMY_HOME?.trim() || nodeJoin(homeDir, ".memmy")).replace(/^~(?=$|[/\\])/, homeDir);
    return nodeJoin(memmyHome, CLIENT_ID_FILENAME);
}
export function readAnalyticsClientId(options = {}) {
    const filePath = getAnalyticsClientIdPath(options.env, options.homeDir);
    const existsSync = options.existsSync ?? nodeExistsSync;
    const readFileSync = options.readFileSync ?? ((path, encoding) => nodeReadFileSyncFs(path, encoding));
    try {
        if (!existsSync(filePath))
            return null;
        const existing = readFileSync(filePath, "utf8").trim();
        return existing || null;
    }
    catch {
        return null;
    }
}
export function getOrCreateInstallationId(options = {}) {
    const homeDir = options.homeDir ?? nodeHomedir();
    const memmyHome = (options.env?.MEMMY_HOME?.trim() || nodeJoin(homeDir, ".memmy")).replace(/^~(?=$|[/\\])/, homeDir);
    const filePath = nodeJoin(memmyHome, INSTALLATION_ID_FILENAME);
    try {
        if (nodeExistsSync(filePath)) {
            const existing = nodeReadFileSyncFs(filePath, "utf8").trim();
            if (existing)
                return existing;
        }
    }
    catch {
        // Recreate an unreadable or empty identifier below.
    }
    const installationId = randomUUID();
    nodeMkdirSync(memmyHome, { recursive: true });
    nodeWriteFileSync(filePath, `${installationId}\n`, "utf8");
    return installationId;
}
export function normalizeAnalyticsUserId(userId) {
    const trimmed = userId?.trim() || null;
    if (!trimmed || trimmed === "local-user")
        return null;
    return trimmed;
}
export function resolveAnalyticsUserMode(mode) {
    return mode === "account" || mode === "account_byok" || mode === "byok" ? mode : null;
}
export function resolveAnalyticsUserModeParams(mode, userId) {
    const resolved = resolveAnalyticsUserMode(mode);
    if (!userId)
        return { user_mode: "byok" };
    return { user_mode: resolved === "byok" || resolved === "account_byok" ? "account_byok" : "account" };
}
export function toTimestampMicros(eventTimeMillis) {
    return Math.max(0, Math.trunc(eventTimeMillis)) * 1000;
}
export function postAnalyticsEvents(input) {
    const clientId = input.clientId?.trim() || null;
    const installationId = input.installationId?.trim() || getOrCreateInstallationId({ env: input.env });
    const userId = normalizeAnalyticsUserId(input.userId);
    const userModeParams = resolveAnalyticsUserModeParams(input.userMode, userId);
    const env = input.env ?? process.env;
    const resolvedBase = input.baseUrl !== undefined ? input.baseUrl : resolveAnalyticsBaseUrl(env);
    const baseUrl = resolvedBase?.replace(/\/+$/, "") || null;
    const events = Array.isArray(input.events) ? input.events : [];
    if (!baseUrl || !installationId || events.length === 0) {
        return Promise.resolve();
    }
    const envParams = resolveAnalyticsEnvParams({
        env,
        appEnv: input.appEnv,
        debugMode: input.debugMode,
    });
    const body = {
        ...(clientId ? { clientId } : {}),
        ...(userId ? { userId } : {}),
        installationId,
        events: events.map((event) => {
            const eventTimeMillis = event.eventTimeMillis ?? Date.now();
            return {
                eventName: event.eventName,
                params: compactAnalyticsParams({
                    engagement_time_msec: DEFAULT_ENGAGEMENT_TIME_MSEC,
                    source: event.source ?? "memmy-memory",
                    ...userModeParams,
                    ...(event.params ?? {}),
                    ...(userId ? { user_id: userId } : {}),
                    ...envParams,
                    app_version: PROJECT_VERSION,
                    timestamp_micros: toTimestampMicros(eventTimeMillis),
                }),
            };
        }),
    };
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    return fetchImpl(`${baseUrl}${ANALYTICS_PATH}`, {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json;charset=UTF-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    })
        .then(() => undefined)
        .catch(() => undefined);
}
export function trackAnalyticsEvent(input) {
    const { eventName, params, eventTimeMillis, ...rest } = input;
    return postAnalyticsEvents({
        ...rest,
        events: [{ eventName, params, eventTimeMillis }],
    });
}
export function createQueuedAnalytics(options = {}) {
    const source = options.source;
    const getClientId = options.getClientId ?? (() => readAnalyticsClientId({ env: options.env }));
    const getInstallationId = options.getInstallationId ?? (() => getOrCreateInstallationId({ env: options.env }));
    const getUserId = options.getUserId ?? (() => null);
    const getUserMode = options.getUserMode ?? (() => null);
    let pending = [];
    let lastEventTimeMillis = 0;
    let inflight = Promise.resolve();
    let flushScheduled = false;
    const append = (eventName, params = {}) => {
        const eventTimeMillis = Math.max(Date.now(), lastEventTimeMillis + 1);
        lastEventTimeMillis = eventTimeMillis;
        pending.push({
            eventName,
            params: { ...params },
            source,
            eventTimeMillis,
        });
    };
    const flushNow = () => {
        flushScheduled = false;
        const batch = pending;
        pending = [];
        if (batch.length === 0)
            return inflight;
        const run = () => postAnalyticsEvents({
            events: batch,
            clientId: getClientId(),
            installationId: getInstallationId(),
            userId: getUserId(),
            userMode: getUserMode(),
            appEnv: options.appEnv,
            debugMode: options.debugMode,
            fetchImpl: options.fetchImpl,
            baseUrl: options.baseUrl,
            env: options.env,
        });
        inflight = inflight.then(run, run).then(() => undefined, () => undefined);
        return inflight;
    };
    const scheduleFlush = () => {
        if (flushScheduled)
            return;
        flushScheduled = true;
        queueMicrotask(() => {
            void flushNow();
        });
    };
    return {
        track(eventName, params = {}) {
            append(eventName, params);
            scheduleFlush();
        },
        trackAwait(eventName, params = {}) {
            append(eventName, params);
            return flushNow();
        },
        flush() {
            return flushNow();
        },
    };
}
export function createCliAnalytics(options = {}) {
    return createQueuedAnalytics({
        ...options,
        source: options.source ?? CLI_ANALYTICS_SOURCE,
        getClientId: options.getClientId ?? (() => readAnalyticsClientId()),
        getInstallationId: options.getInstallationId,
    });
}
export function errorCodeFromUnknown(error) {
    if (error && typeof error === "object" && "status" in error) {
        const status = error.status;
        if (typeof status === "number" && Number.isFinite(status))
            return `http_${status}`;
    }
    if (error instanceof Error) {
        const name = error.name?.trim();
        if (name && name !== "Error")
            return name.slice(0, 64);
        const message = error.message?.trim();
        if (message)
            return message.slice(0, 64);
    }
    return "unknown";
}
export function elapsedMs(startedAt, endedAt = Date.now()) {
    return Math.max(0, endedAt - startedAt);
}
export function resolveInstallChannel(env = process.env, argvPath = process.argv[1]) {
    const explicit = env.MEMMY_INSTALL_CHANNEL?.trim();
    if (explicit)
        return explicit;
    const normalized = (argvPath ?? "").replace(/\\/g, "/").toLowerCase();
    if (normalized.includes("/node_modules/"))
        return "npm";
    if (normalized.includes("/resources/cli/") ||
        normalized.includes("/contents/resources/") ||
        normalized.includes("app.asar")) {
        return "desktop";
    }
    if (normalized.includes("/memory/dist/") ||
        normalized.includes("/memory/src/cli/") ||
        normalized.endsWith("/memory/dist/src/cli/index.js")) {
        return "dev";
    }
    return "unknown";
}
export function resolveMemoryEndpointUrl(argv) {
    const parsed = parseArgs(argv);
    const url = optionString(parsed.options, "url");
    if (url)
        return url;
    const { config } = loadCliMemoryConfig(optionString(parsed.options, "config"));
    return config.endpoint ?? DEFAULT_MEMORY_URL;
}
export function resolveEndpointKind(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "::1" ||
            hostname === "[::1]") {
            return "local";
        }
    }
    catch {
        // fall through
    }
    return "remote";
}
export function resolveCommandIdentity(argv) {
    const parsed = parseArgs(argv);
    const words = parsed.positionals;
    const options = parsed.options;
    if (hasOption(options, "help") || hasOption(options, "h")) {
        return {
            command_group: "help",
            has_session_id: false,
            has_turn_id: false,
        };
    }
    if (hasOption(options, "version") || hasOption(options, "v")) {
        return {
            command_group: "version",
            has_session_id: false,
            has_turn_id: false,
        };
    }
    if (words.length === 0 || words[0] === "help") {
        return {
            command_group: "help",
            has_session_id: false,
            has_turn_id: false,
        };
    }
    const group = words[0] ?? "help";
    const action = words[1];
    const positionalId = words[2]?.trim() || "";
    const has_session_id = Boolean(optionString(options, "session-id")?.trim()) ||
        bodyHasStringField(options, "sessionId") ||
        (group === "session" && (action === "close" || action === "open") && Boolean(positionalId));
    const has_turn_id = Boolean(optionString(options, "turn-id")?.trim()) ||
        bodyHasStringField(options, "turnId") ||
        (group === "turn" && action === "complete" && Boolean(positionalId));
    return {
        command_group: group,
        ...(action ? { command_action: action } : {}),
        has_session_id,
        has_turn_id,
    };
}
export function resolveCliAgentSourceId(argv) {
    const parsed = parseArgs(argv);
    const direct = optionString(parsed.options, "source")?.trim();
    if (direct)
        return direct;
    const fromBody = bodyStringField(parsed.options, "source");
    return fromBody || undefined;
}
function normalizeRawPath(path) {
    const trimmed = path.trim();
    if (!trimmed)
        return "";
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
/** Internal automation (npm worker:run, backend cron) — not user or agent CLI usage. */
export function isInfrastructureCliInvocation(argv, env = process.env) {
    if (env.MEMMY_CLI_ANALYTICS_SKIP === "1" || env.MEMMY_CLI_ANALYTICS_SKIP === "true") {
        return true;
    }
    const parsed = parseArgs(argv);
    const words = parsed.positionals;
    if (words[0] !== "raw")
        return false;
    const method = (words[1] ?? "").toUpperCase();
    const path = normalizeRawPath(words[2] ?? "");
    return method === "POST" && (path === "/worker/run" || path === "/api/v1/worker/run");
}
/** Track agent calls, manual terminal usage; skip startup/automation such as worker/run. */
export function shouldTrackCliAnalytics(argv, env = process.env) {
    return !isInfrastructureCliInvocation(argv, env);
}
export function createNoopCliAnalytics() {
    return {
        track() { },
        trackAwait() {
            return Promise.resolve();
        },
        flush() {
            return Promise.resolve();
        },
    };
}
export function resolveCliAnalyticsParams(argv, options = {}) {
    const env = options.env ?? process.env;
    const identity = resolveCommandIdentity(argv);
    const endpointUrl = resolveMemoryEndpointUrl(argv);
    const agentSourceId = resolveCliAgentSourceId(argv);
    return compactAnalyticsParams({
        command_group: identity.command_group,
        ...(identity.command_action ? { command_action: identity.command_action } : {}),
        ...(agentSourceId ? { source_id: agentSourceId } : {}),
        cli_version: PROJECT_VERSION,
        install_channel: resolveInstallChannel(env, options.argvPath ?? process.argv[1]),
        endpoint_kind: resolveEndpointKind(endpointUrl),
        has_session_id: identity.has_session_id,
        has_turn_id: identity.has_turn_id,
    });
}
function bodyStringField(options, field) {
    const bodyText = optionString(options, "body") ?? optionString(options, "json") ?? optionString(options, "data");
    if (!bodyText)
        return undefined;
    const trimmed = bodyText.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("[")))
        return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return undefined;
        const value = parsed[field];
        return typeof value === "string" && value.trim() ? value.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
function bodyHasStringField(options, field) {
    return Boolean(bodyStringField(options, field));
}
