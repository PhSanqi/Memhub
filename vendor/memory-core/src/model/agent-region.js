import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export function packagedDesktopEditionManifestPath(modelDirectory = import.meta.dirname) {
    const normalized = resolve(modelDirectory).replace(/\\/g, "/");
    if (normalized.includes("/memory-runtime/dist/")) {
        return resolve(modelDirectory, "../../../../app.asar/dist/main/desktop-edition.json");
    }
    return resolve(modelDirectory, "../../../../main/desktop-edition.json");
}
export function resolveMemoryAgentRegion(sourceProvider, options = {}) {
    if (sourceProvider !== "memmy_account")
        return undefined;
    const manifest = readDesktopEditionManifest(options.manifestPath ?? packagedDesktopEditionManifestPath());
    const manifestRegion = regionFromIdentity(manifest?.edition, manifest?.accountChannel);
    if (manifestRegion)
        return manifestRegion;
    const env = options.env ?? process.env;
    return regionFromIdentity(env.MEMMY_APP_EDITION, env.MEMMY_ACCOUNT_CHANNEL) ?? "cn";
}
function readDesktopEditionManifest(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function regionFromIdentity(edition, accountChannel) {
    if (edition === "intl")
        return "intl";
    if (edition === "cn")
        return "cn";
    if (accountChannel === "email")
        return "intl";
    if (accountChannel === "phone")
        return "cn";
    return undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
