import { afterEach, describe, expect, it } from "vitest";
import type { MemoryService } from "../../../src/service/memory-service.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { MemoryServiceError } from "../../../src/utils/error.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("external Harness L3 evolution", () => {
  it("leases and commits only the requested account/global scope", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    captureGlobalTurn(service, repos, "external-user-a", "external-global-a", "Always ask before deleting files.");
    captureGlobalTurn(service, repos, "external-user-b", "external-global-b", "Prefer concise status updates.");

    const leaseA = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-user-a"),
      projectId: null,
      leaseSeconds: 120
    });
    expect(leaseA.job).not.toBeNull();
    expect(leaseA.job).toEqual(expect.objectContaining({
      userId: "external-user-a",
      projectId: null,
      targetField: "general_rules_and_safety_constraints",
      expectedFieldHash: expect.any(String),
      systemPrompt: expect.stringContaining("valid JSON object"),
      rawTurns: expect.any(Array)
    }));
    expect(leaseA.job!.rawTurns[0]).toEqual(expect.objectContaining({
      user_text: "Always ask before deleting files."
    }));

    const wrongUserSubmit = () => service.submitExternalL3WorldModel(leaseA.job!.jobId, {
      namespace: evolutionNamespace("external-user-b"),
      projectId: null,
      expectedFieldHash: leaseA.job!.expectedFieldHash,
      candidate: {
        op: "create",
        general_rules_and_safety_constraints: "- Ask before deleting files."
      }
    });
    expect(wrongUserSubmit).toThrowError(expect.objectContaining({
      name: "MemoryServiceError",
      code: "forbidden"
    }));

    const committed = service.submitExternalL3WorldModel(leaseA.job!.jobId, {
      namespace: evolutionNamespace("external-user-a"),
      projectId: null,
      expectedFieldHash: leaseA.job!.expectedFieldHash,
      candidate: {
        op: "create",
        general_rules_and_safety_constraints: "- Ask before deleting files."
      }
    });
    expect(committed).toEqual(expect.objectContaining({
      ok: true,
      jobId: leaseA.job!.jobId,
      projectId: null,
      targetField: "general_rules_and_safety_constraints",
      noChange: false
    }));
    expect(repos.runtime.getJob(leaseA.job!.jobId)?.status).toBe("succeeded");
    expect(repos.l3WorldModels.fields("external-user-a", null).generalRulesAndSafetyConstraints)
      .toBe("- Ask before deleting files.");
    expect(repos.l3WorldModels.fields("external-user-b", null).generalRulesAndSafetyConstraints)
      .toBeNull();

    const leaseB = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-user-b"),
      projectId: null
    });
    expect(leaseB.job?.userId).toBe("external-user-b");
    expect(leaseB.job?.jobId).not.toBe(leaseA.job!.jobId);

    db.close();
  });

  it("keeps project jobs behind the environment-profile barrier and inside one project", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const opened = captureProjectTurn(
      service,
      repos,
      "external-project-user",
      "external-project-session",
      "Run the project tests before committing; the service uses SQLite."
    );
    const projectId = opened.projectId;
    expect(projectId).toEqual(expect.any(String));

    const blocked = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-project-user", projectId),
      projectId
    });
    expect(blocked.job).toBeNull();

    for (const job of repos.runtime.listJobs("queued", 100)) {
      if (
        job.jobType === "project_environment_profile" &&
        job.userId === "external-project-user" &&
        job.payload.projectId === projectId
      ) {
        repos.runtime.completeJob(job.id);
      }
    }

    const wrongProject = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-project-user", "another-project"),
      projectId: "another-project"
    });
    expect(wrongProject.job).toBeNull();
    expect(() => service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-project-user", projectId),
      projectId: "another-project"
    })).toThrowError(expect.objectContaining({
      name: "MemoryServiceError",
      code: "forbidden"
    }));

    const first = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-project-user", projectId),
      projectId,
      leaseSeconds: 120
    });
    expect(first.job).not.toBeNull();
    expect(first.job).toEqual(expect.objectContaining({
      userId: "external-project-user",
      projectId,
      expectedFieldHash: expect.any(String),
      expectedProfileHash: expect.any(String)
    }));
    expect(["project_contract", "domain_knowledge"]).toContain(first.job!.targetField);

    const candidate = projectCandidate(first.job!.targetField, "create");
    const committed = service.submitExternalL3WorldModel(first.job!.jobId, {
      namespace: evolutionNamespace("external-project-user", projectId),
      projectId,
      expectedFieldHash: first.job!.expectedFieldHash,
      expectedProfileHash: first.job!.expectedProfileHash,
      candidate
    });
    expect(committed.projectId).toBe(projectId);
    expect(committed.targetField).toBe(first.job!.targetField);
    expect(repos.runtime.getJob(first.job!.jobId)?.status).toBe("succeeded");

    const fields = repos.l3WorldModels.fields("external-project-user", projectId);
    if (first.job!.targetField === "project_contract") {
      expect(fields.projectContract).toBe("- Run tests before commit.");
      expect(fields.domainKnowledge).toBeNull();
    } else {
      expect(fields.domainKnowledge).toBe("- The project uses SQLite.");
      expect(fields.projectContract).toBeNull();
    }
    expect(fields.generalRulesAndSafetyConstraints).toBeNull();

    db.close();
  });

  it("rejects stale bases, immediately requeues them, and makes successful submit retries idempotent", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    captureGlobalTurn(service, repos, "external-stale-user", "external-stale-session", "Keep a stable safety rule.");

    const first = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-stale-user"),
      projectId: null,
      leaseSeconds: 120
    });
    expect(first.job).not.toBeNull();

    repos.l3WorldModels.upsertField({
      userId: "external-stale-user",
      projectId: null,
      targetField: "general_rules_and_safety_constraints",
      value: "- Concurrently updated rule.",
      source: "test.concurrent"
    });

    expect(() => service.submitExternalL3WorldModel(first.job!.jobId, {
      namespace: evolutionNamespace("external-stale-user"),
      projectId: null,
      expectedFieldHash: first.job!.expectedFieldHash,
      candidate: {
        op: "create",
        general_rules_and_safety_constraints: "- Keep a stable safety rule."
      }
    })).toThrowError(expect.objectContaining({
      name: "MemoryServiceError",
      code: "conflict"
    }));
    expect(repos.runtime.getJob(first.job!.jobId)?.status).toBe("failed");

    const refreshed = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-stale-user"),
      projectId: null,
      leaseSeconds: 120
    });
    expect(refreshed.job?.jobId).toBe(first.job!.jobId);
    expect(refreshed.job?.expectedFieldHash).not.toBe(first.job!.expectedFieldHash);
    expect(refreshed.job?.currentField).toBe("- Concurrently updated rule.");

    const submission = {
      namespace: evolutionNamespace("external-stale-user"),
      projectId: null,
      expectedFieldHash: refreshed.job!.expectedFieldHash,
      candidate: {
        op: "update" as const,
        general_rules_and_safety_constraints: "- Concurrently updated rule.\n- Keep a stable safety rule."
      }
    };
    const committed = service.submitExternalL3WorldModel(refreshed.job!.jobId, submission);
    const retried = service.submitExternalL3WorldModel(refreshed.job!.jobId, submission);
    expect(retried).toEqual(expect.objectContaining({
      ok: true,
      jobId: committed.jobId,
      memoryId: committed.memoryId,
      noChange: committed.noChange
    }));
    expect(repos.runtime.getJob(refreshed.job!.jobId)?.status).toBe("succeeded");

    db.close();
  });

  it("keeps a bad candidate leased so the same Harness can repair and resubmit", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    captureGlobalTurn(service, repos, "external-repair-user", "external-repair-session", "Always verify destructive changes.");
    const leased = service.leaseExternalL3WorldModel({
      namespace: evolutionNamespace("external-repair-user"),
      projectId: null,
      leaseSeconds: 120
    });
    expect(leased.job).not.toBeNull();

    let error: unknown;
    try {
      service.submitExternalL3WorldModel(leased.job!.jobId, {
        namespace: evolutionNamespace("external-repair-user"),
        projectId: null,
        expectedFieldHash: leased.job!.expectedFieldHash,
        candidate: { op: "create", wrong_field: "bad" }
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MemoryServiceError);
    expect(error).toMatchObject({ code: "invalid_argument" });
    expect(repos.runtime.getJob(leased.job!.jobId)?.status).toBe("leased");

    const repaired = service.submitExternalL3WorldModel(leased.job!.jobId, {
      namespace: evolutionNamespace("external-repair-user"),
      projectId: null,
      expectedFieldHash: leased.job!.expectedFieldHash,
      candidate: {
        op: "create",
        general_rules_and_safety_constraints: "- Always verify destructive changes."
      }
    });
    expect(repaired.ok).toBe(true);
    expect(repos.runtime.getJob(leased.job!.jobId)?.status).toBe("succeeded");

    db.close();
  });
});

function evolutionNamespace(userId: string, projectId?: string) {
  return {
    source: "memhub-evolution",
    profileId: "default",
    userId,
    ...(projectId ? { projectId } : {})
  };
}

function captureGlobalTurn(
  service: MemoryService,
  repos: Repositories,
  userId: string,
  sessionKey: string,
  query: string
): ReturnType<MemoryService["openSession"]> {
  const namespace = {
    source: "codex",
    profileId: "default",
    sessionKey,
    userId
  };
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    namespace
  });
  const completed = service.completeTurn(`${sessionKey}-turn`, {
    sessionId: opened.sessionId,
    query,
    answer: "Recorded.",
    status: "succeeded",
    toolCalls: [{ name: "record_observation", input: { query }, success: true }],
    toolResults: [{ name: "record_observation", output: "recorded", exitCode: 0 }]
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
  return opened;
}

function captureProjectTurn(
  service: MemoryService,
  repos: Repositories,
  userId: string,
  sessionKey: string,
  query: string
): ReturnType<MemoryService["openSession"]> {
  const namespace = {
    source: "codex",
    profileId: "default",
    sessionKey,
    userId
  };
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    workspaceUri: `file:///tmp/${sessionKey}`,
    workspaceHostId: "c".repeat(64),
    namespace
  });
  const completed = service.completeTurn(`${sessionKey}-turn`, {
    sessionId: opened.sessionId,
    query,
    answer: "Recorded.",
    status: "succeeded",
    toolCalls: [{ name: "record_observation", input: { query }, success: true }],
    toolResults: [{ name: "record_observation", output: "recorded", exitCode: 0 }]
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
  return opened;
}

function projectCandidate(
  field: "project_contract" | "domain_knowledge" | "general_rules_and_safety_constraints",
  op: "create" | "update"
): Record<string, unknown> {
  if (field === "project_contract") {
    return {
      reason: "The user stated a durable project delivery rule.",
      op,
      project_contract: "- Run tests before commit."
    };
  }
  if (field === "domain_knowledge") {
    return {
      op,
      domain_knowledge: "- The project uses SQLite."
    };
  }
  throw new Error(`unexpected project field: ${field}`);
}
