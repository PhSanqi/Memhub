/** Hook command helpers. */
import { accessSync, constants, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { resolveHermesHomeDirectory } from "../agent-paths.js";
/** Creates a shell command that runs a hook script with Node, never Electron. */
export function createNodeHookCommand(hookScriptPath, runtime = defaultNodeExecutableRuntime()) {
    return `${shellQuote(resolveNodeExecutable(runtime), runtime.platform)} ${shellQuote(hookScriptPath, runtime.platform)}`;
}
/** Resolves Node without ever selecting a packaged desktop application host. */
export function resolveNodeExecutable(runtime = defaultNodeExecutableRuntime()) {
    const nodeName = runtime.platform === "win32" ? "node.exe" : "node";
    const candidates = [
        runtime.env.MEMMY_HOOK_NODE,
        runtime.env.NODE,
        runtime.execPath,
        join(runtime.hermesHomeDirectory, "node", "bin", nodeName),
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "node"
    ];
    return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0 &&
        isSafeNodeCandidate(candidate, nodeName, runtime.isExecutableFile)) ?? "node";
}
function defaultNodeExecutableRuntime() {
    return {
        platform: process.platform,
        env: process.env,
        execPath: process.execPath,
        hermesHomeDirectory: resolveHermesHomeDirectory(),
        isExecutableFile
    };
}
function isSafeNodeCandidate(candidate, nodeName, isExecutable) {
    if (isPackagedApplicationExecutable(candidate)) {
        return false;
    }
    if (basename(candidate).toLowerCase() !== nodeName.toLowerCase()) {
        return false;
    }
    return candidate === nodeName || !isAbsolute(candidate) || isExecutable(candidate);
}
function isExecutableFile(candidate) {
    try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
    }
    catch {
        return false;
    }
}
function isPackagedApplicationExecutable(value) {
    const name = basename(value).toLowerCase();
    return name.includes("electron") || /\.app[\\/]contents[\\/]macos[\\/]/i.test(value);
}
function shellQuote(value, platform) {
    if (platform === "win32") {
        // cmd.exe treats single quotes as literal characters and PowerShell parses
        // them as string expressions, so the POSIX form never executes on Windows.
        if (!/[\s"\\/]/.test(value))
            return value;
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return `'${value.replace(/'/g, "'\\''")}'`;
}
