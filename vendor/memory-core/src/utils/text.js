export function clip(value, max) {
    const cleaned = value.replace(/\s+/g, " ").trim();
    return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}
export function firstLine(value) {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";
}
