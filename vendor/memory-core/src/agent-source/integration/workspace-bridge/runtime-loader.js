import { readFile } from "node:fs/promises";
let runtimeAssetPromise = null;
export function loadMemmyWorkspaceBridgeRuntimeAsset() {
    runtimeAssetPromise ??= readFile(new URL("./memmy-workspace-bridge.mjs", import.meta.url), "utf8").then((content) => {
        if (!content.trim())
            throw new Error("Memmy lifecycle sidecar asset is empty");
        return content;
    }).catch((error) => {
        runtimeAssetPromise = null;
        throw new Error(`Memmy lifecycle sidecar asset is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    return runtimeAssetPromise;
}
