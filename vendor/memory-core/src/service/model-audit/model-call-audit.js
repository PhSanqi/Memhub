import { nowIso } from "../../utils/time.js";
export function elapsedApiLogMs(startedAt, endedAt = performance.now()) {
    return Math.max(0, Math.ceil(endedAt - startedAt));
}
export function recordApiLog(runtime, toolName, input, output, durationMs, success, calledAt = nowIso(), sourceAgent) {
    runtime.insertApiLog({
        toolName,
        sourceAgent: sourceAgent?.trim() || undefined,
        inputJson: JSON.stringify(input ?? {}),
        outputJson: JSON.stringify(output ?? {}),
        durationMs: Math.max(0, Math.round(durationMs)),
        success,
        calledAt
    });
}
