import { isRecord } from "../../utils/json.js";
import { resolveTimeZone, zonedDateKey } from "../../utils/time.js";
export function panelToolLatency(logs, dates, timeZone) {
    const byTool = new Map();
    for (const log of logs) {
        const current = byTool.get(log.toolName) ?? [];
        current.push(log);
        byTool.set(log.toolName, current);
    }
    const tools = Array.from(byTool.entries())
        .map(([name, rows]) => {
        const durations = rows.map((row) => Math.max(0, Math.round(row.durationMs)));
        return {
            name,
            calls: rows.length,
            avgMs: panelRoundInt(panelAverage(durations)),
            p95Ms: panelPercentile95(durations)
        };
    })
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    return {
        tools,
        series: tools.map((tool) => {
            const rows = byTool.get(tool.name) ?? [];
            return {
                name: tool.name,
                points: dates.map((date) => {
                    const durations = rows
                        .filter((row) => panelDateKey(row.calledAt, timeZone) === date)
                        .map((row) => Math.max(0, Math.round(row.durationMs)));
                    return { date, avgMs: panelRoundInt(panelAverage(durations)) };
                })
            };
        })
    };
}
export function panelRecallScore(outputJson) {
    const output = panelJsonObject(outputJson);
    const stats = isRecord(output.stats) ? output.stats : {};
    const score = stats.topRelevance;
    return typeof score === "number" && Number.isFinite(score) ? Math.max(0, score) : undefined;
}
export function panelLastSevenDateKeys(now, timeZone) {
    return panelDateKeys(now, 7, timeZone);
}
export function panelDateKeys(now, days, timeZone) {
    const zone = resolveTimeZone(timeZone);
    const endKey = zonedDateKey(now, zone) || zonedDateKey(new Date(), zone);
    const end = new Date(`${endKey}T00:00:00.000Z`);
    return Array.from({ length: days }, (_item, index) => {
        const day = new Date(end);
        day.setUTCDate(end.getUTCDate() - (days - 1 - index));
        return day.toISOString().slice(0, 10);
    });
}
export function panelDateKey(value, timeZone) {
    return value ? zonedDateKey(value, timeZone) : "";
}
export function panelAverage(values) {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
export function panelPercentile95(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return panelRoundInt(sorted[index] ?? 0);
}
export function panelRoundInt(value) {
    return Math.max(0, Math.round(value));
}
export function panelRoundDecimal(value, decimals) {
    return Number(value.toFixed(decimals));
}
function panelJsonObject(raw) {
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
