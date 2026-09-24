import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";

export type ProjectBranchStatus = "active" | "closed";

export interface ProjectBranch {
  accountId: string;
  projectId: string;
  branchId: string;
  name: string;
  goal: string;
  status: ProjectBranchStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface ConversationBranchBinding {
  accountId: string;
  conversationId: string;
  projectId: string;
  branchId: string;
  updatedAt: string;
}

interface BranchFile {
  version: 1;
  branches: ProjectBranch[];
  bindings: ConversationBranchBinding[];
}

export class JsonProjectBranchStore {
  constructor(private readonly path: string) {}

  async list(accountId: string, projectId: string, options: { includeClosed?: boolean } = {}): Promise<ProjectBranch[]> {
    const account = requireNonEmpty(accountId, "accountId");
    const project = requireNonEmpty(projectId, "projectId");
    const file = await this.read();
    return file.branches
      .filter((branch) => branch.accountId === account && branch.projectId === project)
      .filter((branch) => options.includeClosed || branch.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(accountId: string, projectId: string, input: { name: string; goal: string }): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const account = requireNonEmpty(accountId, "accountId");
      const project = requireNonEmpty(projectId, "projectId");
      const name = requireNonEmpty(input.name, "name");
      const goal = requireNonEmpty(input.goal, "goal");
      const file = await this.read();
      const same = file.branches.find((branch) =>
        branch.accountId === account &&
        branch.projectId === project &&
        branch.status === "active" &&
        normalizeRef(branch.name) === normalizeRef(name)
      );
      if (same) {
        if (same.goal !== goal) {
          same.goal = goal;
          same.updatedAt = new Date().toISOString();
          await this.write(file);
        }
        return { ...same };
      }
      const now = new Date().toISOString();
      const branch: ProjectBranch = {
        accountId: account,
        projectId: project,
        branchId: uniqueBranchId(file.branches, account, project, name),
        name,
        goal,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      file.branches.push(branch);
      await this.write(file);
      return { ...branch };
    });
  }

  async resolve(accountId: string, projectId: string, reference: string, options: { includeClosed?: boolean } = {}): Promise<ProjectBranch | null> {
    const account = requireNonEmpty(accountId, "accountId");
    const project = requireNonEmpty(projectId, "projectId");
    const ref = normalizeRef(requireNonEmpty(reference, "branch"));
    const candidates = (await this.read()).branches.filter((branch) =>
      branch.accountId === account &&
      branch.projectId === project &&
      (options.includeClosed || branch.status === "active")
    );
    return candidates.find((branch) => normalizeRef(branch.branchId) === ref) ??
      candidates.find((branch) => normalizeRef(branch.name) === ref) ?? null;
  }

  async close(accountId: string, projectId: string, reference: string): Promise<ProjectBranch> {
    return this.setStatus(accountId, projectId, reference, "closed");
  }

  async reopen(accountId: string, projectId: string, reference: string): Promise<ProjectBranch> {
    return this.setStatus(accountId, projectId, reference, "active");
  }

  async current(accountId: string, conversationId: string, projectId?: string): Promise<ProjectBranch | null> {
    const account = requireNonEmpty(accountId, "accountId");
    const conversation = requireNonEmpty(conversationId, "conversationId");
    const file = await this.read();
    const binding = file.bindings.find((item) =>
      item.accountId === account &&
      item.conversationId === conversation &&
      (!projectId || item.projectId === projectId)
    );
    if (!binding) return null;
    return file.branches.find((branch) =>
      branch.accountId === account &&
      branch.projectId === binding.projectId &&
      branch.branchId === binding.branchId &&
      branch.status === "active"
    ) ?? null;
  }

  async bind(accountId: string, conversationId: string, projectId: string, branchRef: string): Promise<ConversationBranchBinding> {
    return this.serialize(async () => {
      const account = requireNonEmpty(accountId, "accountId");
      const conversation = requireNonEmpty(conversationId, "conversationId");
      const project = requireNonEmpty(projectId, "projectId");
      const file = await this.read();
      const ref = normalizeRef(requireNonEmpty(branchRef, "branch"));
      const branch = file.branches.find((item) =>
        item.accountId === account &&
        item.projectId === project &&
        item.status === "active" &&
        (normalizeRef(item.branchId) === ref || normalizeRef(item.name) === ref)
      );
      if (!branch) throw new Error(`unknown active branch for project ${project}: ${branchRef}`);
      const binding: ConversationBranchBinding = {
        accountId: account,
        conversationId: conversation,
        projectId: project,
        branchId: branch.branchId,
        updatedAt: new Date().toISOString()
      };
      const key = bindingKey(account, conversation);
      file.bindings = [
        ...file.bindings.filter((item) => bindingKey(item.accountId, item.conversationId) !== key),
        binding
      ].sort((left, right) => bindingKey(left.accountId, left.conversationId).localeCompare(bindingKey(right.accountId, right.conversationId)));
      await this.write(file);
      return binding;
    });
  }

  async unbind(accountId: string, conversationId: string): Promise<boolean> {
    return this.serialize(async () => {
      const account = requireNonEmpty(accountId, "accountId");
      const conversation = requireNonEmpty(conversationId, "conversationId");
      const file = await this.read();
      const key = bindingKey(account, conversation);
      const before = file.bindings.length;
      file.bindings = file.bindings.filter((item) => bindingKey(item.accountId, item.conversationId) !== key);
      if (file.bindings.length === before) return false;
      await this.write(file);
      return true;
    });
  }

  private async setStatus(accountId: string, projectId: string, reference: string, status: ProjectBranchStatus): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const account = requireNonEmpty(accountId, "accountId");
      const project = requireNonEmpty(projectId, "projectId");
      const ref = normalizeRef(requireNonEmpty(reference, "branch"));
      const file = await this.read();
      const branch = file.branches.find((item) =>
        item.accountId === account &&
        item.projectId === project &&
        (normalizeRef(item.branchId) === ref || normalizeRef(item.name) === ref)
      );
      if (!branch) throw new Error(`unknown branch for project ${project}: ${reference}`);
      const now = new Date().toISOString();
      branch.status = status;
      branch.updatedAt = now;
      if (status === "closed") branch.closedAt = now;
      else delete branch.closedAt;
      if (status === "closed") {
        file.bindings = file.bindings.filter((item) => !(item.accountId === account && item.projectId === project && item.branchId === branch.branchId));
      }
      await this.write(file);
      return { ...branch };
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    return withFileMutationLock(this.path, operation);
  }

  private async read(): Promise<BranchFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isBranchFile(parsed)) throw new Error(`invalid branch store: ${this.path}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, branches: [], bindings: [] };
      throw error;
    }
  }

  private async write(file: BranchFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function uniqueBranchId(branches: readonly ProjectBranch[], accountId: string, projectId: string, name: string): string {
  const base = slug(name) || "branch";
  const occupied = new Set(branches
    .filter((branch) => branch.accountId === accountId && branch.projectId === projectId)
    .map((branch) => branch.branchId));
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `branch-${randomUUID().slice(0, 8)}`;
}

function slug(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeRef(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function bindingKey(accountId: string, conversationId: string): string {
  return `${accountId}\u0000${conversationId}`;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function isBranchFile(value: unknown): value is BranchFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.branches) || !Array.isArray(record.bindings)) return false;
  return record.branches.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const branch = item as Record<string, unknown>;
    return typeof branch.accountId === "string" &&
      typeof branch.projectId === "string" &&
      typeof branch.branchId === "string" &&
      typeof branch.name === "string" &&
      typeof branch.goal === "string" &&
      (branch.status === "active" || branch.status === "closed") &&
      typeof branch.createdAt === "string" &&
      typeof branch.updatedAt === "string";
  }) && record.bindings.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const binding = item as Record<string, unknown>;
    return typeof binding.accountId === "string" &&
      typeof binding.conversationId === "string" &&
      typeof binding.projectId === "string" &&
      typeof binding.branchId === "string" &&
      typeof binding.updatedAt === "string";
  });
}
