import { afterEach, describe, expect, it } from "vitest";
import type { MemoryService } from "../../src/service/memory-service.js";
import { createMemoryHttpServer } from "../../src/server/http.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("external Harness L3 REST contract", () => {
  it("leases, validates, commits, and idempotently retries through HTTP", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const userId = "external-http-user";
    createGlobalEvidence(service, repos, userId);

    const server = createMemoryHttpServer({ service });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const namespace = {
        source: "memhub-evolution",
        profileId: "default",
        userId
      };

      const leaseResponse = await fetch(`${endpoint}/api/v1/evolution/l3/lease`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapterId: "memhub-harness-evolution-test",
          namespace,
          projectId: null,
          leaseSeconds: 120
        })
      });
      expect(leaseResponse.status).toBe(200);
      const leased = await leaseResponse.json() as {
        job: {
          jobId: string;
          targetField: string;
          projectId: string | null;
          expectedFieldHash: string;
        };
      };
      expect(leased.job).toEqual(expect.objectContaining({
        targetField: "general_rules_and_safety_constraints",
        projectId: null,
        expectedFieldHash: expect.any(String)
      }));

      const wrongUser = await fetch(`${endpoint}/api/v1/evolution/l3/${leased.job.jobId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          namespace: { ...namespace, userId: "another-user" },
          projectId: null,
          expectedFieldHash: leased.job.expectedFieldHash,
          candidate: {
            op: "create",
            general_rules_and_safety_constraints: "- Verify destructive changes."
          }
        })
      });
      expect(wrongUser.status).toBe(403);
      await expect(wrongUser.json()).resolves.toMatchObject({
        error: { code: "forbidden" }
      });

      const invalid = await fetch(`${endpoint}/api/v1/evolution/l3/${leased.job.jobId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          namespace,
          projectId: null,
          expectedFieldHash: leased.job.expectedFieldHash,
          candidate: { op: "create", wrong_field: "invalid" }
        })
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        error: { code: "invalid_argument" }
      });
      expect(repos.runtime.getJob(leased.job.jobId)?.status).toBe("leased");

      const submission = {
        namespace,
        projectId: null,
        expectedFieldHash: leased.job.expectedFieldHash,
        candidate: {
          op: "create",
          general_rules_and_safety_constraints: "- Verify destructive changes."
        }
      };
      const submitResponse = await fetch(`${endpoint}/api/v1/evolution/l3/${leased.job.jobId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission)
      });
      expect(submitResponse.status).toBe(200);
      const submitted = await submitResponse.json() as { ok: boolean; memoryId?: string };
      expect(submitted.ok).toBe(true);
      expect(submitted.memoryId).toEqual(expect.any(String));
      expect(repos.l3WorldModels.fields(userId, null).generalRulesAndSafetyConstraints)
        .toBe("- Verify destructive changes.");

      const retryResponse = await fetch(`${endpoint}/api/v1/evolution/l3/${leased.job.jobId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission)
      });
      expect(retryResponse.status).toBe(200);
      await expect(retryResponse.json()).resolves.toMatchObject({
        ok: true,
        jobId: leased.job.jobId,
        memoryId: submitted.memoryId
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

function createGlobalEvidence(service: MemoryService, repos: Repositories, userId: string): void {
  const namespace = {
    source: "codex",
    profileId: "default",
    sessionKey: "external-http-session",
    userId
  };
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    namespace
  });
  const completed = service.completeTurn("external-http-turn", {
    sessionId: opened.sessionId,
    query: "Always verify destructive changes before applying them.",
    answer: "Recorded.",
    status: "succeeded",
    toolCalls: [{ name: "verify_change", input: { destructive: true }, success: true }],
    toolResults: [{ name: "verify_change", output: "verified", exitCode: 0 }]
  });
  if (!completed.l1MemoryId) throw new Error("expected captured L1 evidence");
  repos.l3WorldModels.registerInputTrace({
    sessionId: opened.sessionId,
    l1MemoryId: completed.l1MemoryId,
    rawTurnId: completed.rawTurnId
  });
  repos.l3WorldModels.freezeBatches({
    sessionId: opened.sessionId,
    trigger: "new_task",
    throughL1MemoryId: completed.l1MemoryId
  });
  service.closeSession(opened.sessionId);
}
