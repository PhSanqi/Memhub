import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ContextItem } from "./context-capsule.js";
import { withFileMutationLock } from "./file-mutation-lock.js";

export interface ProjectArchitectureDocument {
  projectId: string;
  workspaceDir: string;
  path: string;
  relativePath: string;
  exists: boolean;
  content: string;
  fingerprint: string;
}

export interface ProjectArchitectureSource {
  listProjects(accountId: string): Promise<string[]>;
  getProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    query: string;
  }): Promise<ContextItem[]>;
  inspectProjectArchitecture(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectArchitectureDocument | null>;
  writeProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    expectedPath: string;
    expectedFingerprint: string;
    content: string;
  }): Promise<{ before: ProjectArchitectureDocument; after: ProjectArchitectureDocument }>;
}

export class NullProjectArchitectureSource implements ProjectArchitectureSource {
  async listProjects(): Promise<string[]> { return []; }
  async getProjectArchitecture(): Promise<ContextItem[]> { return []; }
  async inspectProjectArchitecture(): Promise<null> { return null; }
  async writeProjectArchitecture(): Promise<never> { throw new Error("Project Architecture is disabled"); }
}

export interface FileProjectArchitectureSourceOptions {
  rootDir: string;
  managedRootDir?: string;
  maxChars?: number;
}

/**
 * Project Architecture reader/writer. Memhub-managed canonical documents live
 * under its private writable state root. Repository Markdown and legacy
 * `normify-<project>` trees remain read-only discovery/migration inputs.
 */
export class FileProjectArchitectureSource implements ProjectArchitectureSource {
  private readonly rootDir: string;
  private readonly managedRootDir: string;
  private readonly maxChars: number;

  constructor(options: FileProjectArchitectureSourceOptions) {
    this.rootDir = resolve(options.rootDir);
    this.managedRootDir = resolve(options.managedRootDir ?? join(this.rootDir, ".memhub-project-architecture"));
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
    let candidates = (await this.architectureDirs(accountId))
      .filter((item) => sameProject(item.projectId, projectId));
    const managedCandidates = candidates.filter((item) => item.scope === "memhub-managed");
    if (managedCandidates.length > 0) candidates = managedCandidates;
    if (candidates.length === 0) return [];

    const queryTokens = tokens(query);
    const rows = [] as Array<{
      path: string;
      root: string;
      content: string;
      score: number;
      scope: ArchitectureDir["scope"];
      format: ArchitectureDir["format"];
    }>;
    for (const candidate of candidates) {
      const files = await architectureMarkdownFiles(candidate, projectId);
      for (const path of files) {
        const content = (await readFile(path, "utf8")).trim();
        if (!content) continue;
        const haystack = `${basename(path)}\n${content}`.toLocaleLowerCase();
        const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0) +
          (basename(path).toLocaleLowerCase() === "architecture.md" ? 0.75 : 0) +
          (basename(path) === "outline.md" ? 0.5 : 0) +
          (candidate.format === "managed-project-doc" ? 2 : 0) +
          (candidate.format === "project-docs" ? 0.25 : 0);
        rows.push({ path, root: candidate.dir, content, score, scope: candidate.scope, format: candidate.format });
      }
    }
    const uniqueRows = new Map<string, typeof rows[number]>();
    for (const row of rows) if (!uniqueRows.has(resolve(row.path))) uniqueRows.set(resolve(row.path), row);
    const rankedRows = [...uniqueRows.values()]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    let remaining = this.maxChars;
    const items: ContextItem[] = [];
    for (const row of rankedRows) {
      if (remaining <= 0) break;
      const clipped = row.content.slice(0, remaining);
      if (!clipped.trim()) continue;
      const relativePath = relative(row.root, row.path).replaceAll("\\", "/");
      items.push({
        id: `architecture:${projectId}:${createHash("sha256").update(`${row.format}\0${row.root}\0${relativePath}`).digest("hex").slice(0, 16)}`,
        content: `# ${relativePath}\n\n${clipped}`,
        authority: "authoritative",
        scope: "project",
        source: "project-architecture",
        projectId,
        provenance: {
          storage: row.scope,
          path: relativePath,
          format: row.format,
          ...(row.format === "normify-files" ? { legacyFormat: "normify-files" } : {})
        }
      });
      remaining -= clipped.length;
    }
    return items;
  }

  async inspectProjectArchitecture(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectArchitectureDocument | null> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const path = this.managedArchitecturePath(accountId, projectId);
    const managedDir = dirname(path);
    try {
      const content = await readFile(path, "utf8");
      return architectureDocument(projectId, managedDir, path, true, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }

    // First write may migrate an existing repository Architecture document
    // into Memhub-managed state. The repository remains read-only; its current
    // body is only the reviewed seed and participates in the stale-plan hash.
    let seedContent = "";
    const workspaceDir = await this.projectWorkspaceDir(projectId);
    if (workspaceDir) {
      const external = await projectArchitectureMarkdownFiles(workspaceDir);
      if (external[0]) seedContent = await readFile(external[0], "utf8");
    }
    return architectureDocument(projectId, managedDir, path, false, seedContent);
  }

  async writeProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    expectedPath: string;
    expectedFingerprint: string;
    content: string;
  }): Promise<{ before: ProjectArchitectureDocument; after: ProjectArchitectureDocument }> {
    requireNonEmpty(input.accountId, "accountId");
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const normalizedContent = normalizeArchitectureContent(input.content);
    const expectedPath = resolve(requireNonEmpty(input.expectedPath, "expectedPath"));
    return withFileMutationLock(expectedPath, async () => {
      const before = await this.inspectProjectArchitecture({ accountId: input.accountId, projectId });
      if (!before) throw new Error(`no canonical workspace found for project: ${projectId}`);
      if (resolve(before.path) !== expectedPath) {
        throw new Error("Project Architecture target changed after plan; create a fresh plan");
      }
      if (before.fingerprint !== input.expectedFingerprint) {
        throw new Error("Project Architecture changed after plan; create a fresh plan");
      }
      await mkdir(dirname(expectedPath), { recursive: true, mode: 0o700 });
      const tmp = `${expectedPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, normalizedContent, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, expectedPath);
      const after = await this.inspectProjectArchitecture({ accountId: input.accountId, projectId });
      if (!after || resolve(after.path) !== expectedPath) {
        throw new Error("Project Architecture write completed but canonical document could not be re-read");
      }
      return { before, after };
    });
  }

  private async architectureDirs(accountId: string): Promise<ArchitectureDir[]> {
    const results: ArchitectureDir[] = [];
    const managedAccountRoot = join(this.managedRootDir, accountHash(accountId));
    for (const dir of await childDirs(managedAccountRoot)) {
      const projectId = managedProjectIdFromDir(dir);
      if (projectId && await fileExists(join(dir, "ARCHITECTURE.md"))) {
        results.push({ projectId, dir, scope: "memhub-managed", format: "managed-project-doc" });
      }
    }
    const accountRoot = join(this.rootDir, ".normify", "accounts", accountHash(accountId));
    for (const dir of await childArchitectureDirs(accountRoot)) {
      results.push({ projectId: projectIdFromDir(dir), dir, scope: "account-scoped", format: "normify-files" });
    }
    for (const dir of await childArchitectureDirs(this.rootDir)) {
      results.push({ projectId: projectIdFromDir(dir), dir, scope: "legacy-repo-local", format: "normify-files" });
    }
    if (await hasProjectArchitectureDocs(this.rootDir)) {
      results.push({ projectId: basename(this.rootDir), dir: this.rootDir, scope: "project-repo", format: "project-docs" });
    }
    for (const child of await childDirs(this.rootDir)) {
      if (basename(child) === ".normify") continue;
      for (const dir of await childArchitectureDirs(child)) {
        results.push({ projectId: projectIdFromDir(dir), dir, scope: "legacy-repo-local", format: "normify-files" });
      }
      if (await isProjectRepositoryRoot(child) && await hasProjectArchitectureDocs(child)) {
        results.push({ projectId: basename(child), dir: child, scope: "project-repo", format: "project-docs" });
      }
    }
    // Current Linux workspaces are normally nested under
    // <architecture-root>/codex-workspace/<project>. The old one-level scan
    // missed those repositories entirely when architecture-root pointed at a
    // user's home directory.
    // Treat direct children of the known workspace container as project roots
    // whenever they actually contain architecture docs. A repository marker is
    // deliberately not required: the canonical project container may hold
    // runtime/publish subtrees rather than being a Git repository itself.
    const workspaceContainer = join(this.rootDir, "codex-workspace");
    for (const child of await childDirs(workspaceContainer)) {
      if (await hasProjectArchitectureDocs(child)) {
        results.push({ projectId: basename(child), dir: child, scope: "project-repo", format: "project-docs" });
      }
    }
    const unique = new Map<string, typeof results[number]>();
    for (const item of results) {
      const key = `${item.scope}\0${item.projectId}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    return [...unique.values()].sort((a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "memhub-managed" ? -1 : b.scope === "memhub-managed" ? 1 : a.scope === "account-scoped" ? -1 : 1) ||
      a.projectId.localeCompare(b.projectId)
    );
  }

  private managedArchitecturePath(accountId: string, projectId: string): string {
    return join(this.managedRootDir, accountHash(accountId), encodeURIComponent(projectId), "ARCHITECTURE.md");
  }

  private async projectWorkspaceDir(projectId: string): Promise<string | null> {
    const wanted = normalizeProjectFolder(projectId);
    const workspaceContainer = join(this.rootDir, "codex-workspace");
    if (normalizeProjectFolder(basename(this.rootDir)) === wanted && await dirExists(this.rootDir)) {
      return this.rootDir;
    }
    // Canonical engineering workspaces take precedence over home-directory
    // state such as ~/.memhub. Never let a hidden state directory become a
    // Project Architecture write target merely because its basename matches.
    for (const child of await childDirs(workspaceContainer)) {
      if (normalizeProjectFolder(basename(child)) === wanted) return child;
    }
    for (const child of await childDirs(this.rootDir)) {
      if (basename(child).startsWith(".")) continue;
      if (normalizeProjectFolder(basename(child)) !== wanted) continue;
      if (await isProjectRepositoryRoot(child) || await hasProjectArchitectureDocs(child)) return child;
    }
    return null;
  }
}

interface ArchitectureDir {
  projectId: string;
  dir: string;
  scope: "memhub-managed" | "account-scoped" | "legacy-repo-local" | "project-repo";
  format: "managed-project-doc" | "normify-files" | "project-docs";
}

async function architectureMarkdownFiles(candidate: ArchitectureDir, projectId: string): Promise<string[]> {
  if (candidate.format === "managed-project-doc") {
    const path = join(candidate.dir, "ARCHITECTURE.md");
    return await fileExists(path) ? [path] : [];
  }
  if (candidate.format === "project-docs") return projectArchitectureMarkdownFiles(candidate.dir);
  const root = candidate.dir;
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

async function projectArchitectureMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const path of [
    join(root, "ARCHITECTURE.md"),
    join(root, "docs", "ARCHITECTURE.md"),
    join(root, "docs", "architecture.md")
  ]) {
    if (await fileExists(path) && !files.includes(path)) files.push(path);
  }
  for (const file of await markdownFiles(join(root, "docs", "architecture"), 2)) {
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

async function hasProjectArchitectureDocs(root: string): Promise<boolean> {
  return (await projectArchitectureMarkdownFiles(root)).length > 0;
}

function architectureDocument(
  projectId: string,
  workspaceDir: string,
  path: string,
  exists: boolean,
  content: string
): ProjectArchitectureDocument {
  const normalized = content;
  return {
    projectId,
    workspaceDir,
    path,
    relativePath: relative(workspaceDir, path).replaceAll("\\", "/"),
    exists,
    content: normalized,
    fingerprint: createHash("sha256").update(`${exists ? "1" : "0"}\0${normalized}`, "utf8").digest("hex")
  };
}

function managedProjectIdFromDir(dir: string): string | null {
  try {
    const decoded = decodeURIComponent(basename(dir));
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

function normalizeArchitectureContent(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new TypeError("Project Architecture content must be non-empty");
  return `${normalized}\n`;
}

function normalizeProjectFolder(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

async function isProjectRepositoryRoot(root: string): Promise<boolean> {
  for (const marker of [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    try {
      const info = await stat(join(root, marker));
      if (marker === ".git" ? info.isDirectory() || info.isFile() : info.isFile()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  return false;
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
