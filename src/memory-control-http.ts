import type { ServerResponse } from "node:http";
import type { listAccounts } from "./auth.js";
import {
  readMemoryControlData,
  type MemoryControlKind
} from "./memory-control-plane.js";
import type { MemhubRuntime } from "./runtime.js";
import { countUnassignedCaptures, listUnassignedCaptures } from "./capture-project-assignments.js";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];

/** Authenticated, account-scoped read-only console API. Authentication and
 * account selection are performed by the Gateway before entering here. */
export async function handleMemoryControlRead(input: {
  response: ServerResponse;
  url: URL;
  stateRoot: string;
  runtime: MemhubRuntime;
  accounts: Account[];
  selectedAccount: Account;
  adminView: boolean;
  callerAccountId?: string;
}): Promise<void> {
  input.response.setHeader("x-content-type-options", "nosniff");
  input.response.setHeader("cache-control", "no-store");
  const { response, url, stateRoot, runtime, accounts, selectedAccount, adminView } = input;
  const kindRaw = url.searchParams.get("kind") ?? "overview";
  if (kindRaw === "unassigned") {
    if (!adminView || !input.callerAccountId || input.callerAccountId !== runtime.accountId || selectedAccount.account_id !== runtime.accountId) {
      response.writeHead(403).end(); return;
    }
    const payload = await listUnassignedCaptures({ stateRoot, accountId: runtime.accountId, projects: runtime.projects,
      offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 20) });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...payload,
      projects: await runtime.projects.list(runtime.accountId) }));
    return;
  }
  if (kindRaw === "accounts") {
    if (!adminView) { response.writeHead(403).end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({
        items: accounts.map((account) => ({
          account_id: account.account_id,
          username: account.username,
          cloudflare_email: account.cloudflare_email,
          role: account.role,
          selected: account.account_id === selectedAccount.account_id
        })),
        total: accounts.length
      }));
    return;
  }
  const allowedKinds = new Set<MemoryControlKind>([
    "overview", "projects", "l1", "l2", "l3", "l4", "skills", "visualization", "processing"
  ]);
  if (!allowedKinds.has(kindRaw as MemoryControlKind)) {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ error: "unsupported_memory_view" }));
    return;
  }
  const projects = await runtime.projects.list(runtime.accountId);
  const projectRef = optionalString(url.searchParams.get("project"));
  const projectId = projectRef
    ? await runtime.projects.resolve(runtime.accountId, projectRef)
    : undefined;
  if (projectRef && !projectId) {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ error: "project_not_found" }));
    return;
  }
  const payload = await readMemoryControlData({
    stateRoot,
    runtime,
    kind: kindRaw as MemoryControlKind,
    projects,
    includeOverviewItems: !adminView,
    includeIncomplete: url.searchParams.get("include_incomplete") === "1",
    ...(projectId ? { projectId } : {})
  });
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify({
      ...objectRecord(payload),
      ...(kindRaw === "overview" && adminView && input.callerAccountId === runtime.accountId
        ? { unresolved_count: await countUnassignedCaptures(stateRoot, runtime.accountId) } : {}),
      ...(kindRaw === "overview" && adminView ? { account_count: accounts.length } : {}),
      account: {
        account_id: selectedAccount.account_id,
        username: selectedAccount.username,
        role: selectedAccount.role
      }
    }));
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
