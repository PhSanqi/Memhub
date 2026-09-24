import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type SkillExecutionStage = "selected" | "loaded" | "invoked" | "success" | "failure" | "user_correction";

export interface SkillTelemetryEvent {
  event_id: string;
  execution_id: string;
  skill_id: string;
  stage: SkillExecutionStage;
  timestamp: string;
  executor?: string;
  project_id?: string;
  note?: string;
}

export interface SkillTelemetrySummary {
  skill_id: string;
  executions: number;
  invoked: number;
  successes: number;
  failures: number;
  user_corrections: number;
  reliability: number;
  last_stage: SkillExecutionStage | null;
  last_timestamp: string | null;
}

export async function recordSkillLoad(input: {
  stateRoot: string;
  accountId: string;
  skillId: string;
  executionId?: string;
  executor?: string;
  projectId?: string;
}): Promise<{ executionId: string; events: SkillTelemetryEvent[] }> {
  const executionId = normalizeOptional(input.executionId) ?? randomUUID();
  const existing = await readSkillTelemetry(input.stateRoot, input.accountId);
  const executionEvents = existing.filter((event) => event.execution_id === executionId);
  if (executionEvents.some((event) => event.skill_id !== input.skillId)) {
    throw new Error("skill execution id already belongs to another skill");
  }
  const appended: SkillTelemetryEvent[] = [];
  if (!executionEvents.some((event) => event.stage === "selected")) {
    appended.push(await appendSkillEvent({ ...input, executionId, stage: "selected" }));
  }
  if (!executionEvents.some((event) => event.stage === "loaded")) {
    appended.push(await appendSkillEvent({ ...input, executionId, stage: "loaded" }));
  }
  return { executionId, events: appended };
}

export async function recordSkillExecutionEvent(input: {
  stateRoot: string;
  accountId: string;
  skillId: string;
  executionId: string;
  stage: Exclude<SkillExecutionStage, "selected" | "loaded">;
  executor?: string;
  projectId?: string;
  note?: string;
}): Promise<SkillTelemetryEvent> {
  const executionId = requireNonEmpty(input.executionId, "executionId");
  const events = await readSkillTelemetry(input.stateRoot, input.accountId);
  const execution = events.filter((event) => event.execution_id === executionId);
  if (execution.length === 0) throw new Error("skill execution has not been loaded");
  if (execution.some((event) => event.skill_id !== input.skillId)) throw new Error("skill execution id belongs to another skill");
  const stages = new Set(execution.map((event) => event.stage));
  if (!stages.has("loaded")) throw new Error("skill execution must be loaded before recording execution outcome");
  if (input.stage === "invoked") {
    if (stages.has("success") || stages.has("failure")) throw new Error("skill execution is already terminal");
  } else if (input.stage === "success" || input.stage === "failure") {
    if (!stages.has("invoked")) throw new Error("skill execution must be invoked before terminal outcome");
    if (stages.has("success") || stages.has("failure")) throw new Error("skill execution already has a terminal outcome");
  } else if (!stages.has("invoked")) {
    throw new Error("user correction requires an invoked skill execution");
  }
  return appendSkillEvent(input);
}

export async function skillTelemetrySummary(
  stateRoot: string,
  accountId: string,
  skillId: string
): Promise<SkillTelemetrySummary> {
  const events = (await readSkillTelemetry(stateRoot, accountId)).filter((event) => event.skill_id === skillId);
  const executionIds = new Set(events.map((event) => event.execution_id));
  const successes = events.filter((event) => event.stage === "success").length;
  const failures = events.filter((event) => event.stage === "failure").length;
  const userCorrections = events.filter((event) => event.stage === "user_correction").length;
  const weightedFailures = failures + userCorrections * 0.5;
  const reliability = (successes + 1) / (successes + weightedFailures + 2);
  const last = events.at(-1);
  return {
    skill_id: skillId,
    executions: executionIds.size,
    invoked: events.filter((event) => event.stage === "invoked").length,
    successes,
    failures,
    user_corrections: userCorrections,
    reliability: round(reliability),
    last_stage: last?.stage ?? null,
    last_timestamp: last?.timestamp ?? null
  };
}

export async function readSkillExecution(
  stateRoot: string,
  accountId: string,
  executionId: string
): Promise<SkillTelemetryEvent[]> {
  return (await readSkillTelemetry(stateRoot, accountId))
    .filter((event) => event.execution_id === executionId);
}

async function appendSkillEvent(input: {
  stateRoot: string;
  accountId: string;
  skillId: string;
  executionId: string;
  stage: SkillExecutionStage;
  executor?: string;
  projectId?: string;
  note?: string;
}): Promise<SkillTelemetryEvent> {
  const event: SkillTelemetryEvent = {
    event_id: randomUUID(),
    execution_id: requireNonEmpty(input.executionId, "executionId"),
    skill_id: requireNonEmpty(input.skillId, "skillId"),
    stage: input.stage,
    timestamp: new Date().toISOString(),
    ...(normalizeOptional(input.executor) ? { executor: normalizeOptional(input.executor) } : {}),
    ...(normalizeOptional(input.projectId) ? { project_id: normalizeOptional(input.projectId) } : {}),
    ...(normalizeOptional(input.note) ? { note: clip(normalizeOptional(input.note)!, 2_000) } : {})
  };
  const path = telemetryPath(input.stateRoot, input.accountId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}

async function readSkillTelemetry(stateRoot: string, accountId: string): Promise<SkillTelemetryEvent[]> {
  const path = telemetryPath(stateRoot, accountId);
  try {
    const info = await stat(path);
    if (info.size > 8 * 1024 * 1024) throw new Error("skill telemetry file exceeds 8 MiB safety bound");
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SkillTelemetryEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function telemetryPath(stateRoot: string, accountId: string): string {
  const accountHash = createHash("sha256").update(requireNonEmpty(accountId, "accountId"), "utf8").digest("hex").slice(0, 24);
  return join(resolve(stateRoot), "skills", "telemetry", `${accountHash}.jsonl`);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
