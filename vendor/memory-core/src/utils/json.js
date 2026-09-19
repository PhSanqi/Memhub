export function parseJson(text, fallback) {
    if (!text)
        return fallback;
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
export function toJson(value) {
    return JSON.stringify(value ?? null);
}
export function stringifyForMemory(value) {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
export function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
