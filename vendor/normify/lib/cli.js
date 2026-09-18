#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createNormifyRuntime } from './generic.js';
import { addAccount, bindCloudflareEmail, deleteAccount, listAccounts, setAccountPassword } from './auth.js';
function usage() {
    return [
        'Normify local CLI',
        '',
        'Usage:',
        '  normify [--root <dir>] [--account <id>] [--no-bilingual] tools',
        '  normify [--root <dir>] [--account <id>] [--no-bilingual] call <tool> [json]',
        '  normify [--root <dir>] account list',
        '  normify [--root <dir>] account add <username>',
        '  normify [--root <dir>] account passwd <username>',
        '  normify [--root <dir>] account bind-email <username> <email>',
        '  normify [--root <dir>] account delete <username>',
        '',
        'If call JSON is omitted, JSON is read from stdin.',
        'Account add/passwd reads password from NORMIFY_PASSWORD.',
        'Environment: NORMIFY_ROOT, NORMIFY_ACCOUNT, NORMIFY_PASSWORD, NORMIFY_REQUIRE_BILINGUAL=0|1',
    ].join('\n');
}
function parseArgs(argv) {
    const args = [...argv];
    let rootDir = process.env.NORMIFY_ROOT;
    let accountId = process.env.NORMIFY_ACCOUNT;
    let requireBilingual = process.env.NORMIFY_REQUIRE_BILINGUAL !== '0';
    for (let i = 0; i < args.length;) {
        if (args[i] === '--root') {
            const value = args[i + 1];
            if (value === undefined)
                throw new Error('--root 缺少目录');
            rootDir = value;
            args.splice(i, 2);
            continue;
        }
        if (args[i] === '--no-bilingual') {
            requireBilingual = false;
            args.splice(i, 1);
            continue;
        }
        if (args[i] === '--account') {
            const value = args[i + 1];
            if (value === undefined || value.trim() === '')
                throw new Error('--account 缺少账号 id');
            accountId = value;
            args.splice(i, 2);
            continue;
        }
        i++;
    }
    return { args, rootDir, accountId, requireBilingual };
}
function readJson(raw) {
    const text = raw ?? (process.stdin.isTTY ? '{}' : readFileSync(0, 'utf8'));
    const parsed = JSON.parse(text.trim() === '' ? '{}' : text);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('工具参数必须是 JSON object');
    return parsed;
}
export async function main(argv = process.argv.slice(2)) {
    try {
        const { args, rootDir, accountId, requireBilingual } = parseArgs(argv);
        const resolvedRoot = resolve(rootDir ?? process.cwd());
        if (args[0] === 'account') {
            const action = args[1];
            const username = args[2];
            if (action === 'list') {
                process.stdout.write(JSON.stringify(await listAccounts(resolvedRoot), null, 2) + '\n');
                return 0;
            }
            if (username === undefined)
                throw new Error('account ' + String(action ?? '') + ' 缺少用户名');
            if (action === 'delete') {
                await deleteAccount(resolvedRoot, username);
                process.stdout.write('deleted ' + username + ' (project data preserved)\n');
                return 0;
            }
            if (action === 'bind-email') {
                const email = args[3];
                if (email === undefined)
                    throw new Error('account bind-email 缺少邮箱');
                await bindCloudflareEmail(resolvedRoot, username, email);
                process.stdout.write('cloudflare email bound for ' + username + '\n');
                return 0;
            }
            const password = process.env.NORMIFY_PASSWORD;
            if (password === undefined)
                throw new Error('请通过 NORMIFY_PASSWORD 提供密码');
            if (action === 'add') {
                process.stdout.write(JSON.stringify(await addAccount(resolvedRoot, username, password), null, 2) + '\n');
                return 0;
            }
            if (action === 'passwd') {
                await setAccountPassword(resolvedRoot, username, password);
                process.stdout.write('password updated for ' + username + '\n');
                return 0;
            }
            throw new Error('未知 account 操作：' + String(action));
        }
        const runtime = createNormifyRuntime({ rootDir, accountId, requireBilingual });
        const command = args[0];
        if (command === 'tools') {
            for (const tool of runtime.tools)
                process.stdout.write(tool.name + '\t' + tool.description + '\n');
            return 0;
        }
        if (command === 'call') {
            const name = args[1];
            if (name === undefined)
                throw new Error('call 缺少工具名');
            const result = await runtime.callTool(name, readJson(args[2]));
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            return typeof result === 'object' && result !== null && 'ok' in result && result.ok === false ? 1 : 0;
        }
        process.stderr.write(usage() + '\n');
        return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
    }
    catch (error) {
        process.stderr.write('normify: ' + (error instanceof Error ? error.message : String(error)) + '\n');
        return 2;
    }
}
const invokedPath = process.argv[1] === undefined ? '' : realpathSync(resolve(process.argv[1]));
if (invokedPath !== '' && invokedPath === fileURLToPath(import.meta.url))
    process.exitCode = await main();
//# sourceMappingURL=cli.js.map