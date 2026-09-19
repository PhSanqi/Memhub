import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAccount,
  importNormifyAccounts,
  listAccounts,
  resolveCloudflareAccount,
  setAccountRole
} from "../dist/auth.js";
import { importNormifyCloudflarePin } from "../dist/cloudflare.js";
import { JsonConversationProjectBindingStore } from "../dist/binding-store.js";
import { buildContextCapsule } from "../dist/context-capsule.js";
import { ContextRouter } from "../dist/context-router.js";
import { assertLoopbackMemoryEndpoint } from "../dist/local-memory-client.js";
import { resolveProjectScope } from "../dist/project-scope.js";
import { createDevice, normalizeCaptureEvent } from "../dist/capture.js";
import { EmbeddedArchitectureSource } from "../dist/architecture-source.js";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";

const root = await mkdtemp(join(tmpdir(), "memhub-core-"));
const state = join(root, "state");
const normify = join(root, "normify");

try {
  assert.equal(resolveProjectScope({}).recallScope, "global_only");
  assert.equal(resolveProjectScope({ conversationProjectId: "aide" }).projectId, "aide");
  const conflict = resolveProjectScope({ conversationProjectId: "aide", workspaceProjectId: "memmy" });
  assert.equal(conflict.projectId, null);
  assert.equal(conflict.recallScope, "global_only");

  const capsule = buildContextCapsule({
    accountId: "acct",
    resolution: conflict,
    globalMemory: [{ id: "g", content: "global", authority: "remembered", scope: "global", source: "test" }],
    projectMemory: [{ id: "a", content: "aide", authority: "remembered", scope: "project", source: "test", projectId: "aide" }]
  });
  assert.equal(capsule.globalMemory.length, 1);
  assert.equal(capsule.projectMemory.length, 0);

  assert.doesNotThrow(() => assertLoopbackMemoryEndpoint("http://127.0.0.1:18960"));
  assert.doesNotThrow(() => assertLoopbackMemoryEndpoint("http://[::1]:18960"));
  assert.throws(() => assertLoopbackMemoryEndpoint("https://memory.example.test"), /non-loopback/);

  const embeddedMemory = new EmbeddedMemoryCore({
    stateRoot: join(root, "embedded-memory"),
    configPath: join(root, "embedded-memory", "config.yaml"),
    dbPath: join(root, "embedded-memory", "memory.sqlite")
  });
  assert.equal(existsSync(embeddedMemory.entrypoint), true);
  const embeddedArchitecture = new EmbeddedArchitectureSource({ rootDir: normify });
  assert.equal(existsSync(embeddedArchitecture.runtimeModule), true);
  assert.match(
    embeddedArchitecture.runtimeModule.replaceAll("\\", "/"),
    /\/vendor\/normify\/lib\/generic\.js$/
  );

  const calls = [];
  const memory = {
    async recall(input) {
      calls.push(input.projectId);
      return {
        globalMemory: [{ id: "g", content: "global", authority: "remembered", scope: "global", source: "test" }],
        projectMemory: input.projectId
          ? [{ id: "p", content: input.projectId, authority: "remembered", scope: "project", source: "test", projectId: input.projectId }]
          : []
      };
    },
    async remember() { return { ok: true }; }
  };
  const architecture = {
    async listProjects() { return ["aide", "memmy"]; },
    async getProjectArchitecture({ projectId }) {
      return [{ id: "arch", content: projectId, authority: "authoritative", scope: "project", source: "normify", projectId }];
    }
  };
  const router = new ContextRouter(memory, architecture, new JsonConversationProjectBindingStore(join(root, "bindings.json")));
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "继续 aide", conversationId: "chat" })).resolvedProjectId, "aide");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "继续", conversationId: "chat" })).resolvedProjectId, "aide");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "转到 memmy", conversationId: "chat" })).recallScope, "global_only");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "转到 memmy", conversationId: "chat", projectId: "memmy" })).resolvedProjectId, "memmy");
  assert.deepEqual(calls, ["aide", "aide", null, "memmy"]);

  const owner = await addAccount(state, "owner", "owner@example.com");
  await assert.rejects(() => resolveCloudflareAccount(state, { sub: "unknown", email: "unknown@example.com" }), /允许列表/);
  assert.equal((await resolveCloudflareAccount(state, { sub: "owner-sub", email: "owner@example.com" })).account_id, owner.account_id);
  await setAccountRole(state, owner.account_id, "admin");
  assert.equal((await listAccounts(state)).find((item) => item.account_id === owner.account_id)?.role, "admin");

  assert.equal(normalizeCaptureEvent({
    event_id: "partial-turn",
    host: "test",
    conversation_id: "conv",
    timestamp: "2026-09-18T08:00:00.000Z",
    user_text: "only user side"
  }).user_text, "only user side");
  assert.throws(() => normalizeCaptureEvent({
    event_id: "empty-turn",
    host: "test",
    conversation_id: "conv",
    timestamp: "2026-09-18T08:00:00.000Z"
  }), /requires user_text, assistant_text, or tool_summary/);
  const device = await createDevice(state, owner.account_id, "owner-laptop");
  const deviceStoreText = await readFile(join(state, "devices.json"), "utf8");
  assert.equal(deviceStoreText.includes(device.token), false);
  assert.match(deviceStoreText, /"token_hash":\s*"[a-f0-9]{64}"/);

  await mkdir(join(normify, ".normify"), { recursive: true });
  await writeFile(join(normify, ".normify", "accounts.json"), JSON.stringify({
    version: 1,
    accounts: {
      friend: {
        account_id: "stable-normify-account",
        created_at: "2026-01-01T00:00:00.000Z",
        cloudflare: { email: "friend@example.com" }
      }
    }
  }));
  await writeFile(join(normify, ".normify", "cloudflare-access.json"), JSON.stringify({
    version: 1,
    issuer: "https://unit-test.cloudflareaccess.com",
    audience: "unit-test-audience"
  }));
  assert.equal((await importNormifyAccounts(state, normify)).imported, 1);
  assert.deepEqual(await importNormifyCloudflarePin(state, normify), { imported: true, present: true });
  assert.deepEqual(await importNormifyCloudflarePin(state, normify), { imported: false, present: true });
  assert.equal((await listAccounts(state)).find((item) => item.username === "friend")?.account_id, "stable-normify-account");

  console.log("memhub-core-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
