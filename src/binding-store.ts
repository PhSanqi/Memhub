import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConversationProjectBinding {
  accountId: string;
  conversationId: string;
  projectId: string;
  updatedAt: string;
}

export interface ConversationProjectBindingStore {
  get(accountId: string, conversationId: string): Promise<ConversationProjectBinding | null>;
  bind(accountId: string, conversationId: string, projectId: string): Promise<ConversationProjectBinding>;
  unbind(accountId: string, conversationId: string): Promise<boolean>;
}

interface BindingFile {
  version: 1;
  bindings: ConversationProjectBinding[];
}

export class JsonConversationProjectBindingStore implements ConversationProjectBindingStore {
  private mutation = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(accountId: string, conversationId: string): Promise<ConversationProjectBinding | null> {
    const key = normalizeKey(accountId, conversationId);
    const file = await this.read();
    return file.bindings.find((binding) => bindingKey(binding.accountId, binding.conversationId) === key) ?? null;
  }

  bind(accountId: string, conversationId: string, projectId: string): Promise<ConversationProjectBinding> {
    return this.serialize(async () => {
      const normalizedAccountId = requireNonEmpty(accountId, "accountId");
      const normalizedConversationId = requireNonEmpty(conversationId, "conversationId");
      const normalizedProjectId = requireNonEmpty(projectId, "projectId");
      const binding: ConversationProjectBinding = {
        accountId: normalizedAccountId,
        conversationId: normalizedConversationId,
        projectId: normalizedProjectId,
        updatedAt: new Date().toISOString()
      };
      const file = await this.read();
      const key = bindingKey(normalizedAccountId, normalizedConversationId);
      file.bindings = [
        ...file.bindings.filter((item) => bindingKey(item.accountId, item.conversationId) !== key),
        binding
      ].sort((left, right) => bindingKey(left.accountId, left.conversationId).localeCompare(bindingKey(right.accountId, right.conversationId)));
      await this.write(file);
      return binding;
    });
  }

  unbind(accountId: string, conversationId: string): Promise<boolean> {
    return this.serialize(async () => {
      const file = await this.read();
      const key = normalizeKey(accountId, conversationId);
      const before = file.bindings.length;
      file.bindings = file.bindings.filter((item) => bindingKey(item.accountId, item.conversationId) !== key);
      if (file.bindings.length === before) return false;
      await this.write(file);
      return true;
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<BindingFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isBindingFile(parsed)) throw new Error(`invalid context binding store: ${this.path}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, bindings: [] };
      throw error;
    }
  }

  private async write(file: BindingFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function isBindingFile(value: unknown): value is BindingFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.bindings)) return false;
  return record.bindings.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const binding = item as Record<string, unknown>;
    return typeof binding.accountId === "string" &&
      typeof binding.conversationId === "string" &&
      typeof binding.projectId === "string" &&
      typeof binding.updatedAt === "string";
  });
}

function normalizeKey(accountId: string, conversationId: string): string {
  return bindingKey(requireNonEmpty(accountId, "accountId"), requireNonEmpty(conversationId, "conversationId"));
}

function bindingKey(accountId: string, conversationId: string): string {
  return `${accountId}\u0000${conversationId}`;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
