import type { ProjectScopeResolution } from "./project-scope.js";
import type { ContextRecallDiagnostics } from "./memory-source.js";

export type ContextAuthority = "remembered" | "authoritative" | "observed";
export type ContextScope = "global" | "project" | "conversation" | "capability";

export interface ContextItem {
  id: string;
  content: string;
  authority: ContextAuthority;
  scope: ContextScope;
  source: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  provenance?: Record<string, unknown>;
}

export interface ContextCapsuleInput {
  accountId: string;
  conversationId?: string;
  resolution: ProjectScopeResolution;
  globalMemory?: readonly ContextItem[];
  projectMemory?: readonly ContextItem[];
  reusableSkills?: readonly ContextItem[];
  projectArchitecture?: readonly ContextItem[];
  recentSession?: readonly ContextItem[];
  retrievalDiagnostics?: ContextRecallDiagnostics;
  branchContext?: {
    branchId: string;
    name: string;
    goal: string;
    source: "explicit" | "conversation_binding";
  } | null;
  maxContentBytes?: number;
  maxItemContentBytes?: number;
}

export interface ContextCapsule {
  accountId: string;
  conversationId: string | null;
  resolvedProjectId: string | null;
  resolutionSource: ProjectScopeResolution["source"];
  recallScope: ProjectScopeResolution["recallScope"];
  globalMemory: ContextItem[];
  projectMemory: ContextItem[];
  reusableSkills: ContextItem[];
  projectArchitecture: ContextItem[];
  recentSession: ContextItem[];
  ambiguities: string[];
  contextBudget: {
    maxContentBytes: number;
    maxItemContentBytes: number;
    emittedContentBytes: number;
    truncatedItems: number;
    droppedItems: number;
  };
  retrievalDiagnostics?: ContextRecallDiagnostics;
  branchContext: {
    branchId: string;
    name: string;
    goal: string;
    source: "explicit" | "conversation_binding";
  } | null;
}

export const DEFAULT_CONTEXT_CONTENT_BYTES = 96_000;
export const DEFAULT_CONTEXT_ITEM_BYTES = 24_000;

/**
 * Build the host-facing context envelope after project resolution.
 *
 * This is deliberately defensive: callers may pass broader candidate data,
 * but project-scoped items are only emitted for the one resolved project.
 * Ambiguous/no-project requests therefore cannot accidentally leak context
 * from another project into the model prompt.
 */
export function buildContextCapsule(input: ContextCapsuleInput): ContextCapsule {
  const accountId = requireNonEmpty(input.accountId, "accountId");
  const resolvedProjectId = input.resolution.projectId;

  const globalMemory = filterItems(input.globalMemory, (item) => item.scope === "global");
  const recentSession = filterItems(input.recentSession, (item) => item.scope === "conversation");
  const reusableSkills = filterItems(input.reusableSkills, (item) =>
    item.scope === "capability" && item.authority === "remembered");

  const allowProject = input.resolution.recallScope === "global_and_project" && resolvedProjectId !== null;
  const projectMemory = allowProject
    ? filterItems(input.projectMemory, (item) =>
        item.scope === "project" && item.projectId === resolvedProjectId && item.authority === "remembered")
    : [];
  const projectArchitecture = allowProject
    ? filterItems(input.projectArchitecture, (item) =>
        item.scope === "project" && item.projectId === resolvedProjectId && item.authority === "authoritative")
    : [];

  const budgeted = applyContextBudget({
    globalMemory,
    projectMemory,
    reusableSkills,
    projectArchitecture,
    recentSession
  }, {
    maxContentBytes: normalizeBudget(input.maxContentBytes, DEFAULT_CONTEXT_CONTENT_BYTES, 16_000, 512_000),
    maxItemContentBytes: normalizeBudget(input.maxItemContentBytes, DEFAULT_CONTEXT_ITEM_BYTES, 4_000, 128_000)
  });

  return {
    accountId,
    conversationId: normalizeOptional(input.conversationId) ?? null,
    resolvedProjectId,
    resolutionSource: input.resolution.source,
    recallScope: input.resolution.recallScope,
    globalMemory: budgeted.items.globalMemory,
    projectMemory: budgeted.items.projectMemory,
    reusableSkills: budgeted.items.reusableSkills,
    projectArchitecture: budgeted.items.projectArchitecture,
    recentSession: budgeted.items.recentSession,
    ambiguities: input.resolution.source === "ambiguous"
      ? [...input.resolution.candidates]
      : [],
    branchContext: input.branchContext ?? null,
    contextBudget: budgeted.budget,
    ...(input.retrievalDiagnostics ? { retrievalDiagnostics: input.retrievalDiagnostics } : {})
  };
}

type ContextCollections = Pick<ContextCapsule,
  "globalMemory" | "projectMemory" | "reusableSkills" | "projectArchitecture" | "recentSession">;

function applyContextBudget(
  input: ContextCollections,
  options: { maxContentBytes: number; maxItemContentBytes: number }
): { items: ContextCollections; budget: ContextCapsule["contextBudget"] } {
  const keys = ["globalMemory", "projectMemory", "reusableSkills", "projectArchitecture", "recentSession"] as const;
  const output: ContextCollections = {
    globalMemory: [],
    projectMemory: [],
    reusableSkills: [],
    projectArchitecture: [],
    recentSession: []
  };
  const cursor = new Map<(typeof keys)[number], number>(keys.map((key) => [key, 0]));
  let remaining = options.maxContentBytes;
  let emittedContentBytes = 0;
  let truncatedItems = 0;
  let droppedItems = 0;

  while (remaining > 0 && keys.some((key) => (cursor.get(key) ?? 0) < input[key].length)) {
    let progressed = false;
    for (const key of keys) {
      const index = cursor.get(key) ?? 0;
      if (index >= input[key].length) continue;
      cursor.set(key, index + 1);
      progressed = true;
      const item = input[key][index]!;
      const allowance = Math.min(options.maxItemContentBytes, remaining);
      if (allowance < 256) {
        droppedItems += input[key].length - index;
        cursor.set(key, input[key].length);
        continue;
      }
      const bounded = boundContextItem(item, allowance);
      output[key].push(bounded.item);
      emittedContentBytes += bounded.emittedBytes;
      remaining -= bounded.emittedBytes;
      if (bounded.truncated) truncatedItems += 1;
      if (remaining <= 0) break;
    }
    if (!progressed) break;
  }

  for (const key of keys) {
    const index = cursor.get(key) ?? 0;
    if (index < input[key].length) droppedItems += input[key].length - index;
  }

  return {
    items: output,
    budget: {
      maxContentBytes: options.maxContentBytes,
      maxItemContentBytes: options.maxItemContentBytes,
      emittedContentBytes,
      truncatedItems,
      droppedItems
    }
  };
}

function boundContextItem(item: ContextItem, maxBytes: number): { item: ContextItem; emittedBytes: number; truncated: boolean } {
  const originalBytes = Buffer.byteLength(item.content, "utf8");
  if (originalBytes <= maxBytes) return { item: { ...item }, emittedBytes: originalBytes, truncated: false };
  const content = truncateUtf8HeadTail(item.content, maxBytes);
  const emittedBytes = Buffer.byteLength(content, "utf8");
  return {
    item: {
      ...item,
      content,
      provenance: {
        ...(item.provenance ?? {}),
        contextTruncated: true,
        originalContentBytes: originalBytes,
        emittedContentBytes: emittedBytes
      }
    },
    emittedBytes,
    truncated: true
  };
}

function truncateUtf8HeadTail(value: string, maxBytes: number): string {
  const marker = "\n… [truncated by Memhub context budget] …\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes + 2) return utf8Prefix(value, maxBytes);
  const payloadBytes = maxBytes - markerBytes;
  const headBytes = Math.floor(payloadBytes * 0.7);
  const tailBytes = payloadBytes - headBytes;
  return utf8Prefix(value, headBytes) + marker + utf8Suffix(value, tailBytes);
}

function utf8Prefix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

function utf8Suffix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(value.length - length), "utf8") <= maxBytes) low = length;
    else high = length - 1;
  }
  let start = value.length - low;
  if (start < value.length && isLowSurrogate(value.charCodeAt(start))) start += 1;
  return value.slice(start);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}

function normalizeBudget(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function filterItems(
  items: readonly ContextItem[] | undefined,
  predicate: (item: ContextItem) => boolean
): ContextItem[] {
  return (items ?? [])
    .filter(isValidContextItem)
    .filter(predicate)
    .map((item) => ({ ...item }));
}

function isValidContextItem(item: ContextItem): boolean {
  return Boolean(item.id.trim()) && Boolean(item.content.trim()) && Boolean(item.source.trim());
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
