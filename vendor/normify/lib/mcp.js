#!/usr/bin/env node
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNormifyRuntime } from './generic.js';
import { authenticateAccount, hasAccounts, resolveCloudflareAccount } from './auth.js';
import { verifyCloudflareAccessJwt } from './cloudflare.js';
import { listProjects, resolveProject } from './engine/store.js';
const VERSION = '0.5.4';
function resultText(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function failed(value) {
    return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}
export function createNormifyMcpServer(options = {}) {
    const runtime = createNormifyRuntime(options);
    const server = new McpServer({
        name: 'normify',
        version: VERSION,
        description: 'Normify architecture source-of-truth tools',
    });
    server.registerTool('normify_project_use', {
        description: '选择或切换当前 Project。用户未明确具体工程时不要猜：省略 project 调用本工具，返回当前账号可用 Project 列表，再把列表展示给用户选择。切换后其它 Normify 工具默认使用该项目。',
        inputSchema: fromJsonSchema({
            type: 'object',
            properties: { project: { type: 'string', description: '可选 Project slug；用户未明确工程时省略，用于列出可选 Project' } },
            additionalProperties: false,
        }),
    }, async (args) => {
        const project = typeof args.project === 'string' ? args.project.trim() : '';
        const available = listProjects(runtime.env.rootDir, { accountId: runtime.env.accountId }).map(item => item.slug);
        if (project === '') {
            if (available.length === 1) {
                runtime.env.currentProject = available[0];
                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, selected: true, current_project: available[0], projects: available, message: '当前账号只有一个 Project，已自动选择。' }, null, 2) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, selected: false, selection_required: available.length > 0, current_project: runtime.env.currentProject ?? null, projects: available, message: available.length > 0 ? '用户未明确具体工程，请把 projects 列表展示给用户选择后，再用选中的 project 调用 normify_project_use。' : '当前账号没有可用 Project。' }, null, 2) }] };
        }
        try {
            const ref = await resolveProject(runtime.env.rootDir, { project }, { accountId: runtime.env.accountId });
            runtime.env.currentProject = ref.slug;
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, selected: true, current_project: ref.slug, projects: available }, null, 2) }] };
        }
        catch (error) {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, selected: false, selection_required: available.length > 0, requested_project: project, current_project: runtime.env.currentProject ?? null, projects: available, message: available.length > 0 ? '没有找到明确匹配的 Project，请把 projects 列表展示给用户选择。' : '当前账号没有可用 Project。', detail: error instanceof Error ? error.message : String(error) }, null, 2) }] };
        }
    });
    for (const tool of runtime.tools) {
        const schema = structuredClone(tool.parameters ?? {
            type: 'object',
            properties: {},
            additionalProperties: false,
        });
        if (tool.name !== 'normify_project_init' && schema.properties !== undefined) {
            delete schema.properties.project;
            delete schema.properties.dir;
            if (Array.isArray(schema.required))
                schema.required = schema.required.filter(name => name !== 'project' && name !== 'dir');
        }
        const inputSchema = fromJsonSchema(schema);
        server.registerTool(tool.name, {
            description: tool.description,
            inputSchema,
        }, async (args) => {
            const value = await tool.execute(args);
            return {
                content: [{ type: 'text', text: resultText(value) }],
                ...(failed(value) ? { isError: true } : {}),
            };
        });
    }
    return server;
}
function parseArgs(argv) {
    let rootDir = process.env.NORMIFY_ROOT;
    let username = process.env.NORMIFY_USER;
    let password = process.env.NORMIFY_PASSWORD;
    let requireBilingual = process.env.NORMIFY_REQUIRE_BILINGUAL !== '0';
    let httpPort;
    let httpPath = process.env.NORMIFY_HTTP_PATH ?? '/mcp';
    let publicHost = process.env.NORMIFY_PUBLIC_HOST;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--root') {
            rootDir = argv[++i];
            if (rootDir === undefined)
                throw new Error('--root 缺少目录');
        }
        else if (arg === '--user') {
            username = argv[++i];
            if (username === undefined || username.trim() === '')
                throw new Error('--user 缺少用户名');
        }
        else if (arg === '--password') {
            password = argv[++i];
            if (password === undefined)
                throw new Error('--password 缺少密码');
        }
        else if (arg === '--no-bilingual') {
            requireBilingual = false;
        }
        else if (arg === '--http') {
            const raw = argv[++i] ?? '3000';
            httpPort = Number(raw);
            if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535)
                throw new Error('--http 端口无效：' + raw);
        }
        else if (arg === '--http-path') {
            const raw = argv[++i];
            if (raw === undefined || !raw.startsWith('/') || raw.includes('?') || raw.includes('#'))
                throw new Error('--http-path 必须是以 / 开头的路径');
            httpPath = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
        }
        else if (arg === '--public-host') {
            const raw = argv[++i]?.trim();
            if (raw === undefined || raw === '' || raw.includes('/') || raw.includes(':'))
                throw new Error('--public-host 必须是纯主机名，例如 plugin.example.com');
            publicHost = raw.toLowerCase();
        }
        else if (arg === '--help' || arg === '-h') {
            process.stdout.write([
                'Usage: normify-mcp [--root <dir>] [--user <name>] [--password <secret>] [--no-bilingual] [--http <port>] [--http-path <path>] [--public-host <hostname>]',
                'HTTP public mode trusts Cloudflare Access after validating Cf-Access-Jwt-Assertion.',
                'NORMIFY_USER / NORMIFY_PASSWORD are only needed for stdio mode.',
                '',
                'Default transport: stdio',
                'HTTP binds only to 127.0.0.1 and serves /mcp by default.',
            ].join('\n') + '\n');
            process.exit(0);
        }
        else {
            throw new Error('未知参数：' + arg);
        }
    }
    return { rootDir, username, password, requireBilingual, httpPort, httpPath, publicHost };
}
async function serveHttp(options, port, path, publicHost) {
    const rootDir = resolve(options.rootDir ?? process.cwd());
    const handlers = new Map();
    const projectSelections = new Map();
    const validateHost = publicHost === undefined
        ? localhostHostValidation()
        : hostHeaderValidation(['localhost', '127.0.0.1', '[::1]', publicHost]);
    const validateOrigin = publicHost === undefined
        ? localhostOriginValidation()
        : originValidation(['localhost', '127.0.0.1', '[::1]', publicHost]);
    const handlerFor = (accountId) => {
        const key = accountId ?? '__local__';
        let nodeHandler = handlers.get(key);
        if (nodeHandler !== undefined)
            return nodeHandler;
        let projectSelection = projectSelections.get(key);
        if (projectSelection === undefined) {
            projectSelection = {};
            projectSelections.set(key, projectSelection);
        }
        const handler = createMcpHandler(() => createNormifyMcpServer({ ...options, rootDir, projectSelection, ...(accountId === undefined ? {} : { accountId }) }));
        nodeHandler = toNodeHandler(handler, {
            onerror: error => console.error('[normify-mcp] HTTP error:', error.message),
        });
        handlers.set(key, nodeHandler);
        return nodeHandler;
    };
    const http = createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (!validateHost(req, res) || !validateOrigin(req, res))
                return;
            if (url.pathname !== path) {
                res.writeHead(404).end();
                return;
            }
            if (publicHost === undefined) {
                handlerFor(options.accountId)(req, res);
                return;
            }
            const assertion = req.headers['cf-access-jwt-assertion'];
            if (typeof assertion !== 'string' || assertion === '') {
                res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ error: 'missing_cloudflare_access_jwt' }));
                return;
            }
            const identity = await verifyCloudflareAccessJwt(rootDir, publicHost, assertion);
            const account = await resolveCloudflareAccount(rootDir, identity);
            handlerFor(account.account_id)(req, res);
        })().catch(error => {
            console.error('[normify-mcp] HTTP auth error:', error);
            if (!res.headersSent) {
                const message = error instanceof Error ? error.message : String(error);
                const legacyBindingRequired = message.includes('account bind-email');
                res.writeHead(legacyBindingRequired ? 409 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ error: legacyBindingRequired ? 'legacy_account_binding_required' : 'cloudflare_identity_rejected', message }));
                return;
            }
            res.end();
        });
    });
    await new Promise((resolveReady, reject) => {
        http.once('error', reject);
        http.listen(port, '127.0.0.1', () => resolveReady());
    });
    const address = http.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    console.error('[normify-mcp] listening on http://127.0.0.1:' + actualPort + path);
    if (publicHost !== undefined)
        console.error('[normify-mcp] Cloudflare Access identity mode enabled for https://' + publicHost + path);
}
export async function main(argv = process.argv.slice(2)) {
    const { httpPort, httpPath = '/mcp', publicHost, username, password, ...options } = parseArgs(argv);
    const rootDir = resolve(options.rootDir ?? process.cwd());
    if (httpPort !== undefined) {
        await serveHttp({ ...options, rootDir }, httpPort, httpPath, publicHost);
        return;
    }
    let accountId;
    if (username !== undefined || password !== undefined) {
        if (username === undefined || password === undefined)
            throw new Error('MCP 账号需要同时提供用户名和密码');
        accountId = await authenticateAccount(rootDir, username, password) ?? undefined;
        if (accountId === undefined)
            throw new Error('Normify 用户名或密码错误');
    }
    else if (await hasAccounts(rootDir)) {
        throw new Error('Normify 已启用账号隔离，请提供 NORMIFY_USER / NORMIFY_PASSWORD');
    }
    const runtimeOptions = { ...options, rootDir, projectSelection: {}, ...(accountId === undefined ? {} : { accountId }) };
    console.error('[normify-mcp] serving over stdio');
    await serveStdio(() => createNormifyMcpServer(runtimeOptions));
}
const invokedPath = process.argv[1] === undefined ? '' : realpathSync(resolve(process.argv[1]));
if (invokedPath !== '' && invokedPath === fileURLToPath(import.meta.url))
    await main();
//# sourceMappingURL=mcp.js.map