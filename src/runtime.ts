import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  FileProjectArchitectureSource,
  NullProjectArchitectureSource,
  type ProjectArchitectureSource
} from "./architecture-source.js";
import { JsonConversationProjectBindingStore } from "./binding-store.js";
import { ContextRouter } from "./context-router.js";
import { LocalMemoryRestClient } from "./local-memory-client.js";
import { defaultMemoryUserId, MemoryRestContextSource } from "./memory-source.js";
import { JsonProjectRegistry } from "./project-registry.js";

export interface MemhubRuntimeOptions {
  accountId?: string;
  memoryEndpoint?: string;
  memoryToken?: string;
  bindingsPath?: string;
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
  source: MemhubSourceContext;
}

export function createMemhubRuntime(options: MemhubRuntimeOptions = {}): MemhubRuntime {
  const accountId = requireNonEmpty(options.accountId ?? process.env.MEMHUB_ACCOUNT_ID ?? "local", "accountId");
  const memoryEndpoint = options.memoryEndpoint ?? process.env.MEMHUB_MEMORY_URL ?? "http://127.0.0.1:18960";
  const memoryToken = options.memoryToken ?? process.env.MEMHUB_MEMORY_TOKEN;
  const ownerAccountId = options.ownerAccountId ?? process.env.MEMHUB_OWNER_ACCOUNT_ID;
  const ownerUserId = options.ownerUserId ?? process.env.MEMHUB_OWNER_USER_ID ?? "local-user";
  const userId = defaultMemoryUserId(accountId, ownerAccountId, ownerUserId);
  const bindingsPath = resolve(
    options.bindingsPath ??
    process.env.MEMHUB_BINDINGS ??
    join(homedir(), ".memmy", "memhub", "conversation-project-bindings.json")
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
      rootDir: architectureRoot
    });
  const bindings = new JsonConversationProjectBindingStore(bindingsPath);
  const projects = new JsonProjectRegistry(resolve(
    options.projectRegistryPath ??
    process.env.MEMHUB_PROJECT_REGISTRY ??
    join(dirname(bindingsPath), "project-registry.json")
  ));
  const router = new ContextRouter(memory, architecture, bindings, projects);
  const source = options.source ?? { platform: "local", transport: "local" };
  return { accountId, userId, memoryClient, router, memory, architecture, projects, source };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
