import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
    try {
      const entries = await readdir(accountRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("normify-"))
        .map((entry) => entry.name.slice("normify-".length)).filter(Boolean).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
  }

  async getProjectArchitecture(input: { accountId: string; projectId: string; query: string }): Promise<ContextItem[]> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const query = requireNonEmpty(input.query, "query");
    const moduleUrl = pathToFileURL(this.runtimeModule).href;
    const imported = await import(moduleUrl) as {
      createNormifyRuntime(options: { rootDir: string; accountId?: string }): {
        callTool(name: string, args: Record<string, unknown>): Promise<unknown>
      }
    };
    const runtime = imported.createNormifyRuntime({
      rootDir: this.rootDir,
      ...(accountId === "local" ? {} : { accountId })
    });
    const result = await runtime.callTool("normify_brief", { project: projectId, task: query, depth: 2 });
    const raw = JSON.stringify(result);
    const content = raw.length <= this.maxChars ? raw : `${raw.slice(0, this.maxChars)}\n…[truncated]`;
    return [{
      id: `memhub-architecture:${projectId}:brief`,
      content,
      authority: "authoritative",
      scope: "project",
      source: "memhub-architecture",
      projectId,
      provenance: { adapter: "memhub-embedded-architecture-core", tool: "normify_brief", rootDir: this.rootDir }
    }];
  }
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}
