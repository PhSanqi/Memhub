import type { ProjectScopeResolution } from "./project-scope.js";
import type { ContextRecallDiagnostics } from "./memory-source.js";
import {
  extractMarkdownHeadings,
  selectPassages,
  turnQueryTerms,
  type TurnKnowledgePassage
} from "./turn-knowledge-plan.js";

export type ContextAuthority = "remembered" | "authoritative" | "observed" | "evidence";
export type ContextScope = "global" | "project" | "capability";

export interface ContextItem {
  id: string;
  /**
   * Exact immutable provenance reference for this recalled durable Memory
   * revision when Memhub can prove one. Callers should pass this value back
   * unchanged as a downstream distillation evidence_ref instead of rebuilding
   * a reference from the stable Memory id.
   */
  evidenceRef?: string;
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
  continuityId?: string;
  resolution: ProjectScopeResolution;
  globalMemory?: readonly ContextItem[];
  projectMemory?: readonly ContextItem[];
  reusableSkills?: readonly ContextItem[];
  projectArchitecture?: readonly ContextItem[];
  retrievalDiagnostics?: ContextRecallDiagnostics;
  branchContext?: {
    branchId: string;
    name: string;
    goal: string;
    source: "explicit";
  } | null;
  maxContentBytes?: number;
  maxItemContentBytes?: number;
  detail?: "brief" | "full";
  queryTerms?: readonly string[];
  query?: string;
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
    source: "explicit";
  } | null;
}

export const DEFAULT_CONTEXT_CONTENT_BYTES = 96_000;
export const DEFAULT_CONTEXT_ITEM_BYTES = 24_000;
export const BRIEF_CONTEXT_CONTENT_BYTES = 8_000;
export const BRIEF_CONTEXT_ITEM_BYTES = 3_000;

/**
 * Build the host-facing context envelope after project resolution.
 *
 * This is deliberately defensive: callers may pass broader candidate data,
 * but project-scoped items are only emitted for the one resolved project.
 * Without a resolved project, only unbound fresh evidence matching the
 * request's explicit continuity may pass through.
 */
export function buildContextCapsule(input: ContextCapsuleInput): ContextCapsule {
  const accountId = requireNonEmpty(input.accountId, "accountId");
  const resolvedProjectId = input.resolution.projectId;

  const globalMemory = filterItems(input.globalMemory, (item) => item.scope === "global");
  const reusableSkills = filterItems(input.reusableSkills, (item) =>
    item.scope === "capability" && item.authority === "remembered");

  const allowProject = input.resolution.recallScope === "global_and_project" && resolvedProjectId !== null;
  const continuityId = normalizeOptional(input.continuityId);
  const projectMemory = filterItems(input.projectMemory, (item) => {
    if (item.scope !== "project") return false;
    const freshEvidence = item.authority === "evidence" &&
      item.provenance?.memoryLayer === "L1" && item.provenance.freshness === "undistilled";
    if (allowProject) {
      return item.projectId === resolvedProjectId && (item.authority === "remembered" || freshEvidence);
    }
    return resolvedProjectId === null && Boolean(continuityId) && item.projectId === undefined &&
      freshEvidence && item.provenance?.continuityId === continuityId;
  });
  const projectArchitecture = allowProject
    ? filterItems(input.projectArchitecture, (item) =>
        item.scope === "project" && item.projectId === resolvedProjectId && item.authority === "authoritative")
    : [];

  const isBrief = input.detail === "brief";
  const defaultTotalBytes = isBrief ? BRIEF_CONTEXT_CONTENT_BYTES : DEFAULT_CONTEXT_CONTENT_BYTES;
  const defaultItemBytes = isBrief ? BRIEF_CONTEXT_ITEM_BYTES : DEFAULT_CONTEXT_ITEM_BYTES;
  const maxContentBytes = normalizeBudget(input.maxContentBytes, defaultTotalBytes, 2_000, 512_000);
  const maxItemContentBytes = normalizeBudget(input.maxItemContentBytes, defaultItemBytes, 1_000, 128_000);

  const queryTerms = input.queryTerms ?? (
    input.query ? turnQueryTerms(input.query, {
      retrievalDiagnostics: input.retrievalDiagnostics
    } as ContextCapsule) : []
  );

  const budgeted = applyContextBudget({
    globalMemory,
    projectMemory,
    reusableSkills,
    projectArchitecture
  }, {
    maxContentBytes,
    maxItemContentBytes,
    isBrief,
    queryTerms
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
    ambiguities: input.resolution.source === "ambiguous"
      ? [...input.resolution.candidates]
      : [],
    branchContext: input.branchContext ?? null,
    contextBudget: budgeted.budget,
    ...(input.retrievalDiagnostics ? { retrievalDiagnostics: input.retrievalDiagnostics } : {})
  };
}

type ContextCollections = Pick<ContextCapsule,
  "globalMemory" | "projectMemory" | "reusableSkills" | "projectArchitecture">;

function applyContextBudget(
  input: ContextCollections,
  options: {
    maxContentBytes: number;
    maxItemContentBytes: number;
    isBrief: boolean;
    queryTerms: readonly string[];
  }
): { items: ContextCollections; budget: ContextCapsule["contextBudget"] } {
  const keys = ["globalMemory", "projectMemory", "reusableSkills", "projectArchitecture"] as const;
  const output: ContextCollections = {
    globalMemory: [],
    projectMemory: [],
    reusableSkills: [],
    projectArchitecture: []
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
      const bounded = boundContextItem(item, allowance, {
        isBrief: options.isBrief,
        queryTerms: options.queryTerms
      });
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

function boundContextItem(
  item: ContextItem,
  maxBytes: number,
  options: { isBrief: boolean; queryTerms: readonly string[] }
): { item: ContextItem; emittedBytes: number; truncated: boolean } {
  const originalBytes = Buffer.byteLength(item.content, "utf8");
  if (originalBytes <= maxBytes) return { item: { ...item }, emittedBytes: originalBytes, truncated: false };

  if (options.isBrief) {
    const itemMatched = matchedTerms(item);
    const headings = extractMarkdownHeadings(item.content, 12);
    const passages = selectPassages(item.content, options.queryTerms, itemMatched, "none");
    const briefContent = passages.length > 0
      ? buildExtractiveBrief(headings, passages, maxBytes)
      : "";

    if (briefContent) {
      const emittedBytes = Buffer.byteLength(briefContent, "utf8");
      return {
        item: {
          ...item,
          content: briefContent,
          provenance: {
            ...(item.provenance ?? {}),
            contextTruncated: true,
            originalContentBytes: originalBytes,
            emittedContentBytes: emittedBytes,
            brief: {
              originalBytes,
              method: "extractive-passages"
            }
          }
        },
        emittedBytes,
        truncated: true
      };
    }

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
          emittedContentBytes: emittedBytes,
          brief: {
            originalBytes,
            method: "head-tail"
          }
        }
      },
      emittedBytes,
      truncated: true
    };
  }

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

function buildExtractiveBrief(
  headings: readonly string[],
  passages: readonly TurnKnowledgePassage[],
  maxBytes: number
): string {
  const outlineLines = headings.length > 0
    ? ["## Outline", ...headings.map((h) => `- ${h}`)]
    : [];
  const outlineText = outlineLines.length > 0 ? outlineLines.join("\n") + "\n\n" : "";
  const outlineBytes = Buffer.byteLength(outlineText, "utf8");
  if (outlineBytes >= maxBytes - 32) return "";

  let currentText = outlineText;
  let addedPassageCount = 0;

  for (const passage of passages) {
    const passageText = passage.heading
      ? `### ${passage.heading}\n${passage.text}`
      : passage.text;
    const separator = addedPassageCount > 0 ? "\n\n" : "";
    const candidate = `${currentText}${separator}${passageText}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      currentText = candidate;
      addedPassageCount += 1;
    } else {
      if (addedPassageCount === 0) {
        const remainingBytes = maxBytes - Buffer.byteLength(currentText + separator, "utf8");
        if (remainingBytes >= 64) {
          const truncated = utf8Prefix(passageText, remainingBytes);
          currentText = `${currentText}${separator}${truncated}`;
          addedPassageCount += 1;
        }
      }
      break;
    }
  }

  return addedPassageCount > 0 ? currentText.trim() : "";
}

function matchedTerms(item: ContextItem): string[] {
  const retrieval = objectRecord(item.provenance?.retrievalV1);
  const value = retrieval?.matchedTerms;
  return Array.isArray(value) ? value.filter((term): term is string => typeof term === "string") : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function truncateUtf8HeadTail(value: string, maxBytes: number): string {
  const marker = "\n… [truncated by Memhub context budget] …\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes + 2) return utf8Prefix(value, maxBytes);
  const payloadBytes = maxBytes - markerBytes;
  const headBytes = Math.floor(payloadBytes * 0.7);
  const tailBytes = payloadBytes - headBytes;
  return utf8Prefix(value, headBytes) + marker + utf8Suffix(value, tailBytes);
}

export function utf8Prefix(value: string, maxBytes: number): string {
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
