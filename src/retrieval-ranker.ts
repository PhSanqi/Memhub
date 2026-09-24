import type { RecallHit } from "./local-memory-client.js";

export interface RetrievalRankDiagnostics {
  version: "retrieval-v1";
  semanticWeight: number;
  lexicalWeight: number;
  diversityPenalty: number;
  candidateCount: number;
  dedupedCount: number;
  emittedCount: number;
  queryTerms: string[];
}

export interface RankedRecallHit {
  hit: RecallHit;
  rank: number;
  semanticScore: number;
  lexicalScore: number;
  fusedScore: number;
  diversityPenaltyApplied: number;
  matchedTerms: string[];
}

export interface RetrievalRankResult {
  hits: RankedRecallHit[];
  diagnostics: RetrievalRankDiagnostics;
}

const SEMANTIC_WEIGHT = 0.68;
const LEXICAL_WEIGHT = 0.32;
const DIVERSITY_PENALTY = 0.12;

/**
 * Retrieval v1 second-stage ranker.
 *
 * The caller must establish account/project/scope legality before invoking
 * this function. The ranker never broadens scope: it only reorders and
 * compresses an already legal candidate set.
 */
export function rankRecallHits(
  hits: readonly RecallHit[],
  query: string,
  limit: number
): RetrievalRankResult {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const queryTerms = tokenizeRetrievalText(query).slice(0, 32);
  const uniqueCandidates = dedupeCandidates(hits);
  const tokenized = uniqueCandidates.map((hit) => ({
    hit,
    tokens: documentTokens(hit),
    tokenSet: new Set(documentTokens(hit))
  }));
  const lexicalRaw = bm25Scores(tokenized.map((candidate) => candidate.tokens), queryTerms);
  const maxLexical = Math.max(0, ...lexicalRaw);

  const scored = tokenized.map((candidate, index) => {
    const semanticScore = normalizeSemantic(candidate.hit.score);
    const lexicalScore = maxLexical > 0 ? lexicalRaw[index]! / maxLexical : 0;
    const phraseBoost = exactPhraseBoost(query, candidate.hit);
    const fusedScore = clamp01(
      SEMANTIC_WEIGHT * semanticScore +
      LEXICAL_WEIGHT * lexicalScore +
      phraseBoost
    );
    return {
      ...candidate,
      semanticScore,
      lexicalScore,
      fusedScore,
      matchedTerms: queryTerms.filter((term) => candidate.tokenSet.has(term))
    };
  });

  const selected: Array<(typeof scored)[number] & { adjusted: number; penalty: number }> = [];
  const remaining = [...scored];
  while (remaining.length > 0 && selected.length < boundedLimit) {
    let bestIndex = 0;
    let bestAdjusted = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const similarity = selected.length === 0
        ? 0
        : Math.max(...selected.map((prior) => jaccard(candidate.tokenSet, prior.tokenSet)));
      const penalty = DIVERSITY_PENALTY * similarity;
      const adjusted = candidate.fusedScore - penalty;
      const best = remaining[bestIndex]!;
      if (
        adjusted > bestAdjusted ||
        (adjusted === bestAdjusted && candidate.fusedScore > best.fusedScore) ||
        (adjusted === bestAdjusted && candidate.fusedScore === best.fusedScore && candidate.hit.id.localeCompare(best.hit.id) < 0)
      ) {
        bestIndex = index;
        bestAdjusted = adjusted;
        bestPenalty = penalty;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    selected.push({ ...picked!, adjusted: bestAdjusted, penalty: bestPenalty });
  }

  return {
    hits: selected.map((candidate, index) => ({
      hit: candidate.hit,
      rank: index + 1,
      semanticScore: round(candidate.semanticScore),
      lexicalScore: round(candidate.lexicalScore),
      fusedScore: round(candidate.fusedScore),
      diversityPenaltyApplied: round(candidate.penalty),
      matchedTerms: candidate.matchedTerms.slice(0, 16)
    })),
    diagnostics: {
      version: "retrieval-v1",
      semanticWeight: SEMANTIC_WEIGHT,
      lexicalWeight: LEXICAL_WEIGHT,
      diversityPenalty: DIVERSITY_PENALTY,
      candidateCount: hits.length,
      dedupedCount: uniqueCandidates.length,
      emittedCount: selected.length,
      queryTerms
    }
  };
}

function dedupeCandidates(hits: readonly RecallHit[]): RecallHit[] {
  const byId = new Set<string>();
  const byContent = new Set<string>();
  const output: RecallHit[] = [];
  for (const hit of hits) {
    if (byId.has(hit.id)) continue;
    byId.add(hit.id);
    const contentKey = normalizeForComparison(`${hit.title ?? ""}\n${hit.snippet}`);
    if (contentKey && byContent.has(contentKey)) continue;
    if (contentKey) byContent.add(contentKey);
    output.push(hit);
  }
  return output;
}

function documentTokens(hit: RecallHit): string[] {
  const title = tokenizeRetrievalText(hit.title ?? "");
  const body = tokenizeRetrievalText(hit.snippet);
  return [...title, ...title, ...body].slice(0, 2_048);
}

function bm25Scores(documents: readonly string[][], queryTerms: readonly string[]): number[] {
  if (documents.length === 0 || queryTerms.length === 0) return documents.map(() => 0);
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set(doc);
    for (const term of queryTerms) if (seen.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  return documents.map((doc) => {
    const frequencies = new Map<string, number>();
    for (const token of doc) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = frequencies.get(term) ?? 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + b * doc.length / Math.max(1, averageLength));
      score += idf * (tf * (k1 + 1)) / denominator;
    }
    return score;
  });
}

export function tokenizeRetrievalText(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const segments = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output: string[] = [];
  for (const segment of segments) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      if (segment.length === 1) output.push(segment);
      else {
        if (segment.length <= 8) output.push(segment);
        for (let index = 0; index < segment.length - 1; index += 1) output.push(segment.slice(index, index + 2));
      }
      continue;
    }
    if (segment.length >= 2 || /^\d+$/u.test(segment)) output.push(segment);
  }
  return unique(output).slice(0, 512);
}

function exactPhraseBoost(query: string, hit: RecallHit): number {
  const phrase = normalizeForComparison(query);
  if (!phrase || phrase.length < 3 || phrase.length > 120) return 0;
  const document = normalizeForComparison(`${hit.title ?? ""} ${hit.snippet}`);
  return document.includes(phrase) ? 0.08 : 0;
}

function normalizeSemantic(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / (1 + value);
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
