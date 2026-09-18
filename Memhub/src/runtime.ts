import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  NormifyCliArchitectureSource,
  NullProjectArchitectureSource,
  type ProjectArchitectureSource
} from "./architecture-source.js";
import { JsonConversationProjectBindingStore } from "./binding-store.js";
import { ContextRouter } from "./context-router.js";
import { LocalMemoryRestClient } from "./local-memory-client.js";
import { defaultMemoryUserId, MemoryRestContextSource } from "./memory-source.js";

export interface MemhubRuntimeOptions {
  accountId?: string;
  memoryEndpoint?: string;
  memoryToken?: string;
  bindingsPath?: string;
  normifyRoot?: string;
  normifyCommand?: string;
  disableNormify?: boolean;
  ownerAccountId?: string;
  ownerUserId?: string;
}

export interface MemhubRuntime {
  accountId: string;
  userId: string;
  memoryClient: LocalMemoryRestClient;
  router: ContextRouter;
  memory: MemoryRestContextSource;
  architecture: ProjectArchitectureSource;
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
  const architecture = options.disableNormify || process.env.MEMHUB_NORMIFY === "0"
    ? new NullProjectArchitectureSource()
    : new NormifyCliArchitectureSource({
        rootDir: resolve(options.normifyRoot ?? process.env.MEMHUB_NORMIFY_ROOT ?? process.cwd()),
        command: options.normifyCommand ?? process.env.MEMHUB_NORMIFY_COMMAND ?? "normify"
      });
  const bindings = new JsonConversationProjectBindingStore(bindingsPath);
  const router = new ContextRouter(memory, architecture, bindings);
  return { accountId, userId, memoryClient, router, memory, architecture };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
