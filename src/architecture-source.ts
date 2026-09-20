import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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

export interface FileProjectArchitectureSourceOptions {
  rootDir: string;
  maxChars?: number;
}

/**
 * Small compatibility reader for the architecture files that older Memhub
 * releases stored under `normify-<project>`. It deliberately does not execute
 * or depend on the legacy Normify engine; the files themselves remain the
 * authoritative project architecture source until they are explicitly
 * migrated by the user.
 */
export class FileProjectArchitectureSource implements ProjectArchitectureSource {
  private readonly rootDir: string;
  private readonly maxChars: number;

  constructor(options: FileProjectArchitectureSourceOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxChars = Math.max(1_000, options.maxChars ?? 16_000);
  }

  async listProjects(accountId: string): Promise<string[]> {
    const dirs = await this.architectureDirs(requireNonEmpty(accountId, "accountId"));
    return [...new Set(dirs.map((item) => item.projectId))].sort();
  }

  async getProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    query: string;
  }): Promise<ContextItem[]> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const query = requireNonEmpty(input.query, "query");
    const candidate = (await this.architectureDirs(accountId))
      .find((item) => sameProject(item.projectId, projectId));
    if (!candidate) return [];

    const files = await architectureMarkdownFiles(candidate.dir, projectId);
    const queryTokens = tokens(query);
    const rows = [] as Array<{ path: string; content: string; score: number }>;
    for (const path of files) {
      const content = (await readFile(path, "utf8")).trim();
      if (!content) continue;
      const haystack = `${basename(path)}\n${content}`.toLocaleLowerCase();
      const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0) +
        (basename(path) === "outline.md" ? 0.5 : 0);
      rows.push({ path, content, score });
    }
    rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    let remaining = this.maxChars;
    const items: ContextItem[] = [];
    for (const row of rows) {
      if (remaining <= 0) break;
      const clipped = row.content.slice(0, remaining);
      if (!clipped.trim()) continue;
      const relativePath = relative(candidate.dir, row.path).replaceAll("\\", "/");
      items.push({
        id: `architecture:${projectId}:${createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`,
        content: `# ${relativePath}\n\n${clipped}`,
        authority: "authoritative",
        scope: "project",
        source: "project-architecture",
        projectId,
        provenance: {
          storage: candidate.scope,
          path: relativePath,
          legacyFormat: "normify-files"
        }
      });
      remaining -= clipped.length;
    }
    return items;
  }

  private async architectureDirs(accountId: string): Promise<Array<{
    projectId: string;
    dir: string;
    scope: "account-scoped" | "legacy-repo-local";
  }>> {
    const results: Array<{
      projectId: string;
      dir: string;
      scope: "account-scoped" | "legacy-repo-local";
    }> = [];
    const accountRoot = join(this.rootDir, ".normify", "accounts", accountHash(accountId));
    for (const dir of await childArchitectureDirs(accountRoot)) {
      results.push({ projectId: projectIdFromDir(dir), dir, scope: "account-scoped" });
    }
    for (const dir of await childArchitectureDirs(this.rootDir)) {
      results.push({ projectId: projectIdFromDir(dir), dir, scope: "legacy-repo-local" });
    }
    for (const child of await childDirs(this.rootDir)) {
      if (basename(child) === ".normify") continue;
      for (const dir of await childArchitectureDirs(child)) {
        results.push({ projectId: projectIdFromDir(dir), dir, scope: "legacy-repo-local" });
      }
    }
    const unique = new Map<string, typeof results[number]>();
    for (const item of results) {
      const key = `${item.scope}\0${item.projectId}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    return [...unique.values()].sort((a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "account-scoped" ? -1 : 1) ||
      a.projectId.localeCompare(b.projectId)
    );
  }
}

async function architectureMarkdownFiles(root: string, projectId: string): Promise<string[]> {
  const files: string[] = [];
  const outline = join(root, "outline.md");
  if (await fileExists(outline)) files.push(outline);
  const moduleRoots = [join(root, "modules", projectId), join(root, "modules")];
  for (const moduleRoot of moduleRoots) {
    for (const file of await markdownFiles(moduleRoot, 3)) {
      if (!files.includes(file)) files.push(file);
    }
    if (files.length > (await fileExists(outline) ? 1 : 0)) break;
  }
  return files;
}

async function markdownFiles(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else if (entry.isDirectory() && depth > 0) files.push(...await markdownFiles(path, depth - 1));
  }
  return files;
}

async function childArchitectureDirs(root: string): Promise<string[]> {
  return (await childDirs(root)).filter((dir) => basename(dir).startsWith("normify-"));
}

async function childDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function projectIdFromDir(dir: string): string {
  return basename(dir).slice("normify-".length);
}

function sameProject(left: string, right: string): boolean {
  return left.normalize("NFKC").toLocaleLowerCase() === right.normalize("NFKC").toLocaleLowerCase();
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2))];
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
