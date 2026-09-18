/** Adapter module. */
import { access } from "node:fs/promises";
import { resolveCursorDataPaths } from "../../agent-paths.js";
import { streamConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import { readCursorVscdb, streamCursorVscdb } from "./vscdb-reader.js";
import { discoverCursorWorkspaces } from "./workspace-discovery.js";
const CURSOR_SOURCE_ID = "cursor";
/** Creates create cursor source adapter. */
export function createCursorSourceAdapter(deps = {}) {
    const defaultPaths = resolveCursorDataPaths();
    const storageRoot = deps.storageRoot ?? defaultPaths.workspaceStorageDirectory;
    const globalStateDbPath = deps.globalStateDbPath ?? (deps.storageRoot ? undefined : defaultPaths.globalStateDbPath);
    const descriptor = deps.descriptor ??
        Object.freeze({
            sourceId: CURSOR_SOURCE_ID,
            displayName: "Cursor",
            builtin: true,
            dataPath: storageRoot
        });
    return {
        descriptor,
        async detect() {
            return await pathExists(storageRoot) || await optionalPathExists(globalStateDbPath);
        },
        async *scan(options) {
            throwIfAborted(options.signal);
            options.onProgress?.({
                sourceId: descriptor.sourceId,
                phase: "discover",
                current: 0,
                total: 1,
                message: "Discovering Cursor workspaces"
            });
            const workspaces = await discoverAvailableCursorWorkspaces(storageRoot, options);
            const targets = [
                ...workspaces.map(toWorkspaceScanTarget),
                ...(await discoverGlobalStateTarget(globalStateDbPath))
            ];
            options.onProgress?.({
                sourceId: descriptor.sourceId,
                phase: "discover",
                current: targets.length,
                total: targets.length
            });
            let emittedMessages = 0;
            for (const [targetIndex, target] of targets.entries()) {
                throwIfAborted(options.signal);
                if (limitReached(emittedMessages, options.maxMessages)) {
                    break;
                }
                options.onProgress?.({
                    sourceId: descriptor.sourceId,
                    phase: "read",
                    current: targetIndex,
                    total: targets.length,
                    message: target.storageHash
                });
                for await (const rawMessage of streamConversationWindow(options.fullHistory ? streamCursorVscdb(target.stateDbPath) : readCursorVscdb(target.stateDbPath), options.since, options.signal, remainingMessageCapacity(options.maxMessages, emittedMessages), options.fullHistory)) {
                    throwIfAborted(options.signal);
                    options.onProgress?.({
                        sourceId: descriptor.sourceId,
                        phase: "redact",
                        current: emittedMessages,
                        total: emittedMessages + 1
                    });
                    const message = toConversationMessage(descriptor.sourceId, target, rawMessage);
                    emittedMessages += 1;
                    options.onProgress?.({
                        sourceId: descriptor.sourceId,
                        phase: "emit",
                        current: emittedMessages,
                        total: emittedMessages
                    });
                    yield message;
                }
            }
            options.onProgress?.({
                sourceId: descriptor.sourceId,
                phase: "done",
                current: emittedMessages,
                total: emittedMessages
            });
        }
    };
}
/** Handles discover available cursor workspaces. */
async function discoverAvailableCursorWorkspaces(storageRoot, options) {
    if (!(await pathExists(storageRoot))) {
        return [];
    }
    return await discoverCursorWorkspaces({
        storageRoot,
        order: options.order === "recent_first" ? "recent_first" : "hash_asc",
        maxWorkspaces: options.maxScanTargets
    });
}
/** Handles discover global state target. */
async function discoverGlobalStateTarget(stateDbPath) {
    if (!stateDbPath || !(await pathExists(stateDbPath))) {
        return [];
    }
    return [
        {
            storageHash: "globalStorage",
            stateDbPath,
            workspacePath: null,
            gitRoot: null
        }
    ];
}
/** Handles to workspace scan target. */
function toWorkspaceScanTarget(workspace) {
    return {
        storageHash: workspace.storageHash,
        stateDbPath: workspace.stateDbPath,
        workspacePath: workspace.workspacePath,
        gitRoot: workspace.gitRoot
    };
}
/** Handles to conversation message. */
function toConversationMessage(sourceId, target, rawMessage) {
    return {
        messageId: rawMessage.messageId,
        sourceId,
        conversationId: rawMessage.conversationId,
        role: rawMessage.role,
        content: redactSecrets(rawMessage.content),
        createdAt: rawMessage.createdAt,
        workspacePath: target.workspacePath,
        gitRoot: target.gitRoot,
        rawMeta: Object.freeze({
            ...rawMessage.rawMeta,
            cursorStorageHash: target.storageHash
        })
    };
}
/** Handles throw if aborted. */
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new DOMException("Cursor source scan aborted", "AbortError");
    }
}
function limitReached(count, maxMessages) {
    return maxMessages !== undefined && count >= maxMessages;
}
/** Handles path exists. */
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
/** Handles optional path exists. */
async function optionalPathExists(path) {
    return path ? await pathExists(path) : false;
}
/** Checks is node error. */
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
