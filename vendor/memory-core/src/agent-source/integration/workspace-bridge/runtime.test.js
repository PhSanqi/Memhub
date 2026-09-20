import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "./runtime-loader.js";
import { openRuntimeSession, readRuntimeConfig } from "./runtime.js";

const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("Memory lifecycle runtime", () => {
    it("reads Memory connection and owner settings", async () => {
        const fixture = createFixture();
        const configUrl = pathToFileURL(join(fixture, "memmy-memory-config.json"));
        const configPath = join(fixture, "config.yaml");
        writeFileSync(configUrl, JSON.stringify({
            memmy_config_path: configPath,
            userId: "installed-owner",
            workspaceHostId: "a".repeat(64),
        }));
        writeFileSync(configPath, [
            "memmyMemory:",
            "  storage:",
            "    endpoint: http://127.0.0.1:18888",
            "    token: test-token",
            "",
        ].join("\n"));
        await expect(readRuntimeConfig(configUrl, true)).resolves.toEqual({
            endpoint: "http://127.0.0.1:18888",
            token: "test-token",
            userId: "installed-owner",
            workspaceHostId: "a".repeat(64),
        });
    });

    it("opens one ordinary session without L3 protocol negotiation", async () => {
        const fixture = createFixture();
        const requests = [];
        const server = createServer(async (request, response) => {
            if (request.url === "/api/v1/health") return json(response, 200, { ok: true });
            requests.push({ path: request.url ?? "", body: await requestBody(request) });
            return json(response, 200, { sessionId: "memory-session-1" });
        });
        const endpoint = await listen(server);
        try {
            const session = await openRuntimeSession({
                configUrl: runtimeConfig(fixture, endpoint),
                source: "codex",
                sessionKey: "codex-memory-project",
                workspaceRoot: fixture,
                pinnedOwner: true,
            });
            expect(session).toMatchObject({
                sessionId: "memory-session-1",
                projectId: null,
                workspaceRoot: null,
            });
            expect(requests).toEqual([{
                path: "/api/v1/sessions/open",
                body: {
                    sessionId: "codex-memory-project",
                    source: "codex",
                    workspacePath: fixture,
                },
            }]);
            expect(JSON.stringify(requests)).not.toContain("l3WorldModel");
        } finally {
            await close(server);
        }
    });

    it("ships a self-contained lifecycle asset without retired L3 protocol code", async () => {
        const asset = await loadMemmyWorkspaceBridgeRuntimeAsset();
        const imports = [...asset.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)]
            .map((match) => match[1]);
        expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
        expect(asset).not.toContain("environment-sync");
        expect(asset).not.toContain("RuntimeWorkspaceBridge");
        expect(asset).not.toContain("l3WorldModelProtocolVersion");
        expect(asset).not.toContain("/api/v1/l3-world-model");
        expect(asset).not.toContain("l3-world-model-boundary");
    });
});

function createFixture() {
    const directory = mkdtempSync(join(tmpdir(), "memmy-runtime-lifecycle-"));
    temporaryDirectories.push(directory);
    return directory;
}
function runtimeConfig(directory, endpoint) {
    const configUrl = pathToFileURL(join(directory, "memmy-memory-config.json"));
    writeFileSync(configUrl, JSON.stringify({
        endpoint,
        userId: "installed-owner",
        workspaceHostId: "a".repeat(64),
        memmy_config_path: join(directory, "missing.yaml"),
    }));
    return configUrl;
}
async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function requestBody(request) {
    let body = "";
    for await (const chunk of request) body += chunk;
    return body ? JSON.parse(body) : {};
}
function json(response, status, body) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}
