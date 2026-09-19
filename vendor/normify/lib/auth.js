import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const VERSION = 1;
function filePath(rootDir) {
    return join(resolve(rootDir), '.normify', 'accounts.json');
}
function usernameOf(value) {
    const username = value.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username))
        throw new Error('用户名只能包含字母、数字、点、下划线或连字符，长度 1..64');
    return username;
}
function passwordOf(value) {
    if (value.length < 8)
        throw new Error('密码至少需要 8 个字符');
    return value;
}
function emailOf(value) {
    const email = value.trim().toLowerCase();
    if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email))
        throw new Error('Cloudflare 邮箱格式无效');
    return email;
}
let mutationTail = Promise.resolve();
async function withMutationLock(run) {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise(resolveLock => { release = resolveLock; });
    await previous;
    try {
        return await run();
    }
    finally {
        release();
    }
}
async function load(rootDir) {
    try {
        const data = JSON.parse(await readFile(filePath(rootDir), 'utf8'));
        if (data?.version !== VERSION || data.accounts === null || typeof data.accounts !== 'object' || Array.isArray(data.accounts))
            throw new Error('账号数据库格式无效');
        return data;
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { version: VERSION, accounts: {} };
        throw error;
    }
}
async function save(rootDir, data) {
    const path = filePath(rootDir);
    await mkdir(dirname(path), { recursive: true });
    const temporary = path + '.tmp-' + process.pid + '-' + randomUUID();
    try {
        await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
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
async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const derived = await scrypt(passwordOf(password), salt, 32);
    return { salt, hash: derived.toString('hex') };
}
export async function hasAccounts(rootDir) {
    return Object.keys((await load(rootDir)).accounts).length > 0;
}
export async function listAccounts(rootDir) {
    const data = await load(rootDir);
    return Object.entries(data.accounts)
        .map(([username, record]) => ({ username, account_id: record.account_id, created_at: record.created_at, ...(record.cloudflare === undefined ? {} : { cloudflare_email: record.cloudflare.email }) }))
        .sort((a, b) => a.username.localeCompare(b.username));
}
export async function addAccount(rootDir, usernameRaw, password) {
    const username = usernameOf(usernameRaw);
    return withMutationLock(async () => {
        const data = await load(rootDir);
        if (data.accounts[username] !== undefined)
            throw new Error('账号已存在：' + username);
        const passwordData = await hashPassword(password);
        const accountId = randomUUID();
        data.accounts[username] = {
            account_id: accountId,
            salt: passwordData.salt,
            password_hash: passwordData.hash,
            created_at: new Date().toISOString(),
        };
        await save(rootDir, data);
        return { username, account_id: accountId };
    });
}
export async function setAccountPassword(rootDir, usernameRaw, password) {
    const username = usernameOf(usernameRaw);
    await withMutationLock(async () => {
        const data = await load(rootDir);
        const record = data.accounts[username];
        if (record === undefined)
            throw new Error('账号不存在：' + username);
        const passwordData = await hashPassword(password);
        record.salt = passwordData.salt;
        record.password_hash = passwordData.hash;
        await save(rootDir, data);
    });
}
export async function deleteAccount(rootDir, usernameRaw) {
    const username = usernameOf(usernameRaw);
    await withMutationLock(async () => {
        const data = await load(rootDir);
        if (data.accounts[username] === undefined)
            throw new Error('账号不存在：' + username);
        delete data.accounts[username];
        await save(rootDir, data);
    });
}
export async function authenticateAccount(rootDir, usernameRaw, password) {
    const username = usernameOf(usernameRaw);
    const record = (await load(rootDir)).accounts[username];
    if (record === undefined || record.salt === undefined || record.password_hash === undefined)
        return null;
    const derived = await scrypt(password, record.salt, 32);
    const expected = Buffer.from(record.password_hash, 'hex');
    return expected.length === derived.length && timingSafeEqual(expected, derived) ? record.account_id : null;
}
export async function bindCloudflareEmail(rootDir, usernameRaw, emailRaw) {
    const username = usernameOf(usernameRaw);
    const email = emailOf(emailRaw);
    await withMutationLock(async () => {
        const data = await load(rootDir);
        const record = data.accounts[username];
        if (record === undefined)
            throw new Error('账号不存在：' + username);
        const conflict = Object.entries(data.accounts).find(([otherUsername, other]) => otherUsername !== username && other.cloudflare?.email === email);
        if (conflict !== undefined)
            throw new Error('该 Cloudflare 邮箱已绑定账号：' + conflict[0]);
        if (record.cloudflare?.email === email)
            return;
        record.cloudflare = { email, ...(record.cloudflare?.sub === undefined ? {} : { sub: record.cloudflare.sub }) };
        await save(rootDir, data);
    });
}
export async function resolveCloudflareAccount(rootDir, identity) {
    const sub = identity.sub.trim();
    const email = emailOf(identity.email);
    if (sub === '' || sub.length > 512)
        throw new Error('Cloudflare sub 无效');
    return withMutationLock(async () => {
        const data = await load(rootDir);
        const entries = Object.entries(data.accounts);
        const bySub = entries.find(([, record]) => record.cloudflare?.sub === sub);
        if (bySub !== undefined) {
            const [username, record] = bySub;
            if (record.cloudflare.email !== email) {
                const conflict = entries.find(([otherUsername, other]) => otherUsername !== username && other.cloudflare?.email === email);
                if (conflict !== undefined)
                    throw new Error('Cloudflare 身份冲突：新邮箱已绑定其他账号');
                record.cloudflare.email = email;
                await save(rootDir, data);
            }
            return { username, account_id: record.account_id, created: false };
        }
        const byEmail = entries.find(([, record]) => record.cloudflare?.email === email);
        if (byEmail !== undefined) {
            const [username, record] = byEmail;
            record.cloudflare = { email, sub };
            await save(rootDir, data);
            return { username, account_id: record.account_id, created: false };
        }
        if (entries.length === 1 && entries[0][1].cloudflare === undefined)
            throw new Error('现有唯一账号尚未绑定 Cloudflare 邮箱；请先在本机执行 account bind-email，避免误建第二套 Project 空间');
        const username = 'cf-' + createHash('sha256').update(email).digest('hex').slice(0, 32);
        if (data.accounts[username] !== undefined)
            throw new Error('Cloudflare JIT 账号键冲突');
        const accountId = randomUUID();
        data.accounts[username] = {
            account_id: accountId,
            created_at: new Date().toISOString(),
            cloudflare: { email, sub },
        };
        await save(rootDir, data);
        return { username, account_id: accountId, created: true };
    });
}
//# sourceMappingURL=auth.js.map