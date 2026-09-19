import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContextItem } from "./context-capsule.js";

export interface ProjectArchitectureSource {
  listProjects(accountId: string): Promise<string[]>;
  getProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    query: string;
  }): Promise<ContextItem[]>;
}

export class NullProjectArchitectureSource implements ProjectArchitectureSource {
  async listProjects(): Promise<string[]> { return []; }
  async getProjectArchitecture(): Promise<ContextItem[]> { return []; }
}

export interface EmbeddedArchitectureSourceOptions {
  rootDir: string;
  runtimeModule?: string;
  maxChars?: number;
}

/**
 * Memhub-owned architecture adapter. The small host-independent Normify engine
 * is vendored with Memhub so production does not require a separately
 * installed normify executable.
 */
export class EmbeddedArchitectureSource implements ProjectArchitectureSource {
  private readonly rootDir: string;
  private readonly runtimeModule: string;
  private readonly maxChars: number;

  constructor(options: EmbeddedArchitectureSourceOptions) {
    this.rootDir = resolve(options.rootDir);
    this.runtimeModule = resolve(
      options.runtimeModule ?? join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "vendor",
        "normify",
        "lib",
        "generic.js"
      )
    );
    this.maxChars = Math.max(1_000, options.maxChars ?? 16_000);
  }

  async listProjects(accountId: string): Promise<string[]> {
    const normalizedAccountId = requireNonEmpty(accountId, "accountId");
    const accountRoot = normalizedAccountId === "local"
      ? this.rootDir
      : join(this.rootDir, ".normify", "accounts", accountHash(normalizedAccountId));
    const projects = new Set<string>();
    try {
      const entries = await readdir(accountRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("normify-") &&
            await hasModules(join(accountRoot, entry.name))) {
          projects.add(entry.name.slice("normify-".length));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    for (const legacy of await discoverLegacyArchitectureDirs(this.rootDir)) {
      projects.add(legacy.slug);
    }
    return [...projects].filter(Boolean).sort();
  }

  async getProjectArchitecture(input: { accountId: string; projectId: string; query: string }): Promise<ContextItem[]> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const query = requireNonEmpty(input.query, "query");
    const primary = await this.callBrief({
      rootDir: this.rootDir,
      accountId: accountId === "local" ? undefined : accountId,
      projectId,
      query
    });
    if (!isNoModulesResult(primary)) {
      return architectureItems(primary, {
        projectId,
        maxChars: this.maxChars,
        rootDir: this.rootDir,
        source: "account-scoped"
      });
    }

    const legacy = (await discoverLegacyArchitectureDirs(this.rootDir))
      .find((candidate) => sameProject(candidate.slug, projectId));
    if (!legacy) return [];
    const fallback = await this.callBrief({
      rootDir: dirname(legacy.dir),
      projectId,
      query
    });
    if (isErrorResult(fallback)) return [];
    return architectureItems(fallback, {
      projectId,
      maxChars: this.maxChars,
      rootDir: dirname(legacy.dir),
      source: "legacy-repo-local"
    });
  }

  private async callBrief(input: {
    rootDir: string;
    accountId?: string;
    projectId: string;
    query: string;
  }): Promise<unknown> {
    const moduleUrl = pathToFileURL(this.runtimeModule).href;
    const imported = await import(moduleUrl) as {
      createNormifyRuntime(options: { rootDir: string; accountId?: string }): {
        callTool(name: string, args: Record<string, unknown>): Promise<unknown>
      }
    };
    const runtime = imported.createNormifyRuntime({
      rootDir: input.rootDir,
      ...(input.accountId ? { accountId: input.accountId } : {})
    });
    return runtime.callTool("normify_brief", {
      project: input.projectId,
      task: input.query,
      depth: 2
    });
  }
}

interface LegacyArchitectureDir {
  dir: string;
  slug: string;
}

async function discoverLegacyArchitectureDirs(rootDir: string): Promise<LegacyArchitectureDir[]> {
  const found = new Map<string, LegacyArchitectureDir>();
  await walk(resolve(rootDir), 2);
  return [...found.values()].sort((left, right) => left.dir.localeCompare(right.dir));

  async function walk(directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === ".normify" || entry.name === "node_modules") continue;
      const candidate = join(directory, entry.name);
      if (entry.name.startsWith("normify-")) {
        if (await hasModules(candidate)) {
          const slug = entry.name.slice("normify-".length);
          found.set(candidate, { dir: candidate, slug });
        }
        continue;
      }
      if (depth > 0) await walk(candidate, depth - 1);
    }
  }
}

async function hasModules(projectDir: string): Promise<boolean> {
  try {
    return (await stat(join(projectDir, "modules"))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function architectureItems(result: unknown, input: {
  projectId: string;
  maxChars: number;
  rootDir: string;
  source: "account-scoped" | "legacy-repo-local";
}): ContextItem[] {
  if (isErrorResult(result)) return [];
  const raw = JSON.stringify(result);
  const content = raw.length <= input.maxChars ? raw : `${raw.slice(0, input.maxChars)}\n…[truncated]`;
  return [{
    id: `memhub-architecture:${input.projectId}:brief`,
    content,
    authority: "authoritative",
    scope: "project",
    source: "memhub-architecture",
    projectId: input.projectId,
    provenance: {
      adapter: "memhub-embedded-architecture-core",
      tool: "normify_brief",
      rootDir: input.rootDir,
      architectureSource: input.source
    }
  }];
}

function isNoModulesResult(value: unknown): boolean {
  if (!isErrorResult(value)) return false;
  const error = (value as { error?: { code?: unknown } }).error;
  return error?.code === "project/no-modules";
}

function isErrorResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as { ok?: unknown }).ok === false);
}

function sameProject(left: string, right: string): boolean {
  return normalizeProjectKey(left) === normalizeProjectKey(right);
}

function normalizeProjectKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}
