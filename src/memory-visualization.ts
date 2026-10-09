export type ProjectStateStage = "active" | "completed" | "pending" | "blocked" | "rollback" | "superseded";

export interface ProjectStateEvent {
  id: string;
  memory_id: string;
  date: string;
  date_label: string;
  title: string;
  summary: string;
  order: number;
  workstream_id: string;
  workstream_label: string;
  workstream_basis: "explicit" | "inferred" | "main";
  stage: ProjectStateStage;
  version: string | null;
  current_head: boolean;
  workstream_head: boolean;
  revision_count: number;
  first_revision_ref: string | null;
  latest_revision_ref: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ProjectStateWorkstream {
  id: string;
  label: string;
  basis: "explicit" | "inferred" | "main";
  event_count: number;
  current_event_id: string | null;
  versions: string[];
}

export interface ProjectStateRevision {
  ref: string;
  memory_id: string;
  committed_at: string;
  current: boolean;
  event_ids: string[];
  evidence_refs: string[];
}

export interface ProjectStateTodo {
  id: string;
  text: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MemoryVisualizationPayload {
  schema_version: 2;
  visualization_contract: "memhub-project-state-ir-v1";
  source_of_truth: "canonical-l2";
  revision_source: "exact-l2-revision-ledger";
  projection_only: true;
  project_id: string | null;
  requires_project: boolean;
  state: {
    current_head_event_id: string | null;
    latest_l2_revision_at: string | null;
    current_l2_memory_ids: string[];
    workstreams: ProjectStateWorkstream[];
    events: ProjectStateEvent[];
  };
  drilldown: {
    revisions: ProjectStateRevision[];
    todos: ProjectStateTodo[];
  };
  stats: {
    events: number;
    workstreams: number;
    l2_revisions: number;
    versions: number;
    pending_todos: number;
  };
  archify: {
    role: "optional_export_and_design_reference";
    exportable: boolean;
    compatible_diagram_types: ["lifecycle"];
    invariant: string;
    lifecycle_ir: {
      schema_version: 2;
      diagram_type: "lifecycle";
      meta: { title: string; subtitle: string; output: string };
      lanes: Array<{ id: string; label: string }>;
      states: Array<{ id: string; type: "active" | "success" | "waiting" | "failure" | "neutral"; label: string; sublabel: string; lane: string; col: number; width: number }>;
      transitions: Array<{ from: string; to: string }>;
      cards: [];
    };
  };
}

interface L2RevisionInput {
  ref: string;
  layer: "L2";
  memory_id: string;
  project_id: string | null;
  committed_at: string;
  content: string;
  evidence_refs: string[];
}

interface EventDraft {
  id: string;
  memory_id: string;
  date: string;
  date_label: string;
  title: string;
  summary: string;
  stage: ProjectStateStage;
  version: string | null;
  source_revision_refs: string[];
  evidence_refs: string[];
  first_seen_at: string;
  last_seen_at: string;
  explicit_workstream: string | null;
  workstream_id: string;
  workstream_label: string;
  workstream_basis: "explicit" | "inferred" | "main";
  order: number;
  current_head: boolean;
  workstream_head: boolean;
}

interface TimelineSection {
  date: string;
  dateLabel: string;
  title: string;
  summary: string;
}

export function buildMemoryVisualization(input: {
  projectId?: string;
  l2: Record<string, unknown>[];
  revisions?: L2RevisionInput[];
  todos?: Array<{
    id: string;
    text: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
  }>;
}): MemoryVisualizationPayload {
  const projectId = stringValue(input.projectId) ?? null;
  if (!projectId) return emptyProjectStatePayload();

  const revisions = [...(input.revisions ?? [])]
    .filter((revision) => revision.layer === "L2")
    .sort((a, b) => a.committed_at.localeCompare(b.committed_at) || a.ref.localeCompare(b.ref));
  const latestRevisionByMemory = new Map<string, L2RevisionInput>();
  for (const revision of revisions) latestRevisionByMemory.set(revision.memory_id, revision);

  const drafts = new Map<string, EventDraft>();
  const revisionEventIds = new Map<string, string[]>();
  const currentCoreHeads: Array<{ id: string; updatedAt: string }> = [];
  const currentL2MemoryIds = new Set<string>();

  const upsertEvent = (
    memoryId: string,
    section: TimelineSection,
    source: { revisionRef?: string; seenAt: string; evidenceRefs: string[] }
  ): string => {
    const title = section.title || section.dateLabel || "Timeline event";
    const summary = section.summary;
    const dateKey = normalizeEventKey(section.dateLabel || section.date);
    const existing = [...drafts.values()].find((candidate) =>
      candidate.memory_id === memoryId &&
      normalizeEventKey(candidate.date_label || candidate.date) === dateKey &&
      sameTimelineEvent(candidate.title, title, section.dateLabel || section.date)
    );
    const signature = `${memoryId}|${dateKey}|${normalizeEventKey(title)}`;
    const id = existing?.id ?? `event:${portableId(memoryId)}:${stableHash(signature)}`;
    if (!existing) {
      drafts.set(id, {
        id,
        memory_id: memoryId,
        date: section.date,
        date_label: section.dateLabel || section.date,
        title,
        summary,
        stage: inferStage(title),
        version: extractVersion(title),
        source_revision_refs: source.revisionRef ? [source.revisionRef] : [],
        evidence_refs: uniqueStrings(source.evidenceRefs),
        first_seen_at: source.seenAt,
        last_seen_at: source.seenAt,
        explicit_workstream: explicitWorkstream(title),
        workstream_id: "main",
        workstream_label: "Mainline",
        workstream_basis: "main",
        order: 0,
        current_head: false,
        workstream_head: false
      });
      return id;
    }
    if (source.seenAt >= existing.last_seen_at) {
      existing.date = section.date || existing.date;
      existing.date_label = section.dateLabel || existing.date_label;
      existing.title = title || existing.title;
      existing.summary = summary || existing.summary;
      existing.stage = inferStage(existing.title);
      existing.version = extractVersion(existing.title) ?? existing.version;
      existing.explicit_workstream = explicitWorkstream(existing.title) ?? existing.explicit_workstream;
      existing.last_seen_at = source.seenAt;
    }
    if (source.seenAt < existing.first_seen_at) existing.first_seen_at = source.seenAt;
    if (source.revisionRef && !existing.source_revision_refs.includes(source.revisionRef)) existing.source_revision_refs.push(source.revisionRef);
    existing.evidence_refs = uniqueStrings([...existing.evidence_refs, ...source.evidenceRefs]);
    return id;
  };

  for (const revision of revisions) {
    const eventIds = timelineSections(revision.content).map((section) => upsertEvent(revision.memory_id, section, {
      revisionRef: revision.ref,
      seenAt: revision.committed_at,
      evidenceRefs: revision.evidence_refs
    }));
    revisionEventIds.set(revision.ref, eventIds);
  }

  for (const item of input.l2) {
    const memoryId = itemIdentifier(item);
    if (!memoryId) continue;
    currentL2MemoryIds.add(memoryId);
    const body = stringValue(item.body) ?? stringValue(item.content) ?? "";
    const sections = timelineSections(body);
    const seenAt = timestampFromItem(item) ?? latestRevisionByMemory.get(memoryId)?.committed_at ?? "";
    const latestRevision = latestRevisionByMemory.get(memoryId);
    const eventIds = sections.map((section) => upsertEvent(memoryId, section, {
      revisionRef: latestRevision?.ref,
      seenAt,
      evidenceRefs: uniqueStrings([...(latestRevision?.evidence_refs ?? []), ...evidenceRefs(item)])
    }));
    const head = eventIds.at(-1);
    if (head) currentCoreHeads.push({ id: head, updatedAt: seenAt });
  }

  const orderedDrafts = [...drafts.values()].sort(compareEvents);
  assignWorkstreams(orderedDrafts);
  orderedDrafts.forEach((event, index) => { event.order = index + 1; });

  let currentHeadEventId = currentCoreHeads
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
    .at(-1)?.id ?? null;
  if (!currentHeadEventId) {
    const latestRevision = revisions.at(-1);
    currentHeadEventId = latestRevision ? revisionEventIds.get(latestRevision.ref)?.at(-1) ?? null : null;
  }
  if (currentHeadEventId) drafts.get(currentHeadEventId)!.current_head = true;
  const latestL2RevisionAt = [
    revisions.at(-1)?.committed_at ?? "",
    ...currentCoreHeads.map((item) => item.updatedAt)
  ].filter(Boolean).sort().at(-1) ?? null;

  const workstreamGroups = new Map<string, EventDraft[]>();
  for (const event of orderedDrafts) {
    const group = workstreamGroups.get(event.workstream_id) ?? [];
    group.push(event);
    workstreamGroups.set(event.workstream_id, group);
  }
  for (const group of workstreamGroups.values()) {
    const head = [...group].sort((a, b) => a.order - b.order).at(-1);
    if (head) head.workstream_head = true;
  }

  const workstreams: ProjectStateWorkstream[] = [...workstreamGroups.entries()]
    .map(([id, events]) => ({
      id,
      label: events[0]!.workstream_label,
      basis: events[0]!.workstream_basis,
      event_count: events.length,
      current_event_id: [...events].sort((a, b) => a.order - b.order).at(-1)?.id ?? null,
      versions: uniqueStrings(events.map((event) => event.version).filter((value): value is string => Boolean(value)))
    }))
    .sort((a, b) => {
      const aOrder = workstreamGroups.get(a.id)?.[0]?.order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = workstreamGroups.get(b.id)?.[0]?.order ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.label.localeCompare(b.label);
    });

  const latestRefByMemory = new Map<string, string>();
  for (const revision of revisions) latestRefByMemory.set(revision.memory_id, revision.ref);
  const revisionRows: ProjectStateRevision[] = revisions.map((revision) => ({
    ref: revision.ref,
    memory_id: revision.memory_id,
    committed_at: revision.committed_at,
    current: latestRefByMemory.get(revision.memory_id) === revision.ref,
    event_ids: revisionEventIds.get(revision.ref) ?? [],
    evidence_refs: revision.evidence_refs.slice()
  }));
  const events: ProjectStateEvent[] = orderedDrafts.map((event) => ({
    id: event.id,
    memory_id: event.memory_id,
    date: event.date,
    date_label: event.date_label,
    title: event.title,
    summary: event.summary,
    order: event.order,
    workstream_id: event.workstream_id,
    workstream_label: event.workstream_label,
    workstream_basis: event.workstream_basis,
    stage: event.stage,
    version: event.version,
    current_head: event.current_head,
    workstream_head: event.workstream_head,
    revision_count: event.source_revision_refs.length,
    first_revision_ref: event.source_revision_refs[0] ?? null,
    latest_revision_ref: event.source_revision_refs.at(-1) ?? null,
    first_seen_at: event.first_seen_at,
    last_seen_at: event.last_seen_at
  }));
  const todos: ProjectStateTodo[] = (input.todos ?? []).filter((todo) => todo.status !== "done").map((todo) => ({
    id: todo.id,
    text: todo.text,
    status: todo.status,
    created_at: todo.createdAt ?? "",
    updated_at: todo.updatedAt ?? todo.createdAt ?? "",
    completed_at: todo.completedAt ?? null
  }));

  const currentHead = events.find((event) => event.current_head) ?? null;
  const mainArchifyWorkstreamId = currentHead?.workstream_id ?? workstreams[0]?.id ?? "main";
  const latestEventOrderByWorkstream = new Map(workstreams.map((workstream) => [
    workstream.id,
    Math.max(...events.filter((event) => event.workstream_id === workstream.id).map((event) => event.order))
  ]));
  const orderedArchifyWorkstreams = [
    ...workstreams.filter((workstream) => workstream.id === mainArchifyWorkstreamId),
    ...workstreams
      .filter((workstream) => workstream.id !== mainArchifyWorkstreamId)
      .sort((a, b) => (latestEventOrderByWorkstream.get(b.id) ?? 0) - (latestEventOrderByWorkstream.get(a.id) ?? 0) || a.label.localeCompare(b.label))
  ].slice(0, 4);
  const archifyLaneId = new Map(orderedArchifyWorkstreams.map((workstream, index) => [
    workstream.id,
    index === 0 ? "main" : `lane_${index + 1}`
  ]));
  const archifyEvents = orderedArchifyWorkstreams.flatMap((workstream) => {
    const laneEvents = events.filter((event) => event.workstream_id === workstream.id).sort((a, b) => a.order - b.order);
    if (laneEvents.length <= 5) return laneEvents;
    return [laneEvents[0]!, ...laneEvents.slice(-4)];
  });
  const archifyStateId = new Map(archifyEvents.map((event, index) => [event.id, `state_${index + 1}`]));
  const archifyStates = archifyEvents.map((event) => {
    const workstreamEvents = archifyEvents.filter((item) => item.workstream_id === event.workstream_id);
    const col = workstreamEvents.findIndex((item) => item.id === event.id);
    return {
      id: archifyStateId.get(event.id)!,
      type: event.current_head || event.stage === "active" ? "active" as const :
        event.stage === "completed" ? "success" as const :
        event.stage === "pending" ? "waiting" as const :
        event.stage === "blocked" || event.stage === "rollback" ? "failure" as const : "neutral" as const,
      label: truncateLifecycleText(event.title, 30),
      sublabel: truncateLifecycleText([event.date_label, event.version, event.stage, event.current_head ? "current L2 head" : ""].filter(Boolean).join(" · "), 38),
      lane: archifyLaneId.get(event.workstream_id) ?? "main",
      col,
      width: 220
    };
  });
  const archifyTransitions = orderedArchifyWorkstreams.flatMap((workstream) => {
    const laneEvents = archifyEvents.filter((event) => event.workstream_id === workstream.id).sort((a, b) => a.order - b.order);
    return laneEvents.slice(1).flatMap((event, index) => {
      const from = archifyStateId.get(laneEvents[index]!.id);
      const to = archifyStateId.get(event.id);
      return from && to ? [{ from, to }] : [];
    });
  });

  return {
    schema_version: 2,
    visualization_contract: "memhub-project-state-ir-v1",
    source_of_truth: "canonical-l2",
    revision_source: "exact-l2-revision-ledger",
    projection_only: true,
    project_id: projectId,
    requires_project: false,
    state: {
      current_head_event_id: currentHeadEventId,
      latest_l2_revision_at: latestL2RevisionAt,
      current_l2_memory_ids: [...currentL2MemoryIds],
      workstreams,
      events
    },
    drilldown: { revisions: revisionRows, todos },
    stats: {
      events: events.length,
      workstreams: workstreams.length,
      l2_revisions: revisionRows.length,
      versions: uniqueStrings(events.map((event) => event.version).filter((value): value is string => Boolean(value))).length,
      pending_todos: todos.length
    },
    archify: {
      role: "optional_export_and_design_reference",
      exportable: archifyStates.length >= 2,
      compatible_diagram_types: ["lifecycle"],
      invariant: "Project State is a disposable projection of canonical project L2 plus its exact L2 revision ledger; the console retains the complete timeline while Archify exports at most five representative states per workstream and never becomes a second project-state source of truth.",
      lifecycle_ir: {
        schema_version: 2,
        diagram_type: "lifecycle",
        meta: {
          title: `Memhub Project State · ${projectId}`,
          subtitle: `Representative lifecycle · ${orderedArchifyWorkstreams.length} of ${workstreams.length} workstreams · up to 5 states per lane`,
          output: `memhub-project-state-${portableId(projectId)}.html`
        },
        lanes: orderedArchifyWorkstreams.map((workstream) => ({ id: archifyLaneId.get(workstream.id)!, label: workstream.label })),
        states: archifyStates,
        transitions: archifyTransitions,
        cards: []
      }
    }
  };
}

function emptyProjectStatePayload(): MemoryVisualizationPayload {
  return {
    schema_version: 2,
    visualization_contract: "memhub-project-state-ir-v1",
    source_of_truth: "canonical-l2",
    revision_source: "exact-l2-revision-ledger",
    projection_only: true,
    project_id: null,
    requires_project: true,
    state: { current_head_event_id: null, latest_l2_revision_at: null, current_l2_memory_ids: [], workstreams: [], events: [] },
    drilldown: { revisions: [], todos: [] },
    stats: { events: 0, workstreams: 0, l2_revisions: 0, versions: 0, pending_todos: 0 },
    archify: {
      role: "optional_export_and_design_reference",
      exportable: false,
      compatible_diagram_types: ["lifecycle"],
      invariant: "Project State is generated only after selecting one canonical project; account-wide memory graphs are intentionally not produced.",
      lifecycle_ir: {
        schema_version: 2,
        diagram_type: "lifecycle",
        meta: { title: "Memhub Project State", subtitle: "Select one project", output: "memhub-project-state.html" },
        lanes: [],
        states: [],
        transitions: [],
        cards: []
      }
    }
  };
}

function assignWorkstreams(events: EventDraft[]): void {
  if (!events.length) return;
  // Project workstreams must come from the durable L2 event label, not from
  // implementation details mentioned inside the explanatory paragraph.
  const tokensByEvent = new Map(events.map((event) => [event.id, topicTokens(event.title)]));
  const frequency = new Map<string, number>();
  for (const tokens of tokensByEvent.values()) {
    for (const token of new Set(tokens)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  for (const event of events) {
    if (event.explicit_workstream) {
      event.workstream_id = `stream-${portableId(event.explicit_workstream)}`;
      event.workstream_label = event.explicit_workstream;
      event.workstream_basis = "explicit";
      continue;
    }
    const candidates = (tokensByEvent.get(event.id) ?? [])
      .filter((token) => (frequency.get(token) ?? 0) >= 2 && (frequency.get(token) ?? 0) < events.length)
      .sort((a, b) => topicScore(b, frequency.get(b) ?? 1, events.length) - topicScore(a, frequency.get(a) ?? 1, events.length) || a.localeCompare(b));
    const anchor = candidates[0];
    if (!anchor) continue;
    event.workstream_id = `stream-${portableId(anchor)}`;
    event.workstream_label = displayTopic(anchor);
    event.workstream_basis = "inferred";
  }
  const inferredCounts = new Map<string, number>();
  for (const event of events) {
    if (event.workstream_basis !== "inferred") continue;
    inferredCounts.set(event.workstream_id, (inferredCounts.get(event.workstream_id) ?? 0) + 1);
  }
  for (const event of events) {
    if (event.workstream_basis === "inferred" && (inferredCounts.get(event.workstream_id) ?? 0) < 2) {
      event.workstream_id = "main";
      event.workstream_label = "Mainline";
      event.workstream_basis = "main";
    }
  }
}

function topicScore(token: string, frequency: number, total: number): number {
  return Math.log((total + 1) / (frequency + 0.5)) + Math.min(token.length, 10) / 20;
}

const ENGLISH_TOPIC_STOP = new Set([
  "the", "and", "for", "with", "from", "into", "after", "before", "current", "project", "state", "status",
  "update", "updated", "fix", "fixed", "repair", "review", "check", "final", "followup", "candidate", "acceptance",
  "complete", "completed", "test", "testing", "real", "local", "production", "phase", "next", "todo"
]);
const CJK_TOPIC_STOP = [
  "项目", "当前", "状态", "更新", "修复", "收口", "验收", "发布", "正式", "生产", "候选", "完成", "测试", "检查",
  "跟进", "继续", "阶段", "边界", "安全", "实现", "真实", "本地", "进一步", "最终", "以及", "并且", "与", "和", "的"
];

function topicTokens(value: string): string[] {
  const normalized = value.toLowerCase().replace(/v\d+(?:\.\d+){0,3}/gi, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const english = (normalized.match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((token) => !ENGLISH_TOPIC_STOP.has(token));
  let cjkSource = normalized;
  for (const stop of CJK_TOPIC_STOP) cjkSource = cjkSource.split(stop).join(" ");
  const cjk = (cjkSource.match(/[\p{Script=Han}]{2,12}/gu) ?? []).filter((chunk) => chunk.length >= 2);
  return uniqueStrings([...english, ...cjk]);
}

function displayTopic(value: string): string {
  if (/^[a-z0-9_-]+$/.test(value)) return value.split(/[-_]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  return value;
}

function explicitWorkstream(title: string): string | null {
  const labels = [...title.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]!.trim()).filter(Boolean);
  const candidate = labels.reverse().find((label) => !/^(?:p[0-3]|sub|todo|done)$/i.test(label) && !/^parent[:=]/i.test(label));
  return candidate ?? null;
}

function inferStage(value: string): ProjectStateStage {
  if (/回滚|rollback/i.test(value)) return "rollback";
  if (/替代|取代|退役|supersed|retir/i.test(value)) return "superseded";
  if (/阻塞|失败|未通过|blocked|\bfail(?:ed|ure)?\b|\berror\b/i.test(value)) return "blocked";
  if (/尚未|未完成|待授权|待处理|下一步|\bpending\b|\btodo\b/i.test(value)) return "pending";
  if (/完成|通过|收口|上线|已发布|已切入|\bpass(?:ed)?\b|\bshipped\b|\bdeployed\b|\bcomplete(?:d)?\b/i.test(value)) return "completed";
  return "active";
}

function extractVersion(value: string): string | null {
  return value.match(/\b(?:v\d+(?:\.\d+){0,3}|\d+\.\d+(?:\.\d+){0,2}|rc\d*)\b/i)?.[0] ?? null;
}

function timelineSections(body: string): TimelineSection[] {
  const lines = body.split(/\r?\n/);
  const out: TimelineSection[] = [];
  let current: { date: string; dateLabel: string; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const summary = current.lines.map((line) => line.trim()).filter(Boolean).join(" ").slice(0, 520);
    out.push({ date: current.date, dateLabel: current.dateLabel, title: current.title, summary });
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (!heading) {
      if (current) current.lines.push(raw);
      continue;
    }
    flush();
    const text = heading[1]!.trim();
    const firstDate = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? "";
    const colonIndex = Math.max(text.indexOf("："), text.indexOf(":"));
    if (firstDate && colonIndex > 0) {
      current = { date: firstDate, dateLabel: text.slice(0, colonIndex).trim(), title: text.slice(colonIndex + 1).trim(), lines: [] };
      continue;
    }
    const dated = /^(\d{4}-\d{2}-\d{2})(?:[\s—-]+)?(.*)$/.exec(text);
    current = { date: dated?.[1] ?? "", dateLabel: dated?.[1] ?? "", title: (dated?.[2] ?? text).trim(), lines: [] };
  }
  flush();
  return out;
}

function compareEvents(a: EventDraft, b: EventDraft): number {
  const aDate = a.date || "9999-99-99";
  const bDate = b.date || "9999-99-99";
  return aDate.localeCompare(bDate) || a.first_seen_at.localeCompare(b.first_seen_at) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function sameTimelineEvent(existingTitle: string, nextTitle: string, dateLabel: string): boolean {
  const left = normalizeEventKey(existingTitle);
  const right = normalizeEventKey(nextTitle);
  if (left === right) return true;
  // A precise L2 timestamp/range is already a strong event identity. Distillation
  // revisions may refine its wording without creating a new historical event.
  if (/\b\d{1,2}:\d{2}\b/.test(dateLabel)) return true;
  const a = titleTerms(existingTitle);
  const b = titleTerms(nextTitle);
  if (!a.length || !b.length) return false;
  const small = a.length <= b.length ? a : b;
  const large = new Set(a.length <= b.length ? b : a);
  const shared = small.filter((term) => large.has(term)).length;
  return shared / small.length >= 0.4;
}

function titleTerms(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[\s：:、，,。.!！?？()（）[\]{}]+/g, " ");
  const english = normalized.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? [];
  const cjk: string[] = [];
  for (const chunk of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (chunk.length <= 3) cjk.push(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) cjk.push(chunk.slice(index, index + 2));
  }
  return uniqueStrings([...english, ...cjk]);
}

function normalizeEventKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[：:]+/g, ":").trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function itemIdentifier(item: Record<string, unknown>): string | undefined {
  return stringValue(item.id) ?? stringValue(item.memoryId);
}
function timestampFromItem(item: Record<string, unknown>): string | null {
  return stringValue(item.updatedAt) ?? stringValue(item.updated_at) ?? stringValue(item.createdAt) ?? stringValue(item.created_at) ?? null;
}
function evidenceRefs(item: Record<string, unknown>): string[] {
  return tags(item).filter((value) => value.startsWith("evidence:")).map((value) => value.slice(9));
}
function tags(item: Record<string, unknown>): string[] {
  return Array.isArray(item.tags) ? item.tags.filter((value): value is string => typeof value === "string") : [];
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function portableId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9\p{Script=Han}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return id || "item";
}

function truncateLifecycleText(value: string, maxUnits: number): string {
  let units = 0;
  let out = "";
  for (const char of value) {
    const next = /[\p{Script=Han}\u3000-\u30ff\uff00-\uffef]/u.test(char) ? 2 : 1;
    if (units + next > maxUnits - 1) return `${out}…`;
    out += char;
    units += next;
  }
  return out;
}
