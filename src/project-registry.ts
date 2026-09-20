import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ProjectState = "active" | "merged" | "deleted";

export interface ProjectDescriptor {
  projectId: string;
  name: string;
  description: string;
  manualDescription?: string;
  distilledDescription?: string;
  descriptionSource?: "manual" | "distilled" | "legacy" | "empty";
  descriptionEvidenceRefs?: string[];
  descriptionUpdatedAt?: string;
  aliases: string[];
  state: ProjectState;
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredProject extends ProjectDescriptor {
  accountId: string;
}

interface ProjectRegistryFile {
  version: 1;
  projects: StoredProject[];
}

export interface ProjectSuggestion extends ProjectDescriptor {
  similarity: number;
  matchedBy: string;
}

export class JsonProjectRegistry {
  private mutation = Promise.resolve();

  constructor(private readonly path: string) {}

  async reconcile(accountId: string, discoveredIds: readonly string[]): Promise<ProjectDescriptor[]> {
    const account = requireNonEmpty(accountId, "accountId");
    await this.serialize(async () => {
      const file = await this.read();
      const now = new Date().toISOString();
      const discovered = unique(discoveredIds.map((value) => value.trim()).filter(Boolean));
      const groups = new Map<string, string[]>();
      for (const id of discovered) {
        const key = normalizeProjectKey(id);
        if (!key) continue;
        const group = groups.get(key) ?? [];
        group.push(id);
        groups.set(key, group);
      }

      let changed = false;
      for (const [key, ids] of groups) {
        const sameKey = file.projects.filter((project) =>
          project.accountId === account &&
          [project.projectId, project.name, ...project.aliases].some((value) => normalizeProjectKey(value) === key)
        );
        const active = sameKey.find((project) => project.state === "active");
        if (active) {
          const aliases = unique([...active.aliases, ...ids].filter((value) => value !== active.projectId));
          if (!sameStringArray(aliases, active.aliases)) {
            active.aliases = aliases;
            active.updatedAt = now;
            changed = true;
          }
          for (const duplicate of sameKey.filter((project) => project !== active && project.state === "active")) {
            duplicate.state = "merged";
            duplicate.mergedInto = active.projectId;
            duplicate.updatedAt = now;
            active.aliases = unique([...active.aliases, duplicate.projectId, duplicate.name, ...duplicate.aliases]
              .filter((value) => value !== active.projectId));
            changed = true;
          }
          continue;
        }
        if (sameKey.length > 0) continue;
        const projectId = preferredCanonical(ids);
        file.projects.push({
          accountId: account,
          projectId,
          name: projectId,
          description: "",
          descriptionSource: "empty",
          aliases: unique(ids.filter((value) => value !== projectId)),
          state: "active",
          createdAt: now,
          updatedAt: now
        });
        changed = true;
      }
      if (changed) await this.write(file);
    });
    return this.list(account);
  }

  async list(accountId: string, options: { includeInactive?: boolean } = {}): Promise<ProjectDescriptor[]> {
    const account = requireNonEmpty(accountId, "accountId");
    const file = await this.read();
    return file.projects
      .filter((project) => project.accountId === account)
      .filter((project) => options.includeInactive || project.state === "active")
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
      .map(stripAccount);
  }

  async resolve(accountId: string, reference: string): Promise<string | null> {
    const account = requireNonEmpty(accountId, "accountId");
    const ref = requireNonEmpty(reference, "project");
    const file = await this.read();
    const projects = file.projects.filter((project) => project.accountId === account);
    const exact = projects.find((project) => project.state === "active" &&
      (project.projectId === ref || project.name === ref || project.aliases.includes(ref))
    );
    const normalizedActive = projects.find((project) => project.state === "active" &&
      [project.projectId, project.name, ...project.aliases].some((value) => normalizeProjectKey(value) === normalizeProjectKey(ref))
    );
    const historical = projects.find((project) => project.state === "merged" &&
      (project.projectId === ref || project.name === ref || project.aliases.includes(ref) ||
        [project.projectId, project.name, ...project.aliases].some((value) => normalizeProjectKey(value) === normalizeProjectKey(ref)))
    );
    const candidate = exact ?? normalizedActive ?? historical;
    if (!candidate || candidate.state === "deleted") return null;
    if (candidate.state === "active") return candidate.projectId;
    if (!candidate.mergedInto) return null;
    const target = projects.find((project) => project.projectId === candidate.mergedInto && project.state === "active");
    return target?.projectId ?? null;
  }

  async storageIds(accountId: string, canonicalProjectId: string): Promise<string[]> {
    const account = requireNonEmpty(accountId, "accountId");
    const canonical = requireNonEmpty(canonicalProjectId, "projectId");
    const file = await this.read();
    const projects = file.projects.filter((project) => project.accountId === account);
    const target = projects.find((project) => project.projectId === canonical && project.state === "active");
    if (!target) return [canonical];
    const merged = projects.filter((project) => project.state === "merged" && project.mergedInto === canonical);
    return unique([
      target.projectId,
      ...target.aliases,
      ...merged.flatMap((project) => [project.projectId, project.name, ...project.aliases])
    ]);
  }

  async suggest(accountId: string, query: string, limit = 8): Promise<ProjectSuggestion[]> {
    const normalizedQuery = requireNonEmpty(query, "query");
    const projects = await this.list(accountId);
    return projects
      .map((project) => {
        const candidates = [project.projectId, project.name, ...project.aliases];
        let similarity = 0;
        let matchedBy = project.projectId;
        for (const candidate of candidates) {
          const score = projectSimilarity(normalizedQuery, candidate);
          if (score > similarity) {
            similarity = score;
            matchedBy = candidate;
          }
        }
        return { ...project, similarity, matchedBy };
      })
      .filter((project) => project.similarity >= 0.24)
      .sort((left, right) => right.similarity - left.similarity || left.projectId.localeCompare(right.projectId))
      .slice(0, Math.max(1, Math.min(20, Math.trunc(limit))));
  }

  async create(accountId: string, input: {
    projectId: string;
    name?: string;
    description: string;
    aliases?: string[];
  }): Promise<ProjectDescriptor> {
    const account = requireNonEmpty(accountId, "accountId");
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const description = requireNonEmpty(input.description, "description");
    const name = input.name?.trim() || projectId;
    const aliases = unique((input.aliases ?? []).map((value) => value.trim()).filter(Boolean))
      .filter((value) => normalizeProjectKey(value) !== normalizeProjectKey(projectId));
    return this.serialize(async () => {
      const file = await this.read();
      const key = normalizeProjectKey(projectId);
      const conflict = file.projects.find((project) =>
        project.accountId === account &&
        [project.projectId, project.name, ...project.aliases].some((value) => normalizeProjectKey(value) === key)
      );
      if (conflict) throw new Error(`project already exists or aliases to ${conflict.projectId}`);
      ensureAliasesAvailable(file, account, projectId, aliases);
      const now = new Date().toISOString();
      const created: StoredProject = {
        accountId: account,
        projectId,
        name,
        description,
        manualDescription: description,
        descriptionSource: "manual",
        descriptionUpdatedAt: now,
        aliases,
        state: "active",
        createdAt: now,
        updatedAt: now
      };
      file.projects.push(created);
      await this.write(file);
      return stripAccount(created);
    });
  }

  async update(accountId: string, projectRef: string, patch: {
    name?: string;
    description?: string;
    aliases?: string[];
  }): Promise<ProjectDescriptor> {
    const account = requireNonEmpty(accountId, "accountId");
    const projectId = await this.resolve(account, projectRef);
    if (!projectId) throw new Error(`unknown or inactive project: ${projectRef}`);
    return this.serialize(async () => {
      const file = await this.read();
      const project = requireActive(file, account, projectId);
      if (patch.name !== undefined) project.name = requireNonEmpty(patch.name, "name");
      if (patch.description !== undefined) {
        const description = patch.description.trim();
        if (description) {
          project.manualDescription = description;
          project.description = description;
          project.descriptionSource = "manual";
        } else {
          delete project.manualDescription;
          if (project.distilledDescription?.trim()) {
            project.description = project.distilledDescription.trim();
            project.descriptionSource = "distilled";
          } else {
            project.description = "";
            project.descriptionSource = "empty";
          }
        }
        project.descriptionUpdatedAt = new Date().toISOString();
      }
      if (patch.aliases !== undefined) {
        const aliases = unique(patch.aliases.map((value) => value.trim()).filter(Boolean))
          .filter((value) => normalizeProjectKey(value) !== normalizeProjectKey(project.projectId));
        ensureAliasesAvailable(file, account, project.projectId, aliases);
        const historicalAliases = file.projects
          .filter((item) => item.accountId === account && item.state === "merged" && item.mergedInto === project.projectId)
          .flatMap((item) => [item.projectId, item.name, ...item.aliases]);
        project.aliases = unique([...aliases, ...historicalAliases])
          .filter((value) => value !== project.projectId);
      }
      project.updatedAt = new Date().toISOString();
      await this.write(file);
      return stripAccount(project);
    });
  }

  async updateDistilledDescription(
    accountId: string,
    projectRef: string,
    descriptionRaw: string,
    evidenceRefs: readonly string[] = []
  ): Promise<ProjectDescriptor> {
    const account = requireNonEmpty(accountId, "accountId");
    const projectId = await this.resolve(account, projectRef);
    if (!projectId) throw new Error(`unknown or inactive project: ${projectRef}`);
    const description = requireNonEmpty(descriptionRaw, "description");
    return this.serialize(async () => {
      const file = await this.read();
      const project = requireActive(file, account, projectId);
      const now = new Date().toISOString();
      project.distilledDescription = description;
      project.descriptionEvidenceRefs = unique(evidenceRefs.map((value) => value.trim()).filter(Boolean));
      project.descriptionUpdatedAt = now;
      if (!project.manualDescription?.trim()) {
        project.description = description;
        project.descriptionSource = "distilled";
      } else {
        project.description = project.manualDescription.trim();
        project.descriptionSource = "manual";
      }
      project.updatedAt = now;
      await this.write(file);
      return stripAccount(project);
    });
  }

  async merge(accountId: string, sourceRef: string, targetRef: string): Promise<{
    source: ProjectDescriptor;
    target: ProjectDescriptor;
  }> {
    const account = requireNonEmpty(accountId, "accountId");
    const sourceId = await this.resolve(account, sourceRef);
    const targetId = await this.resolve(account, targetRef);
    if (!sourceId) throw new Error(`unknown source project: ${sourceRef}`);
    if (!targetId) throw new Error(`unknown target project: ${targetRef}`);
    if (sourceId === targetId) throw new Error("source and target already resolve to the same canonical project");
    return this.serialize(async () => {
      const file = await this.read();
      const source = requireActive(file, account, sourceId);
      const target = requireActive(file, account, targetId);
      target.aliases = unique([
        ...target.aliases,
        source.projectId,
        source.name,
        ...source.aliases
      ]).filter((value) => value !== target.projectId);
      if (!target.manualDescription?.trim() && source.manualDescription?.trim()) {
        target.manualDescription = source.manualDescription.trim();
        target.description = target.manualDescription;
        target.descriptionSource = "manual";
        target.descriptionUpdatedAt = source.descriptionUpdatedAt ?? new Date().toISOString();
      } else if (!target.description && source.description) {
        target.description = source.description;
        if (source.manualDescription) target.manualDescription = source.manualDescription;
        if (source.distilledDescription) target.distilledDescription = source.distilledDescription;
        if (source.descriptionSource) target.descriptionSource = source.descriptionSource;
        if (source.descriptionEvidenceRefs) target.descriptionEvidenceRefs = [...source.descriptionEvidenceRefs];
        if (source.descriptionUpdatedAt) target.descriptionUpdatedAt = source.descriptionUpdatedAt;
      }
      const now = new Date().toISOString();
      target.updatedAt = now;
      source.state = "merged";
      source.mergedInto = target.projectId;
      source.updatedAt = now;
      await this.write(file);
      return { source: stripAccount(source), target: stripAccount(target) };
    });
  }

  async delete(accountId: string, projectRef: string): Promise<ProjectDescriptor> {
    const account = requireNonEmpty(accountId, "accountId");
    const projectId = await this.resolve(account, projectRef);
    if (!projectId) throw new Error(`unknown or inactive project: ${projectRef}`);
    return this.serialize(async () => {
      const file = await this.read();
      const project = requireActive(file, account, projectId);
      project.state = "deleted";
      project.updatedAt = new Date().toISOString();
      await this.write(file);
      return stripAccount(project);
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

  private async read(): Promise<ProjectRegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isProjectRegistryFile(parsed)) throw new Error(`invalid project registry: ${this.path}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, projects: [] };
      throw error;
    }
  }

  private async write(file: ProjectRegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export function normalizeProjectKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, "");
}

export function projectSimilarity(left: string, right: string): number {
  const a = normalizeProjectKey(left);
  const b = normalizeProjectKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.92;
  const distance = levenshtein(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

function preferredCanonical(ids: string[]): string {
  const lowercase = ids.filter((value) => value === value.toLocaleLowerCase());
  return [...(lowercase.length ? lowercase : ids)].sort((left, right) => left.localeCompare(right))[0]!;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function requireActive(file: ProjectRegistryFile, accountId: string, projectId: string): StoredProject {
  const project = file.projects.find((item) =>
    item.accountId === accountId && item.projectId === projectId && item.state === "active"
  );
  if (!project) throw new Error(`active project not found: ${projectId}`);
  return project;
}

function ensureAliasesAvailable(file: ProjectRegistryFile, accountId: string, projectId: string, aliases: string[]): void {
  const keys = new Set(aliases.map(normalizeProjectKey));
  for (const project of file.projects) {
    if (project.accountId !== accountId || project.projectId === projectId || project.state !== "active") continue;
    for (const value of [project.projectId, project.name, ...project.aliases]) {
      if (keys.has(normalizeProjectKey(value))) {
        throw new Error(`project alias conflicts with ${project.projectId}: ${value}`);
      }
    }
  }
}

function stripAccount(project: StoredProject): ProjectDescriptor {
  const { accountId: _accountId, ...descriptor } = project;
  return structuredClone(descriptor);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isProjectRegistryFile(value: unknown): value is ProjectRegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.projects)) return false;
  return record.projects.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const project = item as Record<string, unknown>;
    return typeof project.accountId === "string" &&
      typeof project.projectId === "string" &&
      typeof project.name === "string" &&
      typeof project.description === "string" &&
      Array.isArray(project.aliases) &&
      project.aliases.every((alias) => typeof alias === "string") &&
      (project.state === "active" || project.state === "merged" || project.state === "deleted") &&
      typeof project.createdAt === "string" &&
      typeof project.updatedAt === "string" &&
      (project.mergedInto === undefined || typeof project.mergedInto === "string") &&
      (project.manualDescription === undefined || typeof project.manualDescription === "string") &&
      (project.distilledDescription === undefined || typeof project.distilledDescription === "string") &&
      (project.descriptionSource === undefined || ["manual", "distilled", "legacy", "empty"].includes(String(project.descriptionSource))) &&
      (project.descriptionEvidenceRefs === undefined || (Array.isArray(project.descriptionEvidenceRefs) && project.descriptionEvidenceRefs.every((ref) => typeof ref === "string"))) &&
      (project.descriptionUpdatedAt === undefined || typeof project.descriptionUpdatedAt === "string");
  });
}
