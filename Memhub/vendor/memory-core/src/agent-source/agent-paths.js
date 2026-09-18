import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";
export function resolveClaudeCodeHomeDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.CLAUDE_CONFIG_DIR, runtime.pathApi.join(runtime.homeDirectory, ".claude"), runtime);
}
export function resolveClaudeCodeProjectsDirectory(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolveClaudeCodeHomeDirectory(options), "projects");
}
export function resolveCodexHomeDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.CODEX_HOME, runtime.pathApi.join(runtime.homeDirectory, ".codex"), runtime);
}
export function resolveCodexSessionsDirectory(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolveCodexHomeDirectory(options), "sessions");
}
export function resolveOpencodeConfigDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    const xdgConfigRoot = resolveConfiguredDirectory(runtime.environment.XDG_CONFIG_HOME, runtime.pathApi.join(runtime.homeDirectory, ".config"), runtime);
    return resolveConfiguredDirectory(runtime.environment.OPENCODE_CONFIG_DIR, runtime.pathApi.join(xdgConfigRoot, "opencode"), runtime);
}
export function resolveOpencodeDataDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    const xdgDataRoot = resolveConfiguredDirectory(runtime.environment.XDG_DATA_HOME, runtime.pathApi.join(runtime.homeDirectory, ".local", "share"), runtime);
    return runtime.pathApi.join(xdgDataRoot, "opencode");
}
export function resolveOpencodeDatabasePath(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolveOpencodeDataDirectory(options), "opencode.db");
}
export function resolveOpenclawStateDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.OPENCLAW_STATE_DIR, runtime.pathApi.join(runtime.homeDirectory, ".openclaw"), runtime);
}
export function resolveOpenclawConfigPath(stateDirectory, options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.OPENCLAW_CONFIG_PATH, runtime.pathApi.join(stateDirectory ?? resolveOpenclawStateDirectory(options), "openclaw.json"), runtime);
}
export function resolveHermesHomeDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.HERMES_HOME, runtime.pathApi.join(runtime.homeDirectory, ".hermes"), runtime);
}
export function resolveDeepseekHarnessHomeDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.DSH_HOME, runtime.pathApi.join(runtime.homeDirectory, ".dsh"), runtime);
}
export function resolveDeepseekHarnessSessionsDirectory(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolveDeepseekHarnessHomeDirectory(options), "sessions");
}
export function resolveWorkbuddyHomeDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.WORKBUDDY_CONFIG_DIR?.trim() ||
        runtime.environment.CODEBUDDY_CONFIG_DIR?.trim(), runtime.pathApi.join(runtime.homeDirectory, ".workbuddy"), runtime);
}
export function resolveWorkbuddyProjectsDirectory(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolveWorkbuddyHomeDirectory(options), "projects");
}
export function resolvePiAgentDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.PI_CODING_AGENT_DIR, runtime.pathApi.join(runtime.homeDirectory, ".pi", "agent"), runtime);
}
export function resolvePiSessionsDirectory(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolvePiAgentDirectory(options), "sessions");
}
export function resolveQwenworkHomeDirectory(options = {}) {
    const runtime = createAgentPathRuntime(options);
    return resolveConfiguredDirectory(runtime.environment.QWENWORK_CONFIG_DIR, runtime.pathApi.join(runtime.homeDirectory, ".qwenworkcn"), runtime);
}
export function resolveQwenworkProjectsDirectory(options = {}) {
    return createAgentPathRuntime(options).pathApi.join(resolveQwenworkHomeDirectory(options), "projects");
}
export function resolveCursorDataPaths(options = {}) {
    const runtime = createAgentPathRuntime(options);
    const platform = options.platform ?? process.platform;
    const userDirectory = platform === "win32"
        ? runtime.pathApi.join(options.appDataDirectory?.trim() ||
            runtime.environment.APPDATA?.trim() ||
            runtime.pathApi.join(runtime.homeDirectory, "AppData", "Roaming"), "Cursor", "User")
        : platform === "darwin"
            ? runtime.pathApi.join(runtime.homeDirectory, "Library", "Application Support", "Cursor", "User")
            : runtime.pathApi.join(options.xdgConfigDirectory?.trim() ||
                runtime.environment.XDG_CONFIG_HOME?.trim() ||
                runtime.pathApi.join(runtime.homeDirectory, ".config"), "Cursor", "User");
    return {
        userDirectory,
        workspaceStorageDirectory: runtime.pathApi.join(userDirectory, "workspaceStorage"),
        globalStateDbPath: runtime.pathApi.join(userDirectory, "globalStorage", "state.vscdb")
    };
}
export function resolveAgentPath(value) {
    return resolveAgentPathWithRuntime(value, {
        environment: process.env,
        homeDirectory: homedir(),
        pathApi: { isAbsolute, join, normalize, resolve }
    });
}
function createAgentPathRuntime(options = {}) {
    const platform = options.platform ?? process.platform;
    return {
        environment: options.environment ?? process.env,
        homeDirectory: options.homeDirectory ?? homedir(),
        pathApi: platform === "win32" ? win32 : posix
    };
}
function resolveConfiguredDirectory(value, fallback, runtime) {
    return value?.trim() ? resolveAgentPathWithRuntime(value.trim(), runtime) : fallback;
}
function resolveAgentPathWithRuntime(value, runtime) {
    const expanded = value === "~"
        ? runtime.homeDirectory
        : value.startsWith("~/") || value.startsWith("~\\")
            ? runtime.pathApi.join(runtime.homeDirectory, value.slice(2))
            : value;
    return runtime.pathApi.isAbsolute(expanded)
        ? runtime.pathApi.normalize(expanded)
        : runtime.pathApi.resolve(expanded);
}
