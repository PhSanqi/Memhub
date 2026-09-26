import type { ServerResponse } from "node:http";
import type { listAccounts } from "./auth.js";
import {
  readMemoryControlData,
  type MemoryControlKind
} from "./memory-control-plane.js";
import type { MemhubRuntime } from "./runtime.js";

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
}): Promise<void> {
  const { response, url, stateRoot, runtime, accounts, selectedAccount, adminView } = input;
  const kindRaw = url.searchParams.get("kind") ?? "overview";
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
    "overview", "projects", "l1", "l2", "l3", "l4", "skills", "processing"
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
    ...(projectId ? { projectId } : {})
  });
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify({
      ...objectRecord(payload),
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
