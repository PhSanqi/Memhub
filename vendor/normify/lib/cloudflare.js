import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
const jwksByIssuer = new Map();
function pinPath(rootDir) {
    return join(resolve(rootDir), '.normify', 'cloudflare-access.json');
}
async function loadPin(rootDir) {
    try {
        const value = JSON.parse(await readFile(pinPath(rootDir), 'utf8'));
        if (value.version !== 1 || typeof value.issuer !== 'string' || typeof value.audience !== 'string')
            throw new Error('Cloudflare Access pin 格式无效');
        return value;
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function savePin(rootDir, value) {
    const path = pinPath(rootDir);
    await mkdir(dirname(path), { recursive: true });
    const temporary = path + '.tmp-' + process.pid + '-' + randomUUID();
    try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        await copyFile(path, path + '.bak').catch(error => {
            if (error?.code !== 'ENOENT')
                throw error;
        });
        await rename(temporary, path);
    }
    catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
function normalizeIssuer(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com'))
        throw new Error('Cloudflare issuer 必须是 *.cloudflareaccess.com 的 HTTPS 地址');
    return url.origin;
}
async function discoverIssuer(publicHost) {
    const response = await fetch(`https://${publicHost}/.well-known/oauth-authorization-server`, { redirect: 'error' });
    if (!response.ok)
        throw new Error('无法读取 Cloudflare OAuth metadata: HTTP ' + response.status);
    const metadata = await response.json();
    if (typeof metadata.issuer !== 'string')
        throw new Error('Cloudflare OAuth metadata 缺少 issuer');
    return normalizeIssuer(metadata.issuer);
}
function audienceOf(value) {
    const values = typeof value === 'string' ? [value] : value;
    const audience = values?.find(item => typeof item === 'string' && item.trim() !== '')?.trim();
    if (audience === undefined)
        throw new Error('Cloudflare JWT 缺少 aud');
    return audience;
}
export async function verifyCloudflareAccessJwt(rootDir, publicHost, token) {
    const pin = await loadPin(rootDir);
    const configuredIssuer = process.env.NORMIFY_CF_TEAM_DOMAIN?.trim();
    const issuer = normalizeIssuer(configuredIssuer && configuredIssuer !== '' ? configuredIssuer : pin?.issuer ?? await discoverIssuer(publicHost));
    if (pin !== null && pin.issuer !== issuer)
        throw new Error('Cloudflare issuer 与已固定配置不一致');
    let jwks = jwksByIssuer.get(issuer);
    if (jwks === undefined) {
        jwks = createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'));
        jwksByIssuer.set(issuer, jwks);
    }
    const configuredAudience = process.env.NORMIFY_CF_AUD?.trim();
    if (pin !== null && configuredAudience && configuredAudience !== '' && configuredAudience !== pin.audience)
        throw new Error('NORMIFY_CF_AUD 与已固定 audience 不一致');
    const expectedAudience = pin?.audience ?? (configuredAudience && configuredAudience !== '' ? configuredAudience : undefined);
    const { payload } = await jwtVerify(token, jwks, {
        issuer,
        ...(expectedAudience === undefined ? {} : { audience: expectedAudience }),
    });
    if (pin === null) {
        const audience = expectedAudience ?? audienceOf(payload.aud);
        await savePin(rootDir, { version: 1, issuer, audience });
        console.error('[normify-mcp] pinned Cloudflare Access issuer/audience');
    }
    if (typeof payload.sub !== 'string' || payload.sub.trim() === '')
        throw new Error('Cloudflare JWT 缺少 sub');
    if (typeof payload.email !== 'string' || payload.email.trim() === '')
        throw new Error('Cloudflare JWT 缺少 email');
    return { sub: payload.sub.trim(), email: payload.email.trim().toLowerCase() };
}
//# sourceMappingURL=cloudflare.js.map