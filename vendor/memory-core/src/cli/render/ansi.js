export function createCliStyle(options = {}) {
    const color = options.color ?? shouldUseColor();
    const wrap = (code, text) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
    return {
        bold: (text) => wrap(1, text),
        dim: (text) => wrap(2, text),
        green: (text) => wrap(32, text),
        cyan: (text) => wrap(36, text),
        yellow: (text) => wrap(33, text),
        red: (text) => wrap(31, text),
        gray: (text) => wrap(90, text)
    };
}
function shouldUseColor() {
    if (process.env.NO_COLOR)
        return false;
    if (process.env.MEMMY_FORCE_COLOR === "1")
        return true;
    return Boolean(process.stdout.isTTY);
}
