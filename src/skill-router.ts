import type { ContextItem } from "./context-capsule.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";

export interface SkillSelectionMetadata {
  version: "skill-router-v1";
  title: string;
  summary: string;
  whenToUse: string;
  triggers: string[];
  scope: string;
  reliability: number;
  reliabilitySource: "telemetry" | "tag" | "default";
  executor: string;
  loadRequired: true;
}

export function compactSkillContextItem(
  item: ContextItem,
  telemetryReliability?: number
): ContextItem {
  const tags = provenanceTags(item);
  const title = skillTitle(item.content);
  const summary = skillSummary(item.content, title);
  const whenToUse = skillWhenToUse(item.content, summary);
  const taggedReliability = numericTag(tags, ["reliability", "confidence"]);
  const reliability = clamp01(
    telemetryReliability ?? taggedReliability ?? 0.5
  );
  const reliabilitySource: SkillSelectionMetadata["reliabilitySource"] = telemetryReliability !== undefined
    ? "telemetry"
    : taggedReliability !== undefined
      ? "tag"
      : "default";
  const executor = stringTag(tags, "executor") ?? "connected_harness";
  const triggers = skillTriggers(tags, title, whenToUse);
  const metadata: SkillSelectionMetadata = {
    version: "skill-router-v1",
    title,
    summary,
    whenToUse,
    triggers,
    scope: item.projectId ? `project:${item.projectId}` : "account",
    reliability: round(reliability),
    reliabilitySource,
    executor,
    loadRequired: true
  };
  return {
    ...item,
    content: [
      `Skill candidate: ${title}`,
      `Summary: ${summary}`,
      `When to use: ${whenToUse}`,
      `Triggers: ${triggers.join(", ") || "none"}`,
      `Reliability: ${metadata.reliability} (${metadata.reliabilitySource})`,
      `Executor: ${executor}`,
      `Load: memhub_skill action=load skill_id=${item.id}`
    ].join("\n"),
    provenance: {
      ...(item.provenance ?? {}),
      skillRouter: metadata
    }
  };
}

export function enrichSkillCandidateReliability(item: ContextItem, reliability: number): ContextItem {
  const current = item.provenance?.skillRouter;
  if (!current || typeof current !== "object" || Array.isArray(current)) return item;
  const bounded = round(clamp01(reliability));
  const metadata = {
    ...(current as Record<string, unknown>),
    reliability: bounded,
    reliabilitySource: "telemetry"
  };
  const lines = item.content.split(/\r?\n/).map((line) =>
    line.startsWith("Reliability: ") ? `Reliability: ${bounded} (telemetry)` : line
  );
  return {
    ...item,
    content: lines.join("\n"),
    provenance: { ...(item.provenance ?? {}), skillRouter: metadata }
  };
}

export function skillSelectionMetadataFromBody(
  body: string,
  input: { projectId?: string; tags?: readonly string[]; telemetryReliability?: number } = {}
): SkillSelectionMetadata {
  const title = skillTitle(body);
  const summary = skillSummary(body, title);
  const whenToUse = skillWhenToUse(body, summary);
  const tags = input.tags ?? [];
  const taggedReliability = numericTag(tags, ["reliability", "confidence"]);
  const reliability = clamp01(input.telemetryReliability ?? taggedReliability ?? 0.5);
  return {
    version: "skill-router-v1",
    title,
    summary,
    whenToUse,
    triggers: skillTriggers(tags, title, whenToUse),
    scope: input.projectId ? `project:${input.projectId}` : "account",
    reliability: round(reliability),
    reliabilitySource: input.telemetryReliability !== undefined ? "telemetry" : taggedReliability !== undefined ? "tag" : "default",
    executor: stringTag(tags, "executor") ?? "connected_harness",
    loadRequired: true
  };
}

function skillTitle(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstNonArtifact = lines.find((line) => !/^(?:skill\.import:|artifact:)/i.test(line));
  // Recall hits prepend Memory Core's structured title to the snippet. Prefer
  // that explicit first line before inspecting Markdown inside the snippet;
  // otherwise a flattened "# Title <first paragraph>" can swallow the first
  // paragraph into the candidate title.
  if (firstNonArtifact && !/^#{1,6}\s+/.test(firstNonArtifact)) {
    const beforeInlineHeading = firstNonArtifact.match(/^(.+?)\s+#{1,6}\s+/)?.[1]?.trim();
    if (beforeInlineHeading) return clip(beforeInlineHeading, 160);
    if (!/\s+#{1,6}\s+/.test(firstNonArtifact)) return clip(firstNonArtifact, 160);
  }
  // Memory Core can flatten the indexed Skill excerpt into one line while
  // prefixing it with the title. Stop at the next Markdown heading rather
  // than treating the entire excerpt as the title.
  const inlineHeading = content.match(/(?:^|\s)#{1,3}\s+(.+?)(?=\s+#{1,6}\s+|\r?\n|$)/);
  if (inlineHeading?.[1]) return clip(inlineHeading[1], 160);
  const heading = lines.find((line) => /^#{1,3}\s+/.test(line));
  if (heading) return clip(heading.replace(/^#{1,3}\s+/, "").trim(), 160);
  return clip(firstNonArtifact ?? "Reusable Skill", 160);
}

function skillSummary(content: string, title: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const candidates = lines.filter((line) =>
    line &&
    !/^#{1,6}\s+/.test(line) &&
    !/^(?:skill\.import:|artifact:)/i.test(line) &&
    normalize(line) !== normalize(title) &&
    !/^(?:when to use|适用场景|何时使用|boundaries|边界)\s*:??$/i.test(line)
  );
  const candidate = candidates[0] ?? title;
  if (/\s+#{1,6}\s+/.test(candidate)) {
    return clip(skillWhenToUse(content, title), 240);
  }
  return clip(candidate, 240);
}

function skillWhenToUse(content: string, fallback: string): string {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!/^(?:#{1,6}\s*)?(?:when to use|适用场景|何时使用)\s*:??\s*$/i.test(line)) continue;
    const collected: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]!.trim();
      if (/^#{1,6}\s+/.test(next)) break;
      if (next) collected.push(next.replace(/^[-*]\s+/, ""));
      if (collected.join(" ").length >= 320) break;
    }
    if (collected.length > 0) return clip(collected.join(" "), 320);
  }
  const flattened = content.match(/(?:^|\s)#{1,6}\s*(?:when to use|适用场景|何时使用)\s+(.+?)(?=\s+#{1,6}\s+|$)/i);
  if (flattened?.[1]) return clip(flattened[1], 320);
  return clip(fallback, 320);
}

function skillTriggers(tags: readonly string[], title: string, whenToUse: string): string[] {
  const tagTriggers = tags
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isInfrastructureTag(tag))
    .map((tag) => tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag)
    .filter((tag) => tag.length >= 2 && tag.length <= 48);
  const lexical = tokenizeRetrievalText(`${title} ${whenToUse}`)
    .filter((term) => term.length >= 2 && term.length <= 32);
  return [...new Set([...tagTriggers, ...lexical])].slice(0, 10);
}

function isInfrastructureTag(tag: string): boolean {
  return /^(?:manual|memhub|distilled|reusable|memory-v2|artifact:|layer:|project:|provenance:|evidence:|revision-of:|source-conversation:|distill-contract:|confidence:|reliability:|executor:)/i.test(tag);
}

function provenanceTags(item: ContextItem): string[] {
  const value = item.provenance?.tags;
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
}

function numericTag(tags: readonly string[], names: readonly string[]): number | undefined {
  for (const name of names) {
    const prefix = `${name}:`;
    const tag = tags.find((value) => value.toLocaleLowerCase().startsWith(prefix));
    if (!tag) continue;
    const parsed = Number(tag.slice(prefix.length));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringTag(tags: readonly string[], name: string): string | undefined {
  const prefix = `${name}:`;
  const tag = tags.find((value) => value.toLocaleLowerCase().startsWith(prefix));
  const value = tag?.slice(prefix.length).trim();
  return value || undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
