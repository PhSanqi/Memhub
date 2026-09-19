import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => SqliteDatabase;
const Database = createRequire(import.meta.url)("better-sqlite3") as SqliteConstructor;

export type HistoryDistillationScope = "project" | "account";
export type HistoryDistillationTarget = "memory" | "skill";

export interface HistoryEvidence {
  ref: string;
  kind: "turn" | "memory" | "user_memory";
  timestamp: string;
  conversation_id?: string;
  project_id?: string;
  layer?: string;
  title?: string;
  content?: string;
  user_text?: string;
  assistant_text?: string;
  tags?: string[];
}

export interface MemoryHistoryDocument {
  title: string;
  overview: string;
  who: string[];
  what: string[];
  where: string[];
  when: string[];
  why: string[];
  how: string[];
  decisions: string[];
  constraints: string[];
  preferences: string[];
  relationships: string[];
  current_truth: string[];
  legacy: string[];
  unknowns: string[];
  provenance: string[];
}

export interface SkillHistoryDocument {
  title: string;
  purpose: string;
  when_to_use: string[];
  prerequisites: string[];
  inputs: string[];
  procedure: string[];
  verification: string[];
  failure_modes: string[];
  boundaries: string[];
  reusable_principles: string[];
  provenance: string[];
}

export interface HistoryDistillationSeries {
  series_key: string;
  account_id: string;
  scope: HistoryDistillationScope;
  project_id: string | null;
  target: HistoryDistillationTarget;
  processed_refs: string[];
  latest_result_id?: string;
  latest_content?: string;
  skill_catalog?: Array<{
    key: string;
    title: string;
    result_id: string;
    content: string;
    updated_at: string;
  }>;
  updated_at: string;
}

export interface HistoryDistillationRun {
  run_id: string;
  series_key: string;
  account_id: string;
  scope: HistoryDistillationScope;
  project_id: string | null;
  target: HistoryDistillationTarget;
  status: "active" | "completed";
  created_at: string;
  updated_at: string;
  evidence: HistoryEvidence[];
  cursor: number;
  current_batch?: {
    batch_hash: string;
    from: number;
    to: number;
    refs: string[];
    leased_by: string;
    leased_until: string;
  };
}

interface HistoryStore {
  version: 1;
  series: HistoryDistillationSeries[];
  runs: HistoryDistillationRun[];
}

export interface HistoryBatch {
  run_id: string;
  series_key: string;
  target: HistoryDistillationTarget;
  scope: HistoryDistillationScope;
  project_id: string | null;
  batch_hash: string;
  evidence: HistoryEvidence[];
  remaining_after_batch: number;
  continuation: {
    prior_result_id?: string;
    prior_memory_document?: string;
    prior_skills?: Array<{ title: string; content: string; result_id: string }>;
  };
}

export interface PreparedHistorySubmission {
  run: HistoryDistillationRun;
  series: HistoryDistillationSeries;
  batch: HistoryDistillationRun["current_batch"] & {};
  evidence: HistoryEvidence[];
}

let mutationTail = Promise.resolve();

export function historySeriesKey(input: {
  accountId: string;
  scope: HistoryDistillationScope;
  projectId: string | null;
  target: HistoryDistillationTarget;
}): string {
  return createHash("sha256")
    .update([input.accountId, input.scope, input.projectId ?? "account", input.target].join("\0"), "utf8")
    .digest("hex");
}

export async function startHistoryDistillation(input: {
  stateRoot: string;
  accountId: string;
  scope: HistoryDistillationScope;
  projectId: string | null;
  target: HistoryDistillationTarget;
  evidence: HistoryEvidence[];
}): Promise<{ created: boolean; run: HistoryDistillationRun | null; fresh_count: number; processed_count: number }> {
  return withMutation(async () => {
    const store = await loadStore(input.stateRoot);
    const key = historySeriesKey(input);
    const now = new Date().toISOString();
    let series = store.series.find((item) => item.series_key === key);
    if (!series) {
      series = {
        series_key: key,
        account_id: input.accountId,
        scope: input.scope,
        project_id: input.projectId,
        target: input.target,
        processed_refs: [],
        updated_at: now
      };
      store.series.push(series);
    }
    if (input.target === "skill") {
      const processed = new Set(series.processed_refs);
      const catalog = [...(series.skill_catalog ?? [])];
      for (const item of input.evidence.filter((candidate) => candidate.layer === "Skill" && candidate.content?.trim())) {
        const resultId = item.ref.startsWith("memory:") ? item.ref.slice("memory:".length) : item.ref;
        const title = item.title?.trim() || titleFromContent(item.content!);
        const key = skillKey(title);
        if (!catalog.some((entry) => entry.key === key)) {
          catalog.push({ key, title, result_id: resultId, content: item.content!, updated_at: item.timestamp });
        }
        processed.add(item.ref);
      }
      series.skill_catalog = catalog.sort((left, right) => left.title.localeCompare(right.title));
      series.processed_refs = [...processed];
    }
    const active = store.runs.find((item) => item.series_key === key && item.status === "active");
    if (active) {
      return {
        created: false,
        run: structuredClone(active),
        fresh_count: Math.max(0, active.evidence.length - active.cursor),
        processed_count: series.processed_refs.length
      };
    }
    const processed = new Set(series.processed_refs);
    const fresh = uniqueEvidence(input.evidence)
      .filter((item) => !processed.has(item.ref))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.ref.localeCompare(right.ref));
    if (fresh.length === 0) {
      await saveStore(input.stateRoot, store);
      return { created: false, run: null, fresh_count: 0, processed_count: series.processed_refs.length };
    }
    const run: HistoryDistillationRun = {
      run_id: randomUUID(),
      series_key: key,
      account_id: input.accountId,
      scope: input.scope,
      project_id: input.projectId,
      target: input.target,
      status: "active",
      created_at: now,
      updated_at: now,
      evidence: fresh,
      cursor: 0
    };
    store.runs.push(run);
    series.updated_at = now;
    await saveStore(input.stateRoot, store);
    return { created: true, run: structuredClone(run), fresh_count: fresh.length, processed_count: series.processed_refs.length };
  });
}

export async function leaseHistoryBatch(
  stateRoot: string,
  accountId: string,
  runId: string,
  harness: string,
  leaseSeconds = 600
): Promise<HistoryBatch | null> {
  return withMutation(async () => {
    const store = await loadStore(stateRoot);
    const run = requireRun(store, accountId, runId);
    const series = requireSeries(store, run.series_key);
    if (run.status === "completed" || run.cursor >= run.evidence.length) return null;
    const now = Date.now();
    if (run.current_batch) {
      const expired = Date.parse(run.current_batch.leased_until) <= now;
      if (!expired && run.current_batch.leased_by !== harness) {
        throw new Error(`history distillation batch is leased by ${run.current_batch.leased_by}`);
      }
      if (!expired) return batchPayload(run, series);
      delete run.current_batch;
    }
    const { to, refs } = chooseBatch(run.evidence, run.cursor);
    const batchHash = createHash("sha256")
      .update(JSON.stringify({ series: run.series_key, run: run.run_id, from: run.cursor, to, refs }), "utf8")
      .digest("hex");
    const seconds = Math.max(60, Math.min(1800, Math.trunc(leaseSeconds)));
    run.current_batch = {
      batch_hash: batchHash,
      from: run.cursor,
      to,
      refs,
      leased_by: harness,
      leased_until: new Date(now + seconds * 1000).toISOString()
    };
    run.updated_at = new Date(now).toISOString();
    await saveStore(stateRoot, store);
    return batchPayload(run, series);
  });
}

export async function prepareHistorySubmission(
  stateRoot: string,
  accountId: string,
  runId: string,
  batchHash: string
): Promise<PreparedHistorySubmission> {
  const store = await loadStore(stateRoot);
  const run = requireRun(store, accountId, runId);
  const series = requireSeries(store, run.series_key);
  const batch = run.current_batch;
  if (!batch || batch.batch_hash !== batchHash) throw new Error("history distillation batch hash mismatch or no active lease");
  if (Date.parse(batch.leased_until) <= Date.now()) throw new Error("history distillation batch lease expired");
  return {
    run: structuredClone(run),
    series: structuredClone(series),
    batch: structuredClone(batch),
    evidence: structuredClone(run.evidence.slice(batch.from, batch.to))
  };
}

export async function commitHistoryMemoryBatch(input: {
  stateRoot: string;
  accountId: string;
  runId: string;
  batchHash: string;
  resultId: string;
  content: string;
}): Promise<HistoryDistillationRun> {
  return commitBatch(input, (series, now) => {
    series.latest_result_id = input.resultId;
    series.latest_content = input.content;
    series.updated_at = now;
  });
}

export async function commitHistorySkillBatch(input: {
  stateRoot: string;
  accountId: string;
  runId: string;
  batchHash: string;
  skills: Array<{ title: string; resultId: string; content: string }>;
}): Promise<HistoryDistillationRun> {
  return commitBatch(input, (series, now) => {
    const catalog = [...(series.skill_catalog ?? [])];
    for (const skill of input.skills) {
      const key = skillKey(skill.title);
      const next = { key, title: skill.title, result_id: skill.resultId, content: skill.content, updated_at: now };
      const index = catalog.findIndex((item) => item.key === key);
      if (index >= 0) catalog[index] = next;
      else catalog.push(next);
    }
    series.skill_catalog = catalog.sort((left, right) => left.title.localeCompare(right.title));
    series.updated_at = now;
  });
}

export async function listHistoryDistillationState(
  stateRoot: string,
  accountId: string
): Promise<{ series: HistoryDistillationSeries[]; runs: HistoryDistillationRun[] }> {
  const store = await loadStore(stateRoot);
  return {
    series: store.series.filter((item) => item.account_id === accountId).map((item) => structuredClone(item)),
    runs: store.runs.filter((item) => item.account_id === accountId).map((item) => structuredClone(item))
  };
}

export function validateMemoryHistoryDocument(value: unknown): MemoryHistoryDocument {
  const record = objectValue(value, "memory");
  return {
    title: requiredString(record.title, "memory.title"),
    overview: requiredString(record.overview, "memory.overview"),
    who: stringList(record.who, "memory.who"),
    what: stringList(record.what, "memory.what"),
    where: stringList(record.where, "memory.where"),
    when: stringList(record.when, "memory.when"),
    why: stringList(record.why, "memory.why"),
    how: stringList(record.how, "memory.how"),
    decisions: stringList(record.decisions, "memory.decisions"),
    constraints: stringList(record.constraints, "memory.constraints"),
    preferences: stringList(record.preferences, "memory.preferences"),
    relationships: stringList(record.relationships, "memory.relationships"),
    current_truth: stringList(record.current_truth, "memory.current_truth"),
    legacy: stringList(record.legacy, "memory.legacy"),
    unknowns: stringList(record.unknowns, "memory.unknowns"),
    provenance: stringList(record.provenance, "memory.provenance")
  };
}

export function validateSkillHistoryDocuments(value: unknown): SkillHistoryDocument[] {
  if (!Array.isArray(value)) throw new TypeError("skills must be an array");
  if (value.length > 10) throw new TypeError("skills may contain at most 10 artifacts per batch");
  return value.map((item, index) => {
    const record = objectValue(item, `skills[${index}]`);
    const procedure = stringList(record.procedure, `skills[${index}].procedure`);
    if (procedure.length === 0) throw new TypeError(`skills[${index}].procedure must not be empty`);
    return {
      title: requiredString(record.title, `skills[${index}].title`),
      purpose: requiredString(record.purpose, `skills[${index}].purpose`),
      when_to_use: stringList(record.when_to_use, `skills[${index}].when_to_use`),
      prerequisites: stringList(record.prerequisites, `skills[${index}].prerequisites`),
      inputs: stringList(record.inputs, `skills[${index}].inputs`),
      procedure,
      verification: stringList(record.verification, `skills[${index}].verification`),
      failure_modes: stringList(record.failure_modes, `skills[${index}].failure_modes`),
      boundaries: stringList(record.boundaries, `skills[${index}].boundaries`),
      reusable_principles: stringList(record.reusable_principles, `skills[${index}].reusable_principles`),
      provenance: stringList(record.provenance, `skills[${index}].provenance`)
    };
  });
}

export function renderMemoryHistoryDocument(document: MemoryHistoryDocument): string {
  return renderDocument(document.title, document.overview, [
    ["Who", document.who], ["What", document.what], ["Where", document.where], ["When / Timeline", document.when],
    ["Why", document.why], ["How", document.how], ["Decisions", document.decisions], ["Constraints", document.constraints],
    ["Preferences", document.preferences], ["Relationships", document.relationships], ["Current Truth", document.current_truth],
    ["Legacy / Superseded", document.legacy], ["Unknowns / Risks", document.unknowns], ["Provenance", document.provenance]
  ]);
}

export function renderSkillHistoryDocument(document: SkillHistoryDocument): string {
  return renderDocument(document.title, document.purpose, [
    ["When to use", document.when_to_use], ["Prerequisites", document.prerequisites], ["Inputs", document.inputs],
    ["Procedure", document.procedure], ["Verification", document.verification], ["Failure modes", document.failure_modes],
    ["Boundaries", document.boundaries], ["Reusable principles", document.reusable_principles], ["Provenance", document.provenance]
  ]);
}

export function skillKey(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "skill";
}

export function listCoreMemoryEvidence(input: {
  dbPath: string;
  userId: string;
  projectId?: string | null;
  excludeCaptureDerived?: boolean;
}): HistoryEvidence[] {
  const db = new Database(resolve(input.dbPath), { readonly: true, fileMustExist: true });
  try {
    const memories = db.prepare(`
      SELECT id, conversation_id, memory_value, memory_layer, tags_json, info_json, properties_json, created_at, updated_at
      FROM memories
      WHERE user_id = ? AND deleted_at IS NULL AND status IN ('activated', 'resolving')
      ORDER BY created_at ASC, id ASC
    `).all(input.userId) as Array<Record<string, unknown>>;
    const evidence: HistoryEvidence[] = [];
    for (const row of memories) {
      const tags = parseStringArray(row.tags_json);
      if (tags.includes("memhub-history-distill")) continue;
      if (input.excludeCaptureDerived && tags.includes("memhub-capture")) continue;
      const projectId = projectIdFromRow(row, tags);
      if (input.projectId !== undefined && input.projectId !== null && projectId !== input.projectId) continue;
      const content = stringValue(row.memory_value);
      if (!content) continue;
      evidence.push({
        ref: `memory:${stringValue(row.id)}`,
        kind: "memory",
        timestamp: stringValue(row.created_at) || stringValue(row.updated_at) || new Date(0).toISOString(),
        ...(stringValue(row.conversation_id) ? { conversation_id: stringValue(row.conversation_id) } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        layer: stringValue(row.memory_layer),
        title: titleFromContent(content),
        content,
        tags
      });
    }
    if (input.projectId === undefined || input.projectId === null) {
      const userRows = db.prepare(`
        SELECT id, content, created_at, updated_at
        FROM user_memories
        WHERE user_id = ? AND status = 'active'
        ORDER BY created_at ASC, id ASC
      `).all(input.userId) as Array<Record<string, unknown>>;
      for (const row of userRows) {
        const content = stringValue(row.content);
        if (!content) continue;
        evidence.push({
          ref: `user-memory:${stringValue(row.id)}`,
          kind: "user_memory",
          timestamp: stringValue(row.created_at) || stringValue(row.updated_at) || new Date(0).toISOString(),
          content,
          layer: "UserMemory"
        });
      }
    }
    return uniqueEvidence(evidence);
  } finally {
    db.close();
  }
}

async function commitBatch(
  input: { stateRoot: string; accountId: string; runId: string; batchHash: string },
  updateSeries: (series: HistoryDistillationSeries, now: string) => void
): Promise<HistoryDistillationRun> {
  return withMutation(async () => {
    const store = await loadStore(input.stateRoot);
    const run = requireRun(store, input.accountId, input.runId);
    const series = requireSeries(store, run.series_key);
    const batch = run.current_batch;
    if (!batch || batch.batch_hash !== input.batchHash) throw new Error("history distillation batch hash mismatch or no active lease");
    const now = new Date().toISOString();
    const processed = new Set(series.processed_refs);
    for (const ref of batch.refs) processed.add(ref);
    series.processed_refs = [...processed];
    updateSeries(series, now);
    run.cursor = batch.to;
    run.updated_at = now;
    delete run.current_batch;
    if (run.cursor >= run.evidence.length) run.status = "completed";
    await saveStore(input.stateRoot, store);
    return structuredClone(run);
  });
}

function batchPayload(run: HistoryDistillationRun, series: HistoryDistillationSeries): HistoryBatch {
  const batch = run.current_batch!;
  return {
    run_id: run.run_id,
    series_key: run.series_key,
    target: run.target,
    scope: run.scope,
    project_id: run.project_id,
    batch_hash: batch.batch_hash,
    evidence: structuredClone(run.evidence.slice(batch.from, batch.to)),
    remaining_after_batch: run.evidence.length - batch.to,
    continuation: run.target === "memory"
      ? {
          ...(series.latest_result_id ? { prior_result_id: series.latest_result_id } : {}),
          ...(series.latest_content ? { prior_memory_document: series.latest_content } : {})
        }
      : {
          prior_skills: (series.skill_catalog ?? []).map((item) => ({ title: item.title, content: item.content, result_id: item.result_id }))
        }
  };
}

function chooseBatch(evidence: HistoryEvidence[], from: number): { to: number; refs: string[] } {
  const maxItems = 16;
  const maxChars = 36_000;
  let chars = 0;
  let to = from;
  while (to < evidence.length && to - from < maxItems) {
    const next = evidence[to]!;
    const size = JSON.stringify(next).length;
    if (to > from && chars + size > maxChars) break;
    chars += size;
    to += 1;
  }
  if (to === from) to = Math.min(evidence.length, from + 1);
  return { to, refs: evidence.slice(from, to).map((item) => item.ref) };
}

function uniqueEvidence(evidence: HistoryEvidence[]): HistoryEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (!item.ref.trim() || seen.has(item.ref)) return false;
    seen.add(item.ref);
    return true;
  });
}

function projectIdFromRow(row: Record<string, unknown>, tags: string[]): string | undefined {
  const info = parseObject(row.info_json);
  const properties = parseObject(row.properties_json);
  const nestedInfo = properties.info && typeof properties.info === "object" && !Array.isArray(properties.info)
    ? properties.info as Record<string, unknown>
    : {};
  const direct = stringValue(info.project_id) || stringValue(info.projectId) || stringValue(nestedInfo.project_id) || stringValue(nestedInfo.projectId);
  if (direct) return direct;
  const tag = tags.find((item) => item.startsWith("project:"));
  return tag?.slice("project:".length).trim() || undefined;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function renderDocument(title: string, introduction: string, sections: Array<[string, string[]]>): string {
  const body = sections.map(([heading, items]) => `## ${heading}\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "- No durable fact established from current evidence."}`).join("\n\n");
  return `# ${title}\n\n${introduction}\n\n${body}`;
}

function titleFromContent(content: string): string {
  const first = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Skill";
  return first.replace(/^#+\s*/, "").slice(0, 160) || "Skill";
}

function requireRun(store: HistoryStore, accountId: string, runId: string): HistoryDistillationRun {
  const run = store.runs.find((item) => item.run_id === runId && item.account_id === accountId);
  if (!run) throw new Error("history distillation run not found for account");
  return run;
}

function requireSeries(store: HistoryStore, key: string): HistoryDistillationSeries {
  const series = store.series.find((item) => item.series_key === key);
  if (!series) throw new Error("history distillation series not found");
  return series;
}

function storePath(root: string): string {
  return join(resolve(root), "distillation", "history.json");
}

async function loadStore(root: string): Promise<HistoryStore> {
  try {
    const raw = JSON.parse(await readFile(storePath(root), "utf8")) as HistoryStore;
    return raw.version === 1 && Array.isArray(raw.series) && Array.isArray(raw.runs) ? raw : { version: 1, series: [], runs: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, series: [], runs: [] };
    throw error;
  }
}

async function saveStore(root: string, store: HistoryStore): Promise<void> {
  const path = storePath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

async function withMutation<T>(run: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolveLock) => { release = resolveLock; });
  await previous;
  try { return await run(); } finally { release(); }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const text = stringValue(value);
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}
