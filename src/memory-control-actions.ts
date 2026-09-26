import type { IncomingMessage, ServerResponse } from "node:http";
import { setAccountRole, type listAccounts } from "./auth.js";
import { setDistillationConfig, retryDistillationJob, type DistillationJob } from "./distillation-jobs.js";
import { queueLegacyLayerRebuild } from "./legacy-rebuild.js";
import { readJsonBody } from "./http-json.js";
import type { MemhubRuntime } from "./runtime.js";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];

/** Authenticated console mutations. Gateway has already verified the caller and selected account. */
export async function handleMemoryControlAction(input: {
  request: IncomingMessage; response: ServerResponse; stateRoot: string;
  runtime: MemhubRuntime; accounts: Account[]; selectedAccount: Account; adminView: boolean;
  unfinishedDistillationJobsForProject: (stateRoot: string, runtime: MemhubRuntime, projectId: string) => Promise<DistillationJob[]>;
  assertManagedMemory: (runtime: MemhubRuntime, memoryId: string) => Promise<void>;
}): Promise<void> {
  const { request, response, stateRoot, runtime, accounts, selectedAccount, adminView, unfinishedDistillationJobsForProject, assertManagedMemory } = input;
          if (!isJsonRequest(request)) {
            response.writeHead(415, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ error: "application_json_required" }));
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          const action = optionalString(body.action);
          const id = optionalString(body.id);
          if (!action) { response.writeHead(400).end(); return; }
          if (action === "set-distillation-config") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const config = await setDistillationConfig(stateRoot, {
              ...(typeof body.auto_enabled === "boolean" ? { auto_enabled: body.auto_enabled } : {}),
              ...(typeof body.turn_threshold === "number" ? { turn_threshold: body.turn_threshold } : {}),
              ...(typeof body.idle_minutes === "number" ? { idle_minutes: body.idle_minutes } : {})
            });
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, config }));
            return;
          }
          if (action === "queue-legacy-rebuild") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const projectRef = optionalString(body.project);
            let projectId: string | undefined;
            if (projectRef) {
              await runtime.projects.list(runtime.accountId);
              projectId = await runtime.projects.resolve(runtime.accountId, projectRef) ?? undefined;
              if (!projectId) {
                response.writeHead(404, { "content-type": "application/json" })
                  .end(JSON.stringify({ error: "project_not_found" }));
                return;
              }
            }
            const rebuild = await queueLegacyLayerRebuild({
              stateRoot: stateRoot,
              runtime,
              ...(projectId ? { projectId } : {})
            });
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ ok: true, rebuild }));
            return;
          }
          if (action === "set-account-role") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const accountRef = optionalString(body.id);
            const role = optionalString(body.role);
            if (!accountRef || (role !== "admin" && role !== "user")) { response.writeHead(400).end(); return; }
            const target = accounts.find((item) => item.account_id === accountRef || item.username === accountRef || item.cloudflare_email === accountRef.toLowerCase());
            if (!target) { response.writeHead(404).end(); return; }
            if (target.role === "admin" && role === "user" && accounts.filter((item) => item.role === "admin").length <= 1) {
              response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "cannot_demote_last_admin" }));
              return;
            }
            await setAccountRole(stateRoot, accountRef, role);
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, account_id: target.account_id, role }));
            return;
          }
          if (["create-project", "update-project", "delete-project", "merge-project"].includes(action)) {
            if (!adminView) { response.writeHead(403).end(); return; }
            const projectRef = optionalString(body.project);
            if (!projectRef) { response.writeHead(400).end(); return; }
            let result: unknown;
            if (action === "create-project") {
              result = await runtime.projects.create(runtime.accountId, {
                projectId: projectRef,
                name: optionalString(body.name),
                description: requiredString(body.description, "description"),
                aliases: stringArrayAllowEmpty(body.aliases)
              });
            } else if (action === "update-project") {
              result = await runtime.projects.update(runtime.accountId, projectRef, {
                ...(typeof body.name === "string" ? { name: String(body.name) } : {}),
                ...(typeof body.description === "string" ? { description: String(body.description) } : {}),
                ...(Array.isArray(body.aliases) ? { aliases: stringArrayAllowEmpty(body.aliases) } : {})
              });
            } else if (action === "delete-project") {
              const canonical = await runtime.projects.resolve(runtime.accountId, projectRef);
              if (!canonical) {
                response.writeHead(404, { "content-type": "application/json" })
                  .end(JSON.stringify({ error: "project_not_found" }));
                return;
              }
              const blockers = await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical);
              if (blockers.length > 0) {
                response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" })
                  .end(JSON.stringify({
                    error: "unfinished_distillation_jobs",
                    project: canonical,
                    jobs: blockers.map((job) => ({ job_id: job.job_id, status: job.status, target: job.target }))
                  }));
                return;
              }
              result = await runtime.projects.delete(runtime.accountId, projectRef);
            } else {
              result = await runtime.projects.merge(runtime.accountId, projectRef, requiredString(body.target, "target"));
            }
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ ok: true, action, result }));
            return;
          }
          if (action === "add-project-todo" || action === "set-project-todo-status") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const projectRef = optionalString(body.project);
            if (!projectRef) { response.writeHead(400).end(); return; }
            const result = action === "add-project-todo"
              ? await runtime.projects.addTodo(runtime.accountId, projectRef, requiredString(body.text, "text"))
              : await runtime.projects.setTodoStatus(
                  runtime.accountId,
                  projectRef,
                  requiredString(body.todo_id, "todo_id"),
                  requiredString(body.status, "status") as "pending" | "done"
                );
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ ok: true, action, result }));
            return;
          }
          if (!id) { response.writeHead(400).end(); return; }
          if (action === "retry-distillation") {
            if (!adminView) { response.writeHead(403).end(); return; }
            let retried;
            try {
              retried = await retryDistillationJob(stateRoot, selectedAccount.account_id, id);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              if (detail.includes("ambiguous Core commit requires manual reconciliation")) {
                response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" })
                  .end(JSON.stringify({ error: "manual_reconciliation_required", detail }));
                return;
              }
              throw error;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, job: retried }));
            return;
          }
          if (action === "delete-memory" || action === "archive-memory" || action === "archive-skill") {
            await assertManagedMemory(runtime, id);
            if (action === "delete-memory") {
              await runtime.memoryClient.viewerDelete(`/api/v1/memory/${encodeURIComponent(id)}`);
            } else if (action === "archive-skill") {
              await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId: id });
            } else {
              await runtime.memoryClient.viewerPost(`/api/v1/memory/${encodeURIComponent(id)}/archive`);
            }
            response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
            return;
          }
          response.writeHead(400).end();
          return;
}

function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = singleHeader(request.headers["content-type"]);
  return Boolean(contentType && /^application\/json(?:\s*;|$)/i.test(contentType));
}
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function stringArrayAllowEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("value must be an array");
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}
