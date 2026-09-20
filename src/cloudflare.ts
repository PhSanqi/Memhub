import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

interface CloudflarePin {
  version: 1;
  issuer: string;
  audience: string;
}

export interface CloudflareIdentity {
  sub: string;
  email: string;
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyCloudflareAccessJwt(
  stateRoot: string,
  publicHost: string,
  token: string
): Promise<CloudflareIdentity> {
  const pin = await loadPin(stateRoot);
  const configuredIssuer = process.env.MEMHUB_CF_TEAM_DOMAIN?.trim();
  const issuer = normalizeIssuer(configuredIssuer || pin?.issuer || await discoverIssuer(publicHost));
  if (pin && pin.issuer !== issuer) throw new Error("Cloudflare issuer 与已固定配置不一致");
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  const configuredAudience = process.env.MEMHUB_CF_AUD?.trim();
  if (pin && configuredAudience && configuredAudience !== pin.audience) {
    throw new Error("MEMHUB_CF_AUD 与已固定 audience 不一致");
  }
  const expectedAudience = pin?.audience ?? (configuredAudience || undefined);
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    ...(expectedAudience ? { audience: expectedAudience } : {})
  });
  if (!pin) {
    const audience = expectedAudience ?? audienceOf(payload.aud);
    await savePin(stateRoot, { version: 1, issuer, audience });
    console.error("[memhub] pinned Cloudflare Access issuer/audience");
  }
  if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new Error("Cloudflare JWT 缺少 sub");
  if (typeof payload.email !== "string" || !payload.email.trim()) throw new Error("Cloudflare JWT 缺少 email");
  return { sub: payload.sub.trim(), email: payload.email.trim().toLowerCase() };
}

function pinPath(stateRoot: string): string {
  return join(resolve(stateRoot), "cloudflare-access.json");
}

async function loadPin(stateRoot: string): Promise<CloudflarePin | null> {
  try {
    return validatePin(JSON.parse(await readFile(pinPath(stateRoot), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function validatePin(value: unknown): CloudflarePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloudflare Access pin 格式无效");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.issuer !== "string" || typeof record.audience !== "string") {
    throw new Error("Cloudflare Access pin 格式无效");
  }
  const issuer = normalizeIssuer(record.issuer);
  const audience = record.audience.trim();
  if (!audience) throw new Error("Cloudflare Access pin audience 为空");
  return { version: 1, issuer, audience };
}

async function savePin(stateRoot: string, value: CloudflarePin): Promise<void> {
  const path = pinPath(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await copyFile(path, `${path}.bak`).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) {
    throw new Error("Cloudflare issuer 必须是 *.cloudflareaccess.com HTTPS 地址");
  }
  return url.origin;
}

async function discoverIssuer(publicHost: string): Promise<string> {
  const response = await fetch(`https://${publicHost}/.well-known/oauth-authorization-server`, { redirect: "error" });
  if (!response.ok) throw new Error(`无法读取 Cloudflare OAuth metadata: HTTP ${response.status}`);
  const metadata = await response.json() as { issuer?: unknown };
  if (typeof metadata.issuer !== "string") throw new Error("Cloudflare OAuth metadata 缺少 issuer");
  return normalizeIssuer(metadata.issuer);
}

function audienceOf(value: string | string[] | undefined): string {
  const values = typeof value === "string" ? [value] : value;
  const audience = values?.find((item) => typeof item === "string" && item.trim())?.trim();
  if (!audience) throw new Error("Cloudflare JWT 缺少 aud");
  return audience;
}
