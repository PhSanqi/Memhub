import { restartInstalledMemoryService } from "../cli/runtime-installer.js";
export const DESKTOP_MANAGED_MEMORY_ENV = "MEMMY_DESKTOP_MANAGED_MEMORY";
export const MEMORY_RESTART_IPC_TYPE = "memmy-memory:restart";
export async function requestMemoryServiceRestart(dependencies = {}) {
    const env = dependencies.env ?? process.env;
    if (env[DESKTOP_MANAGED_MEMORY_ENV] !== "1") {
        if ((dependencies.platform ?? process.platform) === "win32") {
            // Ending the scheduled task can also terminate a spawned restart helper.
            // Rebuild locally so the running task continues supervising this process.
            if (!dependencies.restartLocal)
                throw new Error("Windows Memory restart is unavailable");
            await dependencies.restartLocal();
            return;
        }
        return Promise.resolve((dependencies.restartInstalled ?? restartInstalledMemoryService)());
    }
    const send = dependencies.send === undefined ? processSend() : dependencies.send;
    if (send) {
        try {
            await new Promise((resolveRestart, rejectRestart) => {
                send({ type: MEMORY_RESTART_IPC_TYPE }, (error) => {
                    if (error)
                        rejectRestart(error);
                    else
                        resolveRestart();
                });
            });
            return;
        }
        catch (error) {
            const code = error.code;
            if (code !== "ERR_IPC_CHANNEL_CLOSED" && code !== "ERR_IPC_DISCONNECTED" && code !== "EPIPE")
                throw error;
        }
    }
    // Detached Memory outlives Desktop and cannot reconnect its original IPC pipe.
    if (!dependencies.restartLocal)
        throw new Error("Desktop-managed Memory restart is unavailable");
    await dependencies.restartLocal();
}
function processSend() {
    if (typeof process.send !== "function" || !process.connected)
        return undefined;
    return (message, callback) => {
        process.send(message, callback);
    };
}
