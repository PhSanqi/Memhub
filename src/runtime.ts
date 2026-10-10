import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  FileProjectArchitectureSource,
  NullProjectArchitectureSource,
  type ProjectArchitectureSource
} from "./architecture-source.js";
import { JsonProjectBranchStore } from "./branch-store.js";
import { ContextRouter } from "./context-router.js";
import { LocalMemoryRestClient } from "./local-memory-client.js";
import { defaultMemoryUserId, MemoryRestContextSource } from "./memory-source.js";
import { JsonProjectRegistry } from "./project-registry.js";

export interface MemhubRuntimeOptions {
  accountId?: string;
  memoryEndpoint?: string;
  memoryToken?: string;
  controlRoot?: string;
  branchesPath?: string;
  architectureRoot?: string;
  disableArchitecture?: boolean;
  projectRegistryPath?: string;
  ownerAccountId?: string;
  ownerUserId?: string;
  source?: MemhubSourceContext;
}

export interface MemhubSourceContext {
  platform: string;
  transport: string;
  principalId?: string;
  connectionId?: string;
  authenticatedAccount?: string;
}

export interface MemhubRuntime {
  accountId: string;
  userId: string;
  memoryClient: LocalMemoryRestClient;
  router: ContextRouter;
  memory: MemoryRestContextSource;
  architecture: ProjectArchitectureSource;
  projects: JsonProjectRegistry;
  branches: JsonProjectBranchStore;
  source: MemhubSourceContext;
}

export function resolveLocalAccountId(options: Pick<MemhubRuntimeOptions, "accountId" | "ownerAccountId"> = {}): string {
  return requireNonEmpty(
    options.accountId?.trim() ||
    process.env.MEMHUB_ACCOUNT_ID?.trim() ||
    options.ownerAccountId?.trim() ||
    process.env.MEMHUB_OWNER_ACCOUNT_ID?.trim() ||
    "local",
    "accountId"
  );
}

export function createMemhubRuntime(options: MemhubRuntimeOptions = {}): MemhubRuntime {
  const accountId = resolveLocalAccountId(options);
  const memoryEndpoint = options.memoryEndpoint ?? process.env.MEMHUB_MEMORY_URL ?? "http://127.0.0.1:18960";
  const memoryToken = options.memoryToken ?? process.env.MEMHUB_MEMORY_TOKEN;
  const ownerAccountId = options.ownerAccountId ?? process.env.MEMHUB_OWNER_ACCOUNT_ID;
  const ownerUserId = options.ownerUserId ?? process.env.MEMHUB_OWNER_USER_ID ?? "local-user";
  const userId = defaultMemoryUserId(accountId, ownerAccountId, ownerUserId);
  const controlRoot = resolve(
    options.controlRoot ??
    process.env.MEMHUB_CONTROL_ROOT ??
    process.env.MEMHUB_STATE_ROOT ??
    join(homedir(), ".memmy", "memhub")
  );

  const memoryClient = new LocalMemoryRestClient({ endpoint: memoryEndpoint, token: memoryToken });
  const memory = new MemoryRestContextSource(memoryClient);
  const architectureDisabled = options.disableArchitecture ||
    process.env.MEMHUB_ARCHITECTURE === "0" ||
    process.env.MEMHUB_NORMIFY === "0";
  const architectureRoot = resolve(
    options.architectureRoot ??
    process.env.MEMHUB_ARCHITECTURE_ROOT ??
    process.env.MEMHUB_NORMIFY_ROOT ??
    process.cwd()
  );
  const architecture = architectureDisabled
    ? new NullProjectArchitectureSource()
    : new FileProjectArchitectureSource({
      rootDir: architectureRoot,
      managedRootDir: join(controlRoot, "project-architecture")
    });
  const branches = new JsonProjectBranchStore(resolve(
    options.branchesPath ??
    process.env.MEMHUB_BRANCHES ??
    join(controlRoot, "project-branches.json")
  ));
  const projects = new JsonProjectRegistry(resolve(
    options.projectRegistryPath ??
    process.env.MEMHUB_PROJECT_REGISTRY ??
    join(controlRoot, "project-registry.json")
  ));
  const router = new ContextRouter(memory, architecture, projects, branches);
  const source = options.source ?? { platform: "local", transport: "local" };
  return { accountId, userId, memoryClient, router, memory, architecture, projects, branches, source };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
