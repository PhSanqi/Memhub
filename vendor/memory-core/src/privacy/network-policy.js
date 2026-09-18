export class MemoryPrivacyBoundaryError extends Error {
    name = "MemoryPrivacyBoundaryError";
    endpoint;
    purpose;
    constructor(endpoint, purpose) {
        super(`privacy boundary blocks remote endpoint for ${purpose}: ${safeEndpoint(endpoint)}`);
        this.endpoint = endpoint;
        this.purpose = purpose;
    }
}
/**
 * Memory Core is local-only by default. Remote egress must be an explicit
 * caller decision; a configured URL alone is never sufficient authorization.
 */
export function assertMemoryNetworkTarget(endpoint, options = {}) {
    const policy = options.allowRemote === true ? "allow_remote" : options.policy ?? "local_only";
    if (policy === "allow_remote")
        return;
    const url = parseHttpEndpoint(endpoint);
    if (isLoopbackHostname(url.hostname))
        return;
    throw new MemoryPrivacyBoundaryError(endpoint, options.purpose ?? "memory network request");
}
export function isLoopbackMemoryEndpoint(endpoint) {
    try {
        return isLoopbackHostname(parseHttpEndpoint(endpoint).hostname);
    }
    catch {
        return false;
    }
}
function parseHttpEndpoint(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
        throw new MemoryPrivacyBoundaryError(endpoint, "invalid memory endpoint");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new MemoryPrivacyBoundaryError(endpoint, "unsupported memory network protocol");
    }
    return url;
}
function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalized === "localhost" || normalized === "::1")
        return true;
    const ipv4 = normalized.split(".");
    if (ipv4.length !== 4 || ipv4.some((part) => !/^\d{1,3}$/.test(part)))
        return false;
    const octets = ipv4.map(Number);
    if (octets.some((value) => value < 0 || value > 255))
        return false;
    return octets[0] === 127;
}
function safeEndpoint(value) {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
    }
    catch {
        return "<invalid-url>";
    }
}
