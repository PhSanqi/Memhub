import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_RESULT_INLINE_CHARS = 120_000;
export const DEFAULT_RESULT_CHUNK_CHARS = 100_000;
export const MIN_RESULT_CHUNK_CHARS = 10_000;
export const MAX_RESULT_CHUNK_CHARS = 200_000;
export const RESULT_TTL_MS = 60 * 60 * 1000;

export interface ResultTransportEnvelope {
  result_transport: {
    mode: "chunked";
    result_id: string;
    offset: number;
    next_offset: number | null;
    total_chars: number;
    chunk_chars: number;
    complete: boolean;
    expires_in_seconds: number;
  };
  result_chunk: string;
  instructions: string;
}

export class JsonResultTransport {
  private readonly dir: string;

  constructor(
    stateRoot: string,
    accountId: string,
    private readonly inlineChars = DEFAULT_RESULT_INLINE_CHARS
  ) {
    const accountHash = createHash("sha256").update(requireNonEmpty(accountId, "accountId"), "utf8").digest("hex").slice(0, 24);
    this.dir = join(resolve(stateRoot), "result-spool", accountHash);
  }

  wrap(value: unknown): unknown {
    const text = JSON.stringify(value, null, 2) ?? "null";
    if (text.length <= this.inlineChars) return value;
    const resultId = randomUUID();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(resultId), text, { encoding: "utf8", mode: 0o600 });
    return this.chunk(resultId, 0, DEFAULT_RESULT_CHUNK_CHARS);
  }

  read(resultId: string, offset = 0, chunkChars = DEFAULT_RESULT_CHUNK_CHARS): ResultTransportEnvelope {
    const id = validateResultId(resultId);
    const path = this.path(id);
    const info = statSync(path);
    if (Date.now() - info.mtimeMs > RESULT_TTL_MS) throw new Error("result spool expired; rerun the original Memhub tool");
    const text = readFileSync(path, "utf8");
    return this.chunkText(id, text, offset, normalizeChunkChars(chunkChars));
  }

  private chunk(resultId: string, offset: number, chunkChars: number): ResultTransportEnvelope {
    return this.read(resultId, offset, chunkChars);
  }

  private chunkText(resultId: string, text: string, offset: number, chunkChars: number): ResultTransportEnvelope {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
      throw new TypeError(`result offset must be between 0 and ${text.length}`);
    }
    const end = Math.min(text.length, offset + chunkChars);
    const safeEnd = safeSliceEnd(text, offset, end);
    const nextOffset = safeEnd < text.length ? safeEnd : null;
    return {
      result_transport: {
        mode: "chunked",
        result_id: resultId,
        offset,
        next_offset: nextOffset,
        total_chars: text.length,
        chunk_chars: safeEnd - offset,
        complete: nextOffset === null,
        expires_in_seconds: Math.trunc(RESULT_TTL_MS / 1000)
      },
      result_chunk: text.slice(offset, safeEnd),
      instructions: nextOffset === null
        ? "All chunks have been read. Parse the concatenated result_chunk text as the original JSON result."
        : `Call memhub_result with result_id=${resultId}, offset=${nextOffset} to continue. Concatenate result_chunk values in offset order before parsing JSON.`
    };
  }

  private path(resultId: string): string {
    return join(this.dir, `${validateResultId(resultId)}.json`);
  }
}

function normalizeChunkChars(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_RESULT_CHUNK_CHARS || value > MAX_RESULT_CHUNK_CHARS) {
    throw new TypeError(`chunk_chars must be between ${MIN_RESULT_CHUNK_CHARS} and ${MAX_RESULT_CHUNK_CHARS}`);
  }
  return value;
}

function validateResultId(value: string): string {
  const normalized = requireNonEmpty(value, "result_id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new TypeError("invalid result_id");
  }
  return normalized;
}

function safeSliceEnd(value: string, start: number, end: number): number {
  if (end <= start || end >= value.length) return end;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
