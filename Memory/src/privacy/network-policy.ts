export type MemoryNetworkPolicy = "local_only" | "allow_remote";

export interface MemoryNetworkTargetOptions {
  policy?: MemoryNetworkPolicy;
  purpose?: string;
  allowRemote?: boolean;
}

export class MemoryPrivacyBoundaryError extends Error {
  override readonly name = "MemoryPrivacyBoundaryError";
  readonly endpoint: string;
  readonly purpose: string;

  constructor(endpoint: string, purpose: string) {
    super(`privacy boundary blocks remote endpoint for ${purpose}: ${safeEndpoint(endpoint)}`);
    this.endpoint = endpoint;
    this.purpose = purpose;
  }
}

/**
 * Memory Core is local-only by default. Remote egress must be an explicit
 * caller decision; a configured URL alone is never sufficient authorization.
 */
export function assertMemoryNetworkTarget(
  endpoint: string,
  options: MemoryNetworkTargetOptions = {}
): void {
  const policy = options.allowRemote === true ? "allow_remote" : options.policy ?? "local_only";
  if (policy === "allow_remote") return;

  const url = parseHttpEndpoint(endpoint);
  if (isLoopbackHostname(url.hostname)) return;

  throw new MemoryPrivacyBoundaryError(endpoint, options.purpose ?? "memory network request");
}

export function isLoopbackMemoryEndpoint(endpoint: string): boolean {
  try {
    return isLoopbackHostname(parseHttpEndpoint(endpoint).hostname);
  } catch {
    return false;
  }
}

function parseHttpEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new MemoryPrivacyBoundaryError(endpoint, "invalid memory endpoint");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MemoryPrivacyBoundaryError(endpoint, "unsupported memory network protocol");
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.split(".");
  if (ipv4.length !== 4 || ipv4.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = ipv4.map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return false;
  return octets[0] === 127;
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}
