import { captureTurnSteps, signatureFromTraceParts } from "../../algorithm/plugin-algorithms.js";
import { MemoryServiceError } from "../../utils/error.js";
import { isoTimeToUtc } from "../../utils/time.js";
import { stableHash } from "../../utils/id.js";
import { clip, firstLine } from "../../utils/text.js";
export const IMPORT_SUMMARY_QUEUED_TAG = "摘要排队中";
export const IMPORT_SUMMARY_PROCESSING_TAG = "摘要总结中";
export const IMPORT_INDEXING_TAG = "索引建立中";
export const IMPORT_FAILED_TAG = "处理失败";
export const IMPORT_STATUS_TAGS = [
    IMPORT_SUMMARY_QUEUED_TAG,
    "摘要整理中",
    IMPORT_SUMMARY_PROCESSING_TAG,
    "建立索引中",
    IMPORT_INDEXING_TAG,
    "索引已建立",
    IMPORT_FAILED_TAG
];
export const IMPORT_DEFAULT_ALPHA = 0;
export const IMPORT_DEFAULT_VALUE = 0;
export const IMPORT_DEFAULT_PRIORITY = 0.5;
const IMPORT_TOOL_PAYLOAD_MAX_CHARS = 20_000;
export function memoryAddKey(request, layer, title) {
    if (layer === "Skill" && request.sourceAgentId && (request.sourceSkillId || request.sourceSkillPath)) {
        return `skill.import:${stableHash([
            request.sourceAgentId,
            request.sourceSkillId ?? request.sourceSkillPath,
            request.sourceSkillVersion ?? request.sourceContentHash ?? stableHash(request.content)
        ]).slice(0, 20)}`;
    }
    if (isAgentSourceImportMemoryAdd(request) && request.adapterId && request.turnId)
        return `memory.add:${request.adapterId}:turn:${request.turnId}`;
    if (request.adapterId && request.requestId)
        return `memory.add:${request.adapterId}:${request.requestId}`;
    return `manual:${stableHash(`${layer}:${title}:${request.content}`).slice(0, 20)}`;
}
export function memoryAddTags(request, importTrace, traceTags = []) {
    return importTrace
        ? uniq([...(request.tags ?? []), ...(request.source ? [request.source] : []), ...traceTags])
        : uniq(["manual", ...(request.source ? [request.source] : []), ...(request.tags ?? [])]);
}
export function isAgentSourceImportMemoryAdd(request) {
    return request.adapterId?.startsWith("agent-source:") === true || request.tags?.some((tag) => tag.trim().toLowerCase() === "agent-source") === true;
}
export function normalizeMemoryAddCreatedAt(value, timeZone) {
    if (value === undefined)
        return undefined;
    try {
        return isoTimeToUtc(value, timeZone);
    }
    catch {
        throw new MemoryServiceError("invalid_argument", "memory.add createdAt must be an ISO timestamp");
    }
}
export function memoryAddImportTrace(request, at) {
    const sections = parseMemoryAddSections(request.content);
    const toolCalls = toolCallsFromImportSections(sections, {
        parseJsonPayload: !isCodexAgentSourceImport(request)
    });
    const userText = sections.length
        ? sections
            .filter((section) => section.role === "user" || section.role === "system")
            .map((section) => section.role === "system" ? `[system]\n${section.text}` : section.text)
            .join("\n\n")
        : request.content;
    const agentText = sections.length
        ? sections.filter((section) => section.role === "assistant").map((section) => section.text).join("\n\n")
        : "";
    const turnId = request.turnId ?? `import:${stableHash(request.content).slice(0, 16)}`;
    const tags = captureImportTraceTags({
        at,
        turnId,
        sessionId: request.sessionId ?? request.adapterId ?? "memory.add",
        userText,
        agentText,
        toolCalls
    });
    return {
        key: `memory.add:${stableHash(`${request.source ?? "manual"}:${turnId}:${request.content}`).slice(0, 20)}`,
        ts: Date.parse(at),
        time_zone: request.timeZone,
        turn_id: turnId,
        step_index: 0,
        sub_step_total: 1,
        user_text: userText,
        agent_text: agentText,
        userText,
        agentText,
        raw_span: { user_text: Boolean(userText), agent_text: Boolean(agentText), tool_call_count: toolCalls.length },
        tool_calls: toolCalls,
        reflection: null,
        alpha: IMPORT_DEFAULT_ALPHA,
        usable: false,
        reflection_source: "none",
        summary: IMPORT_SUMMARY_QUEUED_TAG,
        tags,
        value: IMPORT_DEFAULT_VALUE,
        priority: IMPORT_DEFAULT_PRIORITY,
        signature: signatureFromTraceParts(tags, toolCalls, ""),
        error_signatures: []
    };
}
export function memoryAddQaPair(request) {
    const sections = parseMemoryAddSections(request.content);
    const query = [...sections].reverse().find((section) => section.role === "user")?.text;
    const answer = [...sections].reverse().find((section) => section.role === "assistant")?.text;
    return query && answer ? { query, answer } : null;
}
export function titleFromImportTrace(trace) {
    const userText = stringFromRecord(trace, "user_text");
    const title = userText ? firstLine(userText) : "";
    return title ? clip(title, 120) : undefined;
}
export function toolCallsFromUnknown(value) {
    return Array.isArray(value) ? value.filter(isToolCallPayload) : [];
}
function captureImportTraceTags(input) {
    return captureTurnSteps({
        episodeId: `import:${input.turnId}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        userText: input.userText,
        assistantText: input.agentText,
        toolCalls: input.toolCalls,
        createdAtIso: input.at
    })[0]?.tags ?? [];
}
function parseMemoryAddSections(content) {
    const headingPattern = /^## (user|assistant|tool|system)\s*$/gm;
    const headings = [...content.matchAll(headingPattern)];
    return headings
        .map((heading, index) => {
        const nextHeading = headings[index + 1];
        const start = (heading.index ?? 0) + heading[0].length;
        const end = nextHeading?.index ?? content.length;
        return { role: heading[1], text: content.slice(start, end).trim() };
    })
        .filter((section) => section.text.length > 0);
}
function toolCallsFromImportSections(sections, options = { parseJsonPayload: true }) {
    const calls = [];
    const indexByCallId = new Map();
    for (const [index, section] of sections.filter((item) => item.role === "tool").entries()) {
        const parsed = parseImportedToolSection(section.text, index, options);
        const existingIndex = parsed.id ? indexByCallId.get(parsed.id) : undefined;
        if (existingIndex !== undefined) {
            calls[existingIndex] = mergeImportedToolCall(calls[existingIndex], parsed);
            continue;
        }
        if (parsed.id)
            indexByCallId.set(parsed.id, calls.length);
        calls.push(parsed);
    }
    return calls;
}
function parseImportedToolSection(text, index, options) {
    const fields = parseToolSectionFields(text, options);
    const fallbackOutput = fields.input === undefined && fields.output === undefined
        ? limitImportedToolPayload(stripToolHeaderLines(text).trim())
        : "";
    return {
        id: fields.callId,
        name: fields.name || `tool_${index + 1}`,
        input: fields.input,
        output: fields.output ?? (fallbackOutput.length > 0 ? fallbackOutput : undefined),
        error: fields.error,
        success: fields.error ? false : undefined
    };
}
function parseToolSectionFields(text, options) {
    return {
        name: firstToolLineValue(text, "Tool"),
        callId: firstToolLineValue(text, "Call ID"),
        input: toolBlockValue(text, "Input", options),
        output: toolBlockValue(text, "Output", options),
        error: firstToolLineValue(text, "Error")
    };
}
function firstToolLineValue(text, label) {
    const match = text.match(new RegExp(`^${escapeToolLabelRegExp(label)}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() || undefined;
}
function toolBlockValue(text, label, options) {
    const lines = text.split(/\r?\n/);
    const labelPattern = new RegExp(`^${escapeToolLabelRegExp(label)}:[\\t ]*$`, "i");
    const start = lines.findIndex((line) => labelPattern.test(line));
    if (start < 0)
        return undefined;
    const nextFieldOffset = lines.slice(start + 1).findIndex((line, offset) => lines[start + offset]?.trim() === "" &&
        /^(?:Tool|Call ID|Status|Input|Output|Error):(?:[\t ]*$|[\t ]+.*$)/i.test(line));
    const end = nextFieldOffset < 0 ? lines.length : start + 1 + nextFieldOffset;
    const value = limitImportedToolPayload(lines.slice(start + 1, end).join("\n").trim());
    if (!value)
        return undefined;
    if (!options.parseJsonPayload)
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function stripToolHeaderLines(text) {
    return text
        .split(/\r?\n/)
        .filter((line) => !/^(Tool|Call ID|Status|Error):\s*/i.test(line.trim()))
        .join("\n");
}
function mergeImportedToolCall(left, right) {
    return {
        ...left,
        name: left.name || right.name,
        input: left.input ?? right.input,
        output: left.output ?? right.output,
        error: left.error ?? right.error,
        success: left.success ?? right.success
    };
}
function isCodexAgentSourceImport(request) {
    const source = request.source?.trim().toLowerCase();
    const adapterId = request.adapterId?.trim().toLowerCase();
    return source === "codex" || adapterId === "agent-source:codex";
}
function limitImportedToolPayload(value) {
    if (value.length <= IMPORT_TOOL_PAYLOAD_MAX_CHARS)
        return value;
    return `${value.slice(0, IMPORT_TOOL_PAYLOAD_MAX_CHARS)}\n[truncated:${value.length - IMPORT_TOOL_PAYLOAD_MAX_CHARS} chars]`;
}
function escapeToolLabelRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stringFromRecord(record, key) {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}
function isToolCallPayload(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.name === "string";
}
function uniq(values) { return [...new Set(values)]; }
