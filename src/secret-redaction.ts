/**
 * Memhub-owned inline secret redaction for the capture path.
 *
 * The vendored agent-source redactor is deliberately not reused: its generic
 * base64 rule would also replace 32-hex artifact ids, git SHAs, sha256 evidence
 * refs and event ids that Memhub depends on. Here only keyed rules and very
 * large (>= 4096 char) opaque base64 payloads are removed, and nothing that is
 * pure hexadecimal is ever redacted.
 *
 * The operation is deterministic and idempotent: redact(redact(x)) === redact(x).
 */

export interface SecretRedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

interface RedactionState {
  count: number;
  kinds: Set<string>;
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AUTHORIZATION_BEARER =
  /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;
const API_KEY = /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g;
const GOOGLE_KEY = /\bAIza[A-Za-z0-9_-]{32,}\b/g;
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g;
// The key must END with a secret term (`GITHUB_TOKEN`, `client_secret`,
// `db.password`), so `max_tokens`, `token_count` or `secret_redaction` are
// left alone; redactAssignedValue also skips values that cannot be secrets.
const SECRET_ASSIGNMENT =
  /(["']?(?<![A-Za-z0-9])(?:[A-Za-z0-9_.-]*[_.-])?(?:password|passwd|pwd|secret|api[_-]?key|token)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|<[^>\n]*>|[^\s#&,;]+)/gi;
const NON_SECRET_VALUE = /^(?:\d+|true|false|null|none|undefined|redacted|\*+|x+|\.\.\.|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z0-9_]+)$/i;
const URL_USERINFO =
  /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)(?!\[REDACTED:)([^\s@/]+)@/g;

const LARGE_BASE64_MIN_LENGTH = 4096;
const PURE_HEX = /^[0-9a-f]+$/i;

export function redactSecrets(input: string): SecretRedactionResult {
  const state: RedactionState = { count: 0, kinds: new Set() };
  let text = input;

  text = replaceAndCount(text, PRIVATE_KEY_BLOCK, state, "private_key",
    () => "[REDACTED:private_key]");
  text = replaceAndCount(text, AUTHORIZATION_BEARER, state, "authorization_bearer",
    (_match, prefix) => `${prefix}[REDACTED:authorization_bearer]`);
  text = replaceAndCount(text, ANTHROPIC_KEY, state, "anthropic_api_key",
    () => "[REDACTED:anthropic_api_key]");
  text = replaceAndCount(text, API_KEY, state, "api_key",
    () => "[REDACTED:api_key]");
  text = replaceAndCount(text, GOOGLE_KEY, state, "google_api_key",
    () => "[REDACTED:google_api_key]");
  text = replaceAndCount(text, GITHUB_PAT, state, "github_token",
    () => "[REDACTED:github_token]");
  text = replaceAndCount(text, GITHUB_TOKEN, state, "github_token",
    () => "[REDACTED:github_token]");
  text = replaceAndCount(text, AWS_ACCESS_KEY, state, "aws_access_key",
    () => "[REDACTED:aws_access_key]");
  text = replaceAndCount(text, SLACK_TOKEN, state, "slack_token",
    () => "[REDACTED:slack_token]");
  text = replaceAndCount(text, JWT, state, "jwt",
    () => "[REDACTED:jwt]");
  text = replaceAndCount(text, SECRET_ASSIGNMENT, state, "secret_assignment",
    (match, prefix, value) => redactAssignedValue(match, prefix, value));
  text = replaceAndCount(text, URL_USERINFO, state, "url_password",
    (_match, prefix) => `${prefix}[REDACTED:password]@`);
  text = redactLargeBase64Runs(text, state);

  return { text, count: state.count, kinds: [...state.kinds] };
}

function replaceAndCount(
  text: string,
  pattern: RegExp,
  state: RedactionState,
  kind: string,
  render: (match: string, ...groups: string[]) => string
): string {
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    // node appends offset and the whole input to the callback arguments.
    const groups = rest.slice(0, Math.max(0, rest.length - 2)).map(String);
    const rendered = render(match, ...groups);
    if (rendered !== match) {
      state.count += 1;
      state.kinds.add(kind);
    }
    return rendered;
  });
}

function redactAssignedValue(match: string, prefix: string, rawValue: string): string {
  const quote = rawValue[0] === "\"" || rawValue[0] === "'" ? rawValue[0] : "";
  const inner = quote
    ? rawValue.slice(1, rawValue.endsWith(quote) ? -1 : undefined)
    : rawValue;
  // A second pass must not touch the marker this module already wrote.
  if (inner.startsWith("[REDACTED:")) return match;
  // Placeholders, numbers and booleans are not secrets; very short values are
  // only redacted for password keys.
  const isPasswordKey = /(?:password|passwd|pwd)["']?\s*[:=]\s*$/i.test(prefix);
  if (!inner || NON_SECRET_VALUE.test(inner) || (!isPasswordKey && inner.length < 8)) return match;
  return `${prefix}${quote}[REDACTED:secret_assignment]${quote}`;
}

function redactLargeBase64Runs(text: string, state: RedactionState): string {
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (!isBase64CoreChar(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && isBase64CoreChar(text.charCodeAt(index))) index += 1;
    const coreEnd = index;
    let padding = 0;
    while (padding < 2 && text.charCodeAt(index) === 61) {
      index += 1;
      padding += 1;
    }
    // Pure-hex runs are ids, hashes and evidence refs: never redacted.
    if (coreEnd - start >= LARGE_BASE64_MIN_LENGTH &&
        !PURE_HEX.test(text.slice(start, coreEnd)) &&
        hasBase64Boundary(text, start, index)) {
      output += text.slice(cursor, start);
      output += "[REDACTED:large_base64]";
      cursor = index;
      state.count += 1;
      state.kinds.add("large_base64");
    }
  }
  if (cursor === 0) return text;
  return output + text.slice(cursor);
}

function hasBase64Boundary(input: string, start: number, end: number): boolean {
  return !isAsciiWord(input.charCodeAt(start - 1)) && !isAsciiWord(input.charCodeAt(end));
}

function isBase64CoreChar(code: number): boolean {
  return (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47;
}

function isAsciiWord(code: number): boolean {
  return (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95;
}
