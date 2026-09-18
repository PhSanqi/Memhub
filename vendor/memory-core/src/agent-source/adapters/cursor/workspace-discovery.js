/** Workspace discovery module. */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDirectoryIfExists } from "../read-directory.js";
/** Handles discover cursor workspaces. */
export async function discoverCursorWorkspaces(options) {
    const entries = await readDirectoryIfExists(options.storageRoot);
    const workspaces = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const storagePath = join(options.storageRoot, entry.name);
        const stateDbPath = join(storagePath, "state.vscdb");
        const stateDbStat = await fileStat(stateDbPath);
        if (!stateDbStat?.isFile()) {
            continue;
        }
        const workspacePath = await readWorkspacePath(storagePath);
        workspaces.push({
            storageHash: entry.name,
            storagePath,
            stateDbPath,
            workspacePath,
            gitRoot: workspacePath ? findGitRoot(workspacePath) : null,
            mtimeMs: stateDbStat.mtimeMs
        });
    }
    return workspaces
        .sort((left, right) => options.order === "recent_first"
        ? right.mtimeMs - left.mtimeMs || right.storageHash.localeCompare(left.storageHash)
        : left.storageHash.localeCompare(right.storageHash))
        .slice(0, options.maxWorkspaces ?? workspaces.length)
        .map(({ mtimeMs: _mtimeMs, ...workspace }) => workspace);
}
/** Reads read workspace path. */
async function readWorkspacePath(storagePath) {
    try {
        const content = await readFile(join(storagePath, "workspace.json"), "utf8");
        const parsed = JSON.parse(content);
        if (!isRecord(parsed)) {
            return null;
        }
        return normalizeWorkspacePath(getString(parsed.folder) ?? getString(parsed.workspace));
    }
    catch {
        return null;
    }
}
/** Normalizes normalize workspace path. */
function normalizeWorkspacePath(value) {
    if (!value) {
        return null;
    }
    if (!value.startsWith("file://")) {
        return value;
    }
    try {
        return fileURLToPath(value);
    }
    catch {
        return null;
    }
}
/** Handles find git root. */
function findGitRoot(workspacePath) {
    let current = workspacePath;
    while (current !== dirname(current)) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }
        current = dirname(current);
    }
    return existsSync(join(current, ".git")) ? current : null;
}
/** Handles file stat. */
async function fileStat(path) {
    try {
        return await stat(path);
    }
    catch {
        return null;
    }
}
/** Checks is record. */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Reads get string. */
function getString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
