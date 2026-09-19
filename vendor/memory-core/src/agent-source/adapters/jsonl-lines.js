/** Jsonl lines module. */
import { createReadStream } from "node:fs";
/**
 * Streams valid object rows from a JSONL file.
 * Malformed and non-object rows are skipped without interrupting the stream.
 *
 * @param filePath JSONL file path.
 * @param signal Optional abort signal.
 * @returns The JSON objects parsed line by line.
 */
export async function* readJsonlObjects(filePath, signal) {
    const stream = createReadStream(filePath);
    const maxRecordBytes = 64 * 1024 * 1024;
    let segments = [];
    let recordBytes = 0;
    let overLimit = false;
    const append = (segment) => {
        if (overLimit || segment.length === 0)
            return;
        recordBytes += segment.length;
        if (recordBytes > maxRecordBytes) {
            segments = [];
            overLimit = true;
            return;
        }
        segments.push(segment);
    };
    const reset = () => {
        segments = [];
        recordBytes = 0;
        overLimit = false;
    };
    const parseSegments = () => {
        if (overLimit)
            return null;
        const line = segments.length === 1 ? segments[0] : Buffer.concat(segments, recordBytes);
        const text = line.toString("utf8").trim();
        if (!text)
            return null;
        try {
            const parsed = JSON.parse(text);
            return isJsonObject(parsed) ? parsed : null;
        }
        catch {
            return null;
        }
    };
    try {
        for await (const chunk of stream) {
            throwIfAborted(signal, filePath);
            const buffer = chunk;
            let start = 0;
            while (start <= buffer.length) {
                const newline = buffer.indexOf(0x0a, start);
                if (newline < 0) {
                    append(buffer.subarray(start));
                    break;
                }
                append(buffer.subarray(start, newline));
                const parsed = parseSegments();
                reset();
                if (parsed)
                    yield parsed;
                start = newline + 1;
            }
        }
        const parsed = parseSegments();
        if (parsed)
            yield parsed;
    }
    finally {
        stream.destroy();
    }
}
/**
 * Abort-signal check.
 *
 * @param signal Optional abort signal.
 * @param filePath Current file path.
 */
function throwIfAborted(signal, filePath) {
    if (signal?.aborted) {
        throw new DOMException(`JSONL read aborted: ${filePath}`, "AbortError");
    }
}
/**
 * JSON object type guard.
 *
 * @param value Unknown value.
 * @returns Whether it is a non-array object.
 */
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
