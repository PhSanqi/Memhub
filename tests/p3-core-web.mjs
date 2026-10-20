import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { addAccount, setAccountRole, ensureLocalAdminToken } from '../dist/auth.js';
import { testEnvironment } from './test-isolation.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { readFile, writeFile, utimes, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';
import { migrate } from '../vendor/memory-core/src/storage/schema.js';
import { Repositories, MemoryFtsSearchError } from '../vendor/memory-core/src/storage/repositories.js';
import { MemoryService } from '../vendor/memory-core/src/service/memory-service.js';
import { MemoryDb } from '../vendor/memory-core/src/storage/db.js';
import { attachMemoryVector, memoryVector } from '../vendor/memory-core/src/storage/memory-vector-state.js';
import { acquireUserServiceLock, acquireSqliteServerLock } from '../vendor/memory-core/src/server/index.js';
import { createMemoryHttpServer, closeMemoryHttpServer } from '../vendor/memory-core/src/server/http.js';
import { LocalMemoryRestClient, MemoryCoreHttpError } from '../dist/local-memory-client.js';
import { webPath, webRoutePath, webSecurityHeaders } from '../dist/gateway-http.js';
import { renderConsole, renderDocs, renderLanding, renderUnprovisionedAccount } from '../dist/web-ui.js';
import { handleMemoryControlAction } from '../dist/memory-control-actions.js';
import { createMemhubRuntime } from '../dist/runtime.js';
import { recordCompletedDistillationRevision, listDistillationJobs, retireDistillationMemory } from '../dist/distillation-jobs.js';
import { hydrateMemoryEvidence } from '../dist/memory-hydration.js';

const root = await createTestRoot('p3-core-web-');
isolateTestEnvironment(root, join(root, 'architecture'));
const at = '2026-10-18T00:00:00.000Z';
function database() {
  const db = new Database(':memory:');
  db.loadExtension(getLoadablePath());
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
function memory(id, body = 'original searchable content') {
  return { id, timeline: at, userId: 'p3', memoryType: 'fact', status: 'activated', visibility: 'private',
    memoryValue: body, memoryLayer: 'L3', tags: [], info: {}, properties: { internal_info: {} },
    version: 1, createdAt: at, updatedAt: at };
}
class Response extends EventEmitter {
  headers = {}; statusCode = 200;
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); return this; }
  end(body) { this.body = body ?? ''; this.emit('finish'); return this; }
}
async function dispatch(server, path, method, headers = {}, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { url: path, method, headers: { host: '127.0.0.1', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' } });
  const res = new Response();
  const finished = new Promise(done => res.once('finish', done));
  server.emit('request', req, res);
  await finished;
  return res;
}

test('MC-01/06 viewer header cannot authenticate Core writes; bearer client add/session/delete works', async () => {
  const calls = [];
  const service = {
    idempotent: async (_kind, _request, _payload, fn) => fn(),
    async addMemory() { calls.push('add'); return { id: 'added' }; },
    async openSession() { calls.push('session'); return { sessionId: 'opened' }; },
    async deleteMemory() { calls.push('delete'); return { deleted: true }; },
    archiveMemory() { calls.push('archive'); return { ok: true }; }
  };
  const server = createMemoryHttpServer({ service, apiKey: 'p3-secret',
    agentSourceExecutor: { dispose: async () => {} } });
  try {
    for (const path of ['/api/v1/memory/add', '/api/v1/sessions/open', '/api/v1/admin/shutdown', '/api/v1/memory/id/archive']) {
      const res = await dispatch(server, path, 'POST', { 'x-memmy-viewer': '1' }, { content: 'test' });
      assert.equal(res.statusCode, 401, path);
      const wrong = await dispatch(server, path, 'POST', { 'x-memmy-viewer': '1', authorization: 'Bearer wrong' }, { content: 'test' });
      assert.equal(wrong.statusCode, 401, path);
    }
    assert.deepEqual(calls, []);
    const seen = [];
    const client = new LocalMemoryRestClient({ endpoint: 'http://127.0.0.1', token: 'p3-secret', fetchImpl: async (url, init) => {
      seen.push({ path: new URL(url).pathname, headers: init.headers });
      const res = await dispatch(server, new URL(url).pathname, init.method, init.headers, init.body ? JSON.parse(init.body) : undefined);
      return new globalThis.Response(res.body, { status: res.statusCode });
    } });
    await client.addMemory({ content: 'test' });
    await client.openSession({});
    await client.viewerDelete('/api/v1/memory/id');
    assert.deepEqual(calls, ['add', 'session', 'delete']);
    assert.ok(seen.every(call => call.headers.authorization === 'Bearer p3-secret'));
    assert.ok(seen.slice(0, 2).every(call => !call.headers['x-memmy-viewer']));
    assert.equal(seen[2].headers['x-memmy-viewer'], '1');
    assert.equal((await dispatch(server, '/api/v1/telemetry/viewer-opened', 'POST', { 'x-memmy-viewer': '1', authorization: 'Bearer p3-secret' }, {})).statusCode, 200);
  } finally { await closeMemoryHttpServer(server); }
});

test('MC-02 fresh empty/malformed locks are held; old incomplete locks recover', async () => {
  const home = join(root, 'incomplete'); await mkdir(home);
  const path = join(home, 'service.lock');
  for (const value of ['', '{', '{}', 'null']) {
    await writeFile(path, value);
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /starting/);
    assert.equal(await readFile(path, 'utf8'), value);
  }
  await utimes(path, new Date(0), new Date(0));
  const lock = acquireUserServiceLock({ serviceHome: home });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
  lock.release();
});

test('MC-02 two concurrent acquirers produce exactly one owner', async () => {
  const home = join(root, 'race'); await mkdir(home);
  const code = `import { acquireUserServiceLock } from ${JSON.stringify(new URL('../vendor/memory-core/src/server/index.js', import.meta.url).href)};
    process.on('message', () => { try { const lock = acquireUserServiceLock({serviceHome: process.argv[1]});
      process.send('owner'); process.on('message', () => {lock.release(); process.exit(0)});
    } catch { process.send('held'); process.exit(0); } }); process.send('ready');`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', code, home], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  const output = [];
  for (const child of children) { child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk)); }
  try {
    await Promise.all(children.map(child => new Promise(done => child.once('message', done))));
    const results = children.map(child => new Promise(done => child.once('message', done)));
    children.forEach(child => child.send('go'));
    const states = await Promise.all(results);
    assert.deepEqual(states.sort(), ['held', 'owner']);
    assert.ok(JSON.parse(await readFile(join(home, 'service.lock'), 'utf8')).pid > 0);
  } finally {
    children.forEach(child => { if (child.connected) child.send('release'); });
    await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(done => child.once('exit', done))));
  }
});

test('P3-P2 release preserves foreign locks even with a reused pid or token', async () => {
  for (const kind of ['service', 'sqlite']) {
    const home = join(root, `foreign-lock-${kind}`); await mkdir(home);
    const acquire = () => kind === 'service' ? acquireUserServiceLock({ serviceHome: home })
      : acquireSqliteServerLock({ sqlitePath: join(home, 'memory.sqlite') });
    for (const changed of ['pid', 'token']) {
      const lock = acquire();
      const owner = JSON.parse(await readFile(lock.path, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.token, 'string');
      const foreign = { ...owner, [changed]: changed === 'pid' ? 2147483647 : `${owner.token}-foreign` };
      await writeFile(lock.path, JSON.stringify(foreign));
      lock.release();
      lock.release();
      assert.deepEqual(JSON.parse(await readFile(lock.path, 'utf8')), foreign);
      fs.unlinkSync(lock.path);
    }
    const lock = acquire();
    await mkdir(`${lock.path}.guard`);
    lock.release();
    assert.equal(fs.existsSync(lock.path), false);
    assert.equal(fs.existsSync(`${lock.path}.guard`), true, 'release must not depend on a contender releasing its guard');
  }
});

test('P3-P2 guard serializes stale claim and fresh create while the lock path is absent', async () => {
  const home = join(root, 'claim-create'); await mkdir(home);
  const path = join(home, 'service.lock');
  await writeFile(path, '{'); await utimes(path, new Date(0), new Date(0));
  const rename = fs.renameSync;
  let blocked = 0;
  fs.renameSync = (source, target) => {
    const result = rename(source, target);
    if (source === path) {
      assert.equal(fs.existsSync(path), false);
      assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /update in progress/);
      blocked++;
    }
    return result;
  };
  syncBuiltinESMExports();
  let lock;
  try {
    lock = acquireUserServiceLock({ serviceHome: home });
    assert.equal(blocked, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /already served/);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); lock?.release(); }
});

test('P3-P2 guard blocks create during changed-claim restore', async () => {
  const home = join(root, 'claim-restore'); await mkdir(home);
  const path = join(home, 'service.lock');
  await writeFile(path, '{'); await utimes(path, new Date(0), new Date(0));
  const rename = fs.renameSync, link = fs.linkSync;
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  let blocked = 0;
  fs.renameSync = (source, target) => {
    if (source === path) { fs.unlinkSync(path); fs.writeFileSync(path, replacement); }
    return rename(source, target);
  };
  fs.linkSync = (source, target) => {
    if (source.startsWith(`${path}.stale-`)) {
      assert.equal(fs.existsSync(path), false);
      assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /update in progress/);
      blocked++;
    }
    return link(source, target);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /changed during stale recovery/);
    assert.equal(blocked, 1);
    assert.equal(await readFile(path, 'utf8'), replacement);
  } finally { fs.renameSync = rename; fs.linkSync = link; syncBuiltinESMExports(); }
});

test('P3-P2 guard recovers abandoned owners after five seconds and preserves live owners', async () => {
  for (const owner of ['empty', 'dead', 'live']) {
    const home = join(root, `guard-${owner}`); await mkdir(home);
    const guard = join(home, 'service.lock.guard'); await mkdir(guard);
    if (owner !== 'empty') await writeFile(join(guard, `${owner === 'dead' ? 2147483647 : process.pid}.test`), '');
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /update in progress/);
    const stale = new Date(Date.now() - 10_000);
    await utimes(guard, stale, stale);
    if (owner === 'live') {
      assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /update in progress/);
      assert.equal(fs.existsSync(guard), true);
    } else {
      const lock = acquireUserServiceLock({ serviceHome: home });
      assert.equal(fs.existsSync(guard), false);
      lock.release();
    }
  }
});

test('P3-P2 guard reclaims a live unrelated PID beyond sixty seconds in either clock direction', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
  try {
    for (const offset of [-65_000, 65_000]) {
      const home = join(root, `guard-clock-${offset}`); await mkdir(home);
      const guard = join(home, 'service.lock.guard'); await mkdir(guard);
      await writeFile(join(guard, `${child.pid}.test`), '');
      const stale = new Date(Date.now() + offset);
      await utimes(guard, stale, stale);
      process.kill(child.pid, 0);
      const lock = acquireUserServiceLock({ serviceHome: home });
      assert.equal(fs.existsSync(guard), false);
      process.kill(child.pid, 0);
      lock.release();
    }
  } finally {
    const exited = new Promise(done => child.once('exit', done));
    child.kill();
    await exited;
  }
});

test('P3-F1 native existing hard-link target is EEXIST, including Windows', async () => {
  const home = join(root, 'native-link'); await mkdir(home);
  const source = join(home, 'source'), target = join(home, 'target');
  await writeFile(source, 'owner');
  fs.linkSync(source, target);
  assert.throws(() => fs.linkSync(source, target), { code: 'EEXIST' });
  const lockHome = join(home, 'held');
  const lock = acquireUserServiceLock({ serviceHome: lockHome });
  try { assert.throws(() => acquireUserServiceLock({ serviceHome: lockHome }), /already served/); }
  finally { lock.release(); }
});

test('P3-F1 EPERM is held only if the target exists', async () => {
  const home = join(root, 'eperm'); await mkdir(home);
  const link = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), { code: 'EPERM' });
    await writeFile(join(home, 'service.lock'), JSON.stringify({ pid: process.pid }));
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /already served/);
  } finally { fs.linkSync = link; syncBuiltinESMExports(); }
});

test('P3-F7 stale claim revalidates moved identity and restores a replacement owner', async () => {
  const home = join(root, 'stale-replaced'); await mkdir(home);
  const path = join(home, 'service.lock');
  await writeFile(path, '{'); await utimes(path, new Date(0), new Date(0));
  const rename = fs.renameSync;
  const replacement = JSON.stringify({ pid: process.pid, startedAt: at });
  fs.renameSync = (source, target) => {
    if (source === path) {
      fs.unlinkSync(path);
      fs.writeFileSync(path, replacement);
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireUserServiceLock({ serviceHome: home }), /changed during stale recovery/);
    assert.equal(await readFile(path, 'utf8'), replacement);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
});

test('P3-F5 getMany preserves requested relevance order across storage order and missing ids', () => {
  const db = database(); const repos = new Repositories(db);
  try {
    for (const id of ['z', 'a', 'm']) repos.memories.insert(memory(id));
    assert.deepEqual(repos.memories.getMany(['m', 'absent', 'z', 'a']).map(row => row.id), ['m', 'z', 'a']);
  } finally { db.close(); }
});

test('MC-03 insert rolls back row/vectors/FTS after injected vector failure', () => {
  const db = database(); const repos = new Repositories(db);
  try {
    const original = repos.memories.vectors.replace.bind(repos.memories.vectors);
    repos.memories.vectors.replace = (...args) => { original(...args); throw new Error('injected vector failure'); };
    const value = attachMemoryVector(memory('failed'), { vectorField: 'vec', vector: [1, 0] });
    assert.throws(() => repos.memories.insert(value), /injected vector/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_vector_entries').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n, 0);
  } finally { db.close(); }
});

test('MC-03/08 FTS failures preserve insert/update rows and vectors, log once and flag repair', () => {
  const db = database(); const repos = new Repositories(db);
  const warn = console.warn; let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    repos.memories.insert(attachMemoryVector(memory('stable'), { vectorField: 'vec', vector: [1, 0] }));
    // Failure follows both the row and vector updates, exercising the whole outer transaction.
    const reindex = repos.memories.reindexFts.bind(repos.memories);
    repos.memories.reindexFts = memory => {
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(memory.id);
      throw new Error('injected FTS failure');
    };
    repos.memories.update(attachMemoryVector(memory('stable', 'changed'), { vectorField: 'vec', vector: [0, 1] }));
    assert.equal(repos.memories.get('stable').memoryValue, 'changed');
    assert.deepEqual(memoryVector(repos.memories.get('stable'), 'vec'), [0, 1]);
    repos.memories.insert(attachMemoryVector(memory('new'), { vectorField: 'vec', vector: [1, 0] }));
    assert.deepEqual(memoryVector(repos.memories.get('new'), 'vec'), [1, 0]);
    assert.deepEqual([...repos.memories.pendingFtsRepairs], ['stable', 'new']);
    assert.equal(warnings, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n, 1);
    repos.memories.reindexFts = reindex;
    for (const id of [...repos.memories.pendingFtsRepairs]) reindex(repos.memories.get(id));
    assert.equal(repos.memories.pendingFtsRepairs.size, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n, 2);
  } finally { console.warn = warn; db.close(); }
});

test('MC-08 real FTS write failure persists and flags; search still throws typed error', () => {
  const db = database(); const repos = new Repositories(db);
  try {
    db.exec('DROP TABLE memories_fts');
    repos.memories.insert(memory('fts-missing'));
    assert.equal(repos.memories.get('fts-missing').id, 'fts-missing');
    assert.ok(repos.memories.pendingFtsRepairs.has('fts-missing'));
    assert.throws(() => repos.memories.searchFtsIds('content'), MemoryFtsSearchError);
  } finally { db.close(); }
});

test('P3-F2 bounded FTS repair queue is exposed in health and existing reindex clears ids', () => {
  const db = new MemoryDb({ path: ':memory:' }); const service = new MemoryService({ db });
  try {
    service.repos.memories.insert(memory('health-fts'));
    const reindex = service.repos.memories.reindexFts.bind(service.repos.memories);
    service.repos.memories.reindexFts = () => { throw new Error('FTS unavailable'); };
    // Fill the bounded diagnostic set without writing a thousand unrelated rows.
    for (let i = 0; i < 1000; i++) service.repos.memories.pendingFtsRepairs.add(`queued-${i}`);
    service.repos.memories.update(memory('health-fts'));
    const repair = service.health().storage.ftsRepair;
    assert.equal(repair.pendingIds.length, 1000);
    assert.equal(repair.fullReindexRequired, true);
    service.repos.memories.pendingFtsRepairs.clear();
    service.repos.memories.pendingFtsRepairs.add('health-fts');
    reindex(service.repos.memories.get('health-fts'));
    assert.deepEqual(service.health().storage.ftsRepair.pendingIds, []);
  } finally { db.close(); }
});

test('MC-04 sqlite-vec filters eligible rows before top-k across tenants and projects', () => {
  const db = database(); const repos = new Repositories(db);
  try {
    for (let i = 0; i < 20; i++) repos.memories.insert(attachMemoryVector(memory(`other-${i}`), { vectorField: 'vec', vector: [1, 0.001 * i] }));
    repos.memories.insert(attachMemoryVector(memory('eligible'), { vectorField: 'vec', vector: [0.1, 1] }));
    const candidate = db.prepare("SELECT id, memory_id memoryId, embedding_dim embeddingDim FROM memory_vector_entries WHERE memory_id='eligible'").get();
    const hits = repos.memories.vectors.search([1, 0], [candidate], 1);
    assert.deepEqual(hits.map(hit => hit.id), ['eligible']);
  } finally { db.close(); }
});

test('MC-05 API retention throttles prune and uses the rowid index', async () => {
  const db = database(); const repos = new Repositories(db);
  try {
    const runtime = repos.runtime;
    const insert = db.prepare("INSERT INTO api_logs(tool_name, input_json, output_json, duration_ms, success, called_at) VALUES ('memory_add', '{}', '{}', 1, 1, ?)");
    db.transaction(() => { for (let i = 0; i < 10001; i++) insert.run(at); })();
    let prunes = 0; const prune = runtime.pruneLogTable.bind(runtime);
    runtime.pruneLogTable = table => { prunes++; return prune(table); };
    for (let i = 0; i < 1001; i++) {
      runtime.insertApiLog({ toolName: 'memory_add', inputJson: '{}', outputJson: '{}', durationMs: 1, success: true, calledAt: at });
      await new Promise(done => setImmediate(done));
    }
    assert.equal(prunes, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM api_logs').get().n, 10000);
    const plan = db.prepare('EXPLAIN QUERY PLAN DELETE FROM api_logs WHERE rowid < (SELECT rowid FROM api_logs ORDER BY rowid DESC LIMIT 1 OFFSET 9999)').all();
    assert.ok(plan.some(row => /SEARCH api_logs USING INTEGER PRIMARY KEY/.test(row.detail)));
    assert.ok(plan.every(row => !/TEMP B-TREE/.test(row.detail)));
  } finally { db.close(); }
});

test('WEB-02 base path URLs preserve text and normalize MCP trailing slash first', async t => {
  const account = { account_id: 'p3', username: 'keep /memhub/user text', role: 'user' };
  for (const base of ['/', '/memhub', '/custom/nested']) {
    const html = renderConsole({ account, accounts: [], projects: [], selectedAccountId: 'p3', adminView: false, localControl: true, basePath: base });
    assert.ok(html.includes(account.username));
    assert.ok(html.includes(`href="${webPath(base, '/user')}"`));
    assert.ok(html.includes(`const API=${JSON.stringify(webPath(base, '/user/api'))}`));
    assert.equal(webRoutePath(webPath(base, '/user/api'), base, '/mcp'), '/memhub/user/api');
    assert.equal(webRoutePath('/mcp/', base, '/mcp'), '/mcp');
    if (base !== '/') assert.equal(webRoutePath(`${base}/`, base, '/mcp'), '/memhub', 'trailing-slash base is the console root');
    for (const rendered of [html, renderLanding(base), renderDocs('/memhub/docs', base), renderUnprovisionedAccount('keep /memhub/ content', base)]) {
      assert.ok(rendered.includes(`href="${webPath(base)}"`));
      await t.test('rendered script syntax '+base+' '+rendered.match(/<title>(.*?)<\/title>/)[1], () => {
        for (const script of rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
      });
    }
  }
  assert.equal(webRoutePath('/memhub/user', '/custom', '/mcp'), '');
});

test('WEB-04 HTML CSP pins scripts and API/actions are no-store/nosniff', async () => {
  const html = renderLanding('/');
  const headers = webSecurityHeaders(html);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.ok(headers['content-security-policy'].includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.ok(headers['content-security-policy'].includes("script-src 'self'"));
  const response = new Response();
  await handleMemoryControlAction({ request: { headers: {} }, response });
  assert.equal(response.statusCode, 415);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('WEB-01 ledger retirement removes canonical selection and preserves exact historical revision', async () => {
  const stateRoot = join(root, 'retirement');
  const revision = await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l3', projectId: 'alpha',
    evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'retire-id', content: 'historical rules', committedAt: at });
  let calls = 0;
  await retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'retire-id', operation: 'archived', mutateCore: async () => {
    calls++;
    assert.equal((await listDistillationJobs(stateRoot, 'p3')).length, 0, 'ledger intent precedes Core mutation');
  } });
  assert.equal(calls, 1);
  assert.equal((await listDistillationJobs(stateRoot, 'p3')).length, 0);
  assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'archived');
  const hydrated = await hydrateMemoryEvidence({ stateRoot, accountId: 'p3', evidenceRef: `l3:retire-id:${revision.job_id}` });
  assert.equal(hydrated.content, 'historical rules');
  assert.equal((await listDistillationJobs(stateRoot, 'other')).length, 0);
});

test('WEB-01 ambiguous mutation leaves revisions quarantined, with explicit retry', async () => {
  const stateRoot = join(root, 'retirement-failure');
  await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
    evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
  await assert.rejects(retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted', mutateCore: async () => { throw new Error('disconnect'); } }), /disconnect/);
  assert.equal((await listDistillationJobs(stateRoot, 'p3')).length, 0);
  assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'pending');
  await retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted', mutateCore: async () => ({ ok: true }) });
  assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'deleted');
});

test('P3-P2 definite first-attempt Core errors restore exact revisions and rethrow', async () => {
  for (const operation of ['deleted', 'archived']) {
    for (const status of [400, 404, 409, 429, 500, 503, 599]) {
      const stateRoot = join(root, `first-error-${operation}-${status}`);
      await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
        evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
      if (operation === 'deleted') {
        await retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'archived', mutateCore: async () => {} });
      }
      const before = await listDistillationJobs(stateRoot, 'p3', true);
      const failure = new MemoryCoreHttpError(status, 'definite failure');
      const input = { stateRoot, accountId: 'p3', memoryId: 'id', operation, mutateCore: async () => { throw failure; } };
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(retireDistillationMemory(input), error => error === failure);
        assert.deepEqual(await listDistillationJobs(stateRoot, 'p3', true), before);
      }
      await retireDistillationMemory({ ...input, operation: 'deleted', mutateCore: async () => {} });
      assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'deleted');
    }
  }
});

test('P3-P2 only same-operation pending delete retry swallows Core 404', async () => {
  for (const operation of ['deleted', 'archived']) {
    const stateRoot = join(root, `first-404-${operation}`);
    await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
      evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
    const input = { stateRoot, accountId: 'p3', memoryId: 'id', operation,
      mutateCore: async () => { throw new MemoryCoreHttpError(404, 'not found'); } };
    await assert.rejects(retireDistillationMemory({ ...input, mutateCore: async () => { throw new Error('disconnect'); } }), /disconnect/);
    assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'pending');
    await assert.rejects(retireDistillationMemory({ ...input,
      mutateCore: async () => { throw new MemoryCoreHttpError(503, 'unavailable'); } }), { status: 503 });
    assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'pending');
    if (operation === 'deleted') {
      await retireDistillationMemory(input);
      assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'deleted');
    } else {
      await assert.rejects(retireDistillationMemory(input), { status: 404 });
      assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'pending');
    }
  }
  await assert.rejects(retireDistillationMemory({ stateRoot: join(root, 'unmanaged-404'), accountId: 'p3', memoryId: 'id',
    operation: 'deleted', mutateCore: async () => { throw new MemoryCoreHttpError(404, 'not found'); } }), { status: 404 });
});

test('P3-P2 terminal retirement is idempotent; delete supersedes archive and archive conflicts after delete', async () => {
  for (const operation of ['deleted', 'archived']) {
    const stateRoot = join(root, `terminal-${operation}`);
    await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
      evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
    let calls = 0;
    const input = { stateRoot, accountId: 'p3', memoryId: 'id', operation, mutateCore: async () => { calls++; } };
    await retireDistillationMemory(input);
    const before = await readFile(join(stateRoot, 'distillation', 'jobs.json'), 'utf8');
    await retireDistillationMemory(input);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(stateRoot, 'distillation', 'jobs.json'), 'utf8'), before);
    if (operation === 'archived') {
      await retireDistillationMemory({ ...input, operation: 'deleted' });
      assert.equal(calls, 2);
      assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'deleted');
    }
    const deleted = await readFile(join(stateRoot, 'distillation', 'jobs.json'), 'utf8');
    await assert.rejects(retireDistillationMemory({ ...input, operation: 'archived' }), /conflict/);
    assert.equal(calls, operation === 'archived' ? 2 : 1);
    assert.equal(await readFile(join(stateRoot, 'distillation', 'jobs.json'), 'utf8'), deleted);
  }
});

test('P3-P2 web retirement retries skip Core existence checks after terminal success', async () => {
  for (const action of ['delete-memory', 'archive-memory', 'archive-skill']) {
    const stateRoot = join(root, `terminal-action-${action}`);
    await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
      evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
    const db = new MemoryDb({ path: ':memory:' }); const core = new MemoryService({ db });
    core.repos.memories.insert(memory('id'));
    let checks = 0, mutations = 0;
    const runtime = { accountId: 'p3', memoryClient: {
      viewerDelete: async () => { mutations++; return core.deleteMemory('id'); },
      viewerPost: async () => { mutations++; return core.archiveMemory('id'); }
    } };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const request = Readable.from([JSON.stringify({ action, id: 'id' })]);
        request.headers = { 'content-type': 'application/json' };
        const response = new Response();
        await handleMemoryControlAction({ request, response, stateRoot, runtime, selectedAccount: { account_id: 'p3' },
          assertManagedMemory: async () => { checks++; assert.equal(attempt, 0); assert.ok(core.repos.memories.get('id')); } });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), { ok: true });
      }
      assert.equal(checks, 1);
      assert.equal(mutations, 1);
      assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement,
        action === 'delete-memory' ? 'deleted' : 'archived');
      if (action === 'delete-memory') assert.equal(core.repos.memories.get('id'), undefined);
      if (action === 'archive-memory') {
        const request = Readable.from([JSON.stringify({ action: 'delete-memory', id: 'id' })]);
        request.headers = { 'content-type': 'application/json' };
        const response = new Response();
        await handleMemoryControlAction({ request, response, stateRoot, runtime, selectedAccount: { account_id: 'p3' },
          assertManagedMemory: async () => assert.equal(core.repos.memories.get('id').status, 'archived') });
        assert.equal(response.statusCode, 200);
        assert.equal(mutations, 2);
        assert.equal(core.repos.memories.get('id'), undefined);
        assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'deleted');
      }
    } finally { db.close(); }
  }
});

test('P3-P2 delete finalization wins over an archive that already passed its web prechecks', async () => {
  const stateRoot = join(root, 'delete-archive-race');
  await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
    evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
  let start, release;
  const started = new Promise(done => { start = done; });
  const gate = new Promise(done => { release = done; });
  const request = Readable.from([JSON.stringify({ action: 'archive-memory', id: 'id' })]);
  request.headers = { 'content-type': 'application/json' };
  const archive = handleMemoryControlAction({ request, response: new Response(), stateRoot,
    runtime: { accountId: 'p3', memoryClient: { viewerPost: async () => assert.fail('archive must not reach Core') } },
    selectedAccount: { account_id: 'p3' }, assertManagedMemory: async () => { start(); await gate; } });
  const rejected = assert.rejects(archive, /conflict/);
  await started;
  try {
    await retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted', mutateCore: async () => {} });
  } finally { release(); }
  await rejected;
  assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'deleted');
});

test('P3-F4/6 retirement releases ledger lock during Core call and fences concurrent generations', async () => {
  const stateRoot = join(root, 'retirement-concurrent');
  const revision = id => recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
    evidence: [{ ref: `l1:${id}`, kind: 'turn', timestamp: at }], resultId: id, content: 'timeline', committedAt: at });
  await revision('id');
  let start, release;
  const started = new Promise(done => { start = done; });
  const gate = new Promise(done => { release = done; });
  const old = retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted',
    mutateCore: async () => { start(); await gate; } });
  const rejected = assert.rejects(old, /generation changed/);
  await started;
  try {
    await assert.rejects(retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'archived',
      mutateCore: async () => assert.fail('conflicting operation must not reach Core') }), /same operation/);
    await revision('unrelated');
    await retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted', mutateCore: async () => {} });
  } finally { release(); }
  await rejected;
  const jobs = await listDistillationJobs(stateRoot, 'p3', true);
  assert.equal(jobs.find(job => job.result_id === 'id').result_retirement, 'deleted');
  assert.equal(jobs.find(job => job.result_id === 'unrelated').result_retirement, undefined);
});

test('P3-P2 definite failure rollback preserves concurrent jobs and newer retirement generations', async () => {
  for (const superseded of [false, true]) {
    const stateRoot = join(root, `rollback-generation-${superseded}`);
    const revision = (accountId, id) => recordCompletedDistillationRevision({ stateRoot, accountId, target: 'l2', projectId: 'alpha',
      evidence: [{ ref: `l1:${id}`, kind: 'turn', timestamp: at }], resultId: id, content: 'timeline', committedAt: at });
    const before = await revision('p3', 'id');
    let start, release;
    const started = new Promise(done => { start = done; });
    const gate = new Promise(done => { release = done; });
    const failure = new MemoryCoreHttpError(404, 'not found');
    const old = retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted',
      mutateCore: async () => { start(); await gate; throw failure; } });
    const rejected = assert.rejects(old, error => error === failure);
    await started;
    let unrelated, otherAccount;
    try {
      unrelated = await revision('p3', 'unrelated');
      otherAccount = await revision('other', 'id');
      if (superseded) {
        await retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation: 'deleted', mutateCore: async () => {} });
      }
    } finally { release(); }
    await rejected;
    const jobs = await listDistillationJobs(stateRoot, undefined, true);
    const current = jobs.find(job => job.job_id === before.job_id);
    if (superseded) assert.equal(current.result_retirement, 'deleted');
    else assert.deepEqual(current, before);
    assert.deepEqual(jobs.find(job => job.job_id === unrelated.job_id), unrelated);
    assert.deepEqual(jobs.find(job => job.job_id === otherAccount.job_id), otherAccount);
  }
});

test('P3-F4 final ledger save failure retries via existing web action after Core delete 404 or archive', async () => {
  for (const operation of ['deleted', 'archived']) {
    const stateRoot = join(root, `retirement-final-save-${operation}`);
    await recordCompletedDistillationRevision({ stateRoot, accountId: 'p3', target: 'l2', projectId: 'alpha',
      evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'id', content: 'timeline', committedAt: at });
    const path = join(stateRoot, 'distillation', 'jobs.json');
    const rename = fs.promises.rename;
    let saves = 0, calls = 0;
    fs.promises.rename = async (source, target) => {
      if (target === path && ++saves === 2) throw Object.assign(new Error('final save failed'), { code: 'EIO' });
      return rename(source, target);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(retireDistillationMemory({ stateRoot, accountId: 'p3', memoryId: 'id', operation,
        mutateCore: async () => { calls++; } }), /final save failed/);
    } finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
    assert.equal(calls, 1);
    assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, 'pending');
    const db = new MemoryDb({ path: ':memory:' }); const core = new MemoryService({ db });
    try {
      if (operation === 'archived') {
        core.repos.memories.insert(memory('id'));
        core.archiveMemory('id');
      }
      const runtime = { accountId: 'p3', memoryClient: {
        viewerDelete: async () => { calls++; throw new MemoryCoreHttpError(404, 'not found'); },
        viewerPost: async () => { calls++; return core.archiveMemory('id'); }
      } };
      const request = Readable.from([JSON.stringify({ action: operation === 'deleted' ? 'delete-memory' : 'archive-memory', id: 'id' })]);
      request.headers = { 'content-type': 'application/json' };
      const response = new Response();
      await handleMemoryControlAction({ request, response, stateRoot, runtime, selectedAccount: { account_id: 'p3' },
        assertManagedMemory: async () => assert.fail('pending account-owned retry must not require an active Core row') });
      assert.equal(response.statusCode, 200);
      assert.equal(calls, 2);
      assert.equal((await listDistillationJobs(stateRoot, 'p3', true))[0].result_retirement, operation);
    } finally { db.close(); }
  }
});

test('WEB-05 regular users manage only their account project todos', async () => {
  const stateRoot = join(root, 'todos');
  const runtime = createMemhubRuntime({ controlRoot: stateRoot, accountId: 'p3', disableArchitecture: true });
  await runtime.projects.create('p3', { projectId: 'own', description: 'own project' });
  await runtime.projects.create('other', { projectId: 'foreign', description: 'foreign project' });
  const invoke = async body => {
    const request = Readable.from([JSON.stringify(body)]); request.headers = { 'content-type': 'application/json' };
    const response = new Response();
    await handleMemoryControlAction({ request, response, stateRoot, runtime, accounts: [], selectedAccount: { account_id: 'p3' }, adminView: false });
    return response;
  };
  assert.equal((await invoke({ action: 'add-project-todo', project: 'own', text: 'new todo', account_id: 'other' })).statusCode, 200);
  const project = (await runtime.projects.list('p3')).find(project => project.projectId === 'own');
  assert.equal(project.todos.length, 1);
  assert.equal((await invoke({ action: 'set-project-todo-status', project: 'own', todo_id: project.todos[0].id, status: 'done' })).statusCode, 200);
  const foreignTodo = await runtime.projects.addTodo('other', 'foreign', 'protected todo');
  for (const body of [
    { action: 'add-project-todo', project: 'foreign', text: 'not allowed', account_id: 'other' },
    { action: 'set-project-todo-status', project: 'foreign', todo_id: foreignTodo.todos[0].id, status: 'done', account_id: 'other' }
  ]) assert.equal((await invoke(body)).statusCode, 404);
  for (const action of ['create-project', 'update-project', 'delete-project', 'merge-project']) {
    assert.equal((await invoke({ action, project: 'own', description: 'changed', target: 'foreign' })).statusCode, 403);
  }
  assert.equal((await runtime.projects.list('other'))[0].todos[0].status, 'pending');
});

test('MC-07 reads retry once on transient transport/502-504; mutations are never replayed', async () => {
  for (const failure of [new TypeError('connection reset'), 502, 503, 504]) {
    let calls = 0;
    const client = new LocalMemoryRestClient({ endpoint: 'http://127.0.0.1', fetchImpl: async () => {
      if (++calls === 1) {
        if (failure instanceof Error) throw failure;
        return new globalThis.Response('{}', { status: failure });
      }
      return new globalThis.Response('{"ok":true}');
    } });
    assert.deepEqual(await client.viewerGet('/api/v1/l2'), { ok: true });
    assert.equal(calls, 2);
  }
  for (const read of [true, false]) {
    let calls = 0;
    const client = new LocalMemoryRestClient({ endpoint: 'http://127.0.0.1', fetchImpl: async () => { calls++; throw new TypeError('connection reset'); } });
    await assert.rejects(read ? client.viewerGet('/api/v1/l2') : client.addMemory({ content: 'test' }));
    assert.equal(calls, read ? 2 : 1);
  }
});

test('WEB-01/02/03 loopback gateway paginates past 500, retires ledger, and sanitizes 500s for all base paths', async () => {
  const requests = [];
  let explode = false;
  const core = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ path: url.pathname, page: url.searchParams.get('page'), userId: url.searchParams.get('userId'), authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (explode) { response.writeHead(500).end(JSON.stringify({ message: 'SQLITE failure /private/p3-memory.sqlite' })); return; }
    if (url.pathname === '/api/v1/l2') {
      const page = Number(url.searchParams.get('page'));
      const items = page < 6 ? Array.from({ length: 100 }, (_, i) => ({ id: `page-${page}-${i}` })) : [{ id: 'after-500' }];
      response.end(JSON.stringify({ items, totalPages: 6, hasNext: page < 6 }));
    } else response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((done, reject) => { core.once('error', reject); core.listen(0, '127.0.0.1', done); });
  try {
    for (const base of ['/', '/memhub', '/custom/nested']) {
      const stateRoot = await createTestRoot('p3-gateway-');
      const account = await addAccount(stateRoot, 'gateway');
      await setAccountRole(stateRoot, account.account_id, 'admin');
      const token = await ensureLocalAdminToken(stateRoot);
      const runtime = createMemhubRuntime({ controlRoot: stateRoot, accountId: account.account_id, disableArchitecture: true });
      await runtime.projects.create(account.account_id, { projectId: 'alpha', description: 'fixture' });
      await recordCompletedDistillationRevision({ stateRoot, accountId: account.account_id, target: 'l2', projectId: 'alpha',
        evidence: [{ ref: 'l1:test', kind: 'turn', timestamp: at }], resultId: 'after-500', content: 'timeline', committedAt: at });
      const log = createWriteStream(join(stateRoot, 'gateway.log'));
      const child = spawn(process.execPath, ['dist/mcp.js', '--http', '0', '--base-path', base, '--state-root', stateRoot,
        '--account', account.account_id, '--memory-url', `http://127.0.0.1:${core.address().port}`, '--memory-token', 'p3-token', '--no-architecture'],
      { env: testEnvironment(stateRoot, join(stateRoot, 'architecture')), stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      try {
        const endpoint = await new Promise((done, reject) => {
          const timeout = setTimeout(() => reject(new Error('gateway startup timeout')), 10000);
          let text = '';
          child.stderr.on('data', chunk => {
            text += chunk;
            const match = text.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timeout); done(match[1]); }
          });
          child.once('exit', () => { clearTimeout(timeout); reject(new Error('gateway startup exited')); });
        });
        const headers = { authorization: `Basic ${Buffer.from(`local:${token}`).toString('base64')}`, 'content-type': 'application/json' };
        const page = await fetch(endpoint + webPath(base));
        assert.equal(page.status, 200);
        assert.ok((await page.text()).includes(`href="${webPath(base, '/docs')}"`));
        for (const path of ['/mcp', '/mcp/']) {
          const res = await fetch(endpoint + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
          assert.notEqual(res.status, 404);
          await res.text();
        }
        const action = endpoint + webPath(base, '/user/action');
        const deleted = await fetch(action, { method: 'POST', headers, body: JSON.stringify({ action: 'delete-memory', id: 'after-500' }) });
        assert.equal(deleted.status, 200);
        assert.ok(requests.some(request => request.page === '6' && request.userId === runtime.userId));
        assert.ok(requests.every(request => request.authorization === 'Bearer p3-token'));
        assert.equal((await listDistillationJobs(stateRoot, account.account_id)).length, 0);
        assert.equal((await listDistillationJobs(stateRoot, account.account_id, true))[0].result_retirement, 'deleted');
        explode = true;
        const failed = await fetch(action, { method: 'POST', headers, body: JSON.stringify({ action: 'archive-memory', id: 'explode' }) });
        assert.equal(failed.status, 500);
        const error = await failed.json();
        assert.equal(error.message, 'Internal server error');
        assert.match(error.error_id, /^[a-f0-9-]{8}$/);
        assert.ok(!JSON.stringify(error).includes('/private/'));
        assert.equal(failed.headers.get('cache-control'), 'no-store');
        assert.equal(failed.headers.get('x-content-type-options'), 'nosniff');
      } finally {
        explode = false;
        const stopped = new Promise(done => child.exitCode !== null ? done() : child.once('exit', done));
        child.kill('SIGTERM'); await stopped;
        await new Promise(done => log.end(done));
      }
      const logText = await readFile(join(stateRoot, 'gateway.log'), 'utf8');
      assert.ok(logText.includes('/private/p3-memory.sqlite'), 'server retains the diagnostic detail');
    }
  } finally {
    await new Promise(done => { core.close(done); core.closeAllConnections(); });
  }
});
