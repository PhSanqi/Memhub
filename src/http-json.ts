import type { IncomingMessage } from "node:http";

export const MAX_HTTP_JSON_BODY_BYTES = 4_000_000;

export class HttpJsonBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message);
    this.name = "HttpJsonBodyError";
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_HTTP_JSON_BODY_BYTES
): Promise<unknown> {
  const declaredLength = contentLength(request.headers["content-length"]);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new HttpJsonBodyError(`request body exceeds ${maxBytes} bytes`, 413, "request_body_too_large");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new HttpJsonBodyError(`request body exceeds ${maxBytes} bytes`, 413, "request_body_too_large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpJsonBodyError("request body is not valid JSON", 400, "invalid_json_body");
  }
}

export function asHttpJsonBodyError(error: unknown): HttpJsonBodyError | null {
  return error instanceof HttpJsonBodyError ? error : null;
}

function contentLength(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
