import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

// Shared by transports for the same account: HTTP can recreate the MCP server
// between continuation requests. Read-only Skill/evidence loads retain the full
// JSON in memory, preserving memhub_result without filesystem writes. Results
// expire on restart or TTL; callers can rerun the original read in either case.
const inlineResults = new Map<string, Map<string, { text: string; createdAt: number; bytes: number }>>();
const MAX_INLINE_RESULT_BYTES = 256 * 1024 * 1024;

function pruneInlineResults(): void {
  const now = Date.now();
  let bytes = 0;
  const retained = [];
  for (const [account, results] of inlineResults) {
    for (const [id, result] of results) {
      if (now - result.createdAt > RESULT_TTL_MS) results.delete(id);
      else { bytes += result.bytes; retained.push({ account, id, ...result }); }
    }
    if (results.size === 0) inlineResults.delete(account);
  }
  if (bytes <= MAX_INLINE_RESULT_BYTES) return;
  retained.sort((a, b) => a.createdAt - b.createdAt);
  for (const result of retained) {
    const results = inlineResults.get(result.account)!;
    results.delete(result.id);
    bytes -= result.bytes;
    if (results.size === 0) inlineResults.delete(result.account);
    if (bytes <= MAX_INLINE_RESULT_BYTES) break;
  }
}

setInterval(pruneInlineResults, 60_000).unref();

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

  wrap(value: unknown, options: { readOnly?: boolean } = {}): unknown {
    pruneInlineResults();
    const text = JSON.stringify(value, null, 2) ?? "null";
    if (text.length <= this.inlineChars) return value;
    const resultId = randomUUID();
    if (options.readOnly) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_INLINE_RESULT_BYTES) throw new Error("result exceeds in-memory transport byte cap");
      let results = inlineResults.get(this.dir);
      if (!results) { results = new Map(); inlineResults.set(this.dir, results); }
      let chars = 0;
      for (const result of results.values()) chars += result.text.length;
      for (const [id, result] of results) {
        if (results.size < 128 && chars + text.length <= 64_000_000) break;
        results.delete(id); chars -= result.text.length;
      }
      results.set(resultId, { text, createdAt: Date.now(), bytes });
      pruneInlineResults();
      return this.chunk(resultId, 0, DEFAULT_RESULT_CHUNK_CHARS);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.pruneSpool();
    writeFileSync(this.path(resultId), text, { encoding: "utf8", mode: 0o600 });
    return this.chunk(resultId, 0, DEFAULT_RESULT_CHUNK_CHARS);
  }

  read(resultId: string, offset = 0, chunkChars = DEFAULT_RESULT_CHUNK_CHARS): ResultTransportEnvelope {
    pruneInlineResults();
    const id = validateResultId(resultId);
    const cached = inlineResults.get(this.dir)?.get(id);
    if (cached) return this.chunkText(id, cached.text, offset, normalizeChunkChars(chunkChars));
    const path = this.path(id);
    let info;
    try {
      info = statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("result spool expired; rerun the original Memhub tool");
      }
      throw error;
    }
    if (Date.now() - info.mtimeMs > RESULT_TTL_MS) throw new Error("result spool expired; rerun the original Memhub tool");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("result spool expired; rerun the original Memhub tool");
      }
      throw error;
    }
    return this.chunkText(id, text, offset, normalizeChunkChars(chunkChars));
  }

  private pruneSpool(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // At most 64 directory entries per write. Only transport UUID files.
    let scanned = 0;
    for (const name of entries) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      scanned += 1;
      if (scanned > 64) break;
      const path = join(this.dir, name);
      try {
        const info = lstatSync(path);
        if (info.isFile() && Date.now() - info.mtimeMs > RESULT_TTL_MS) unlinkSync(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
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
