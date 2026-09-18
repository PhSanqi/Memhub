import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { decompress, Decompress, ZstdErrorCode } from "fzstd";
import { readJsonlObjects } from "../jsonl-lines.js";
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export async function readDeepseekHarnessSession(filePath, signal) {
    signal?.throwIfAborted();
    const bytes = await readFile(filePath);
    signal?.throwIfAborted();
    const text = filePath.endsWith(".zstd") ? decompressFrames(bytes) : bytes.toString("utf8");
    return parseSessionRows(text, filePath, signal);
}
/** Streams uncompressed sessions; compressed legacy files use the existing decoder. */
export async function* streamDeepseekHarnessSession(filePath, signal) {
    if (filePath.endsWith(".zstd")) {
        let conversationId = basename(filePath).replace(/\.jsonl\.zstd$/u, "");
        let workspacePath = null;
        for await (const record of streamZstdJsonlObjects(filePath, signal)) {
            signal?.throwIfAborted();
            if (record.type === "session") {
                if (typeof record.id === "string")
                    conversationId = record.id;
                if (typeof record.cwd === "string")
                    workspacePath = record.cwd;
                continue;
            }
            const message = toMessage(record, conversationId, workspacePath);
            if (message)
                yield message;
        }
        return;
    }
    let conversationId = basename(filePath).replace(/\.jsonl$/u, "");
    let workspacePath = null;
    for await (const record of readJsonlObjects(filePath, signal)) {
        signal?.throwIfAborted();
        if (record.type === "session") {
            if (typeof record.id === "string")
                conversationId = record.id;
            if (typeof record.cwd === "string")
                workspacePath = record.cwd;
            continue;
        }
        const message = toMessage(record, conversationId, workspacePath);
        if (message)
            yield message;
    }
}
/** Streams zstd frames and parses bounded JSONL records without materializing the file. */
async function* streamZstdJsonlObjects(filePath, signal) {
    const input = createReadStream(filePath);
    const output = [];
    let outputBytes = 0;
    let carry = Buffer.alloc(0);
    let overLimit = false;
    const decoder = new Decompress((chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 8 * 1024 * 1024)
            throw new Error("DeepSeek Harness decompressed chunk exceeds 8 MiB staging limit");
        output.push(Buffer.from(chunk));
    });
    try {
        for await (const chunk of input) {
            signal?.throwIfAborted();
            decoder.push(chunk);
            while (output.length > 0) {
                const data = output.shift();
                outputBytes -= data.byteLength;
                carry = carry.length === 0 ? data : Buffer.concat([carry, data]);
                let newline = carry.indexOf(0x0a);
                while (newline >= 0) {
                    const line = carry.subarray(0, newline);
                    carry = carry.subarray(newline + 1);
                    newline = carry.indexOf(0x0a);
                    if (overLimit) {
                        overLimit = false;
                        continue;
                    }
                    if (line.length > 64 * 1024 * 1024)
                        continue;
                    const parsed = parseJsonObject(line);
                    if (parsed)
                        yield parsed;
                }
                if (carry.length > 64 * 1024 * 1024) {
                    carry = Buffer.alloc(0);
                    overLimit = true;
                }
            }
        }
        decoder.push(new Uint8Array(), true);
        while (output.length > 0) {
            const data = output.shift();
            outputBytes -= data.byteLength;
            carry = carry.length === 0 ? data : Buffer.concat([carry, data]);
            let newline = carry.indexOf(0x0a);
            while (newline >= 0) {
                const line = carry.subarray(0, newline);
                carry = carry.subarray(newline + 1);
                newline = carry.indexOf(0x0a);
                if (overLimit) {
                    overLimit = false;
                    continue;
                }
                if (line.length <= 64 * 1024 * 1024) {
                    const parsed = parseJsonObject(line);
                    if (parsed)
                        yield parsed;
                }
            }
        }
        if (!overLimit && carry.length > 0 && carry.length <= 64 * 1024 * 1024) {
            const parsed = parseJsonObject(carry);
            if (parsed)
                yield parsed;
        }
    }
    finally {
        input.destroy();
    }
}
function parseJsonObject(line) {
    try {
        const parsed = JSON.parse(line.toString("utf8").trim());
        return isRecord(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function decompressFrames(bytes) {
    if (!bytes.subarray(0, ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
        throw new Error("DeepSeek Harness session has no Zstandard frame header");
    }
    try {
        return Buffer.from(decompress(bytes)).toString("utf8");
    }
    catch (error) {
        if (!isUnexpectedEndOfFile(error))
            throw error;
        const trailingFrameOffset = bytes.lastIndexOf(ZSTD_FRAME_MAGIC);
        if (trailingFrameOffset <= 0)
            throw error;
        return Buffer.from(decompress(bytes.subarray(0, trailingFrameOffset))).toString("utf8");
    }
}
function isUnexpectedEndOfFile(error) {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === ZstdErrorCode.UnexpectedEOF;
}
function parseSessionRows(text, filePath, signal) {
    const records = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const header = records.find((record) => isRecord(record) && record.type === "session");
    const conversationId = isRecord(header) && typeof header.id === "string"
        ? header.id
        : basename(filePath).replace(/\.jsonl(?:\.zstd)?$/u, "");
    const workspacePath = isRecord(header) && typeof header.cwd === "string" ? header.cwd : null;
    const messages = [];
    for (const record of records) {
        signal?.throwIfAborted();
        const message = toMessage(record, conversationId, workspacePath);
        if (message)
            messages.push(message);
    }
    return messages;
}
function toMessage(value, conversationId, workspacePath) {
    if (!isRecord(value) || !isRecord(value.data))
        return null;
    const rawMessage = value.type === "user/message"
        ? value.data
        : value.type === "assistant/message" && isRecord(value.data.message)
            ? value.data.message
            : null;
    if (!rawMessage)
        return null;
    if (value.type === "user/message" && (!isRecord(rawMessage.source) || rawMessage.source.kind !== "user")) {
        return null;
    }
    const role = rawMessage.role;
    if (role !== "user" && role !== "assistant")
        return null;
    const content = contentText(rawMessage.content);
    if (!content)
        return null;
    const seq = typeof value.seq === "number" ? value.seq : messagesFallbackSeq(value);
    return {
        messageId: typeof rawMessage.id === "string" ? rawMessage.id : `${conversationId}:${seq}`,
        conversationId,
        role,
        content,
        createdAt: normalizeTimestamp(value.time),
        workspacePath,
        rawMeta: Object.freeze({ seq })
    };
}
function contentText(value) {
    if (!Array.isArray(value))
        return "";
    return value.filter(isRecord)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => String(block.text).trim())
        .filter(Boolean)
        .join("\n")
        .trim();
}
function normalizeTimestamp(value) {
    const date = new Date(typeof value === "number" || typeof value === "string" ? value : 0);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
function messagesFallbackSeq(value) {
    return typeof value.time === "number" ? value.time : 0;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
