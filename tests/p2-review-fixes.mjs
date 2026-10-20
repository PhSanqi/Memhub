import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { FileProjectArchitectureSource } from '../dist/architecture-source.js';
import * as capture from '../dist/capture.js';
import { recoverCaptureIngest } from '../dist/capture-recovery.js';
import { createMemhubRuntime } from '../dist/runtime.js';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { JsonResultTransport, RESULT_TTL_MS } from '../dist/result-transport.js';
import { selectPassages } from '../dist/turn-knowledge-plan.js';

const root = await createTestRoot('p2-review-fixes-');
isolateTestEnvironment(root, join(root, 'architecture'));
const actor = { account_id: 'review', actor_id: 'test' };
const event = id => ({ event_id: id, host: 'test', conversation_id: 'chat', continuity_id: 'explicit-key',
  timestamp: '2026-10-18T00:00:00Z', project_hint: 'alpha', user_text: 'user', assistant_text: 'answer', capture_status: 'complete' });

test('F1 registry mutations ignore an older in-flight fill', async () => {
  const path = join(root, 'registry.json');
  const registry = new JsonProjectRegistry(path);
  await registry.create('review', { projectId: 'alpha', description: 'fixture' });
  const old = JSON.parse(await readFile(path, 'utf8'));
  let release;
  registry.filling = new Promise(done => { release = () => done(old); });
  await new JsonProjectRegistry(path).create('other', { projectId: 'beta', description: 'fixture' });
  const writing = registry.create('review', { projectId: 'gamma', description: 'fixture' });
  release();
  await writing;
  assert.deepEqual((await new JsonProjectRegistry(path).list('other')).map(p => p.projectId), ['beta']);
});

test('F1 a fill from a replaced generation is discarded', async () => {
  const path = join(root, 'registry-generation.json');
  const registry = new JsonProjectRegistry(path);
  await registry.create('review', { projectId: 'alpha', description: 'fixture' });
  const originalOpen = fsPromises.open;
  let changed = false;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path && args[1] === 'r' && !changed) {
      changed = true;
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs) => {
        const bytes = await read(...readArgs);
        await new JsonProjectRegistry(path).create('review', { projectId: 'beta', description: 'fixture' });
        return bytes;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await registry.list('review')).length, 2, 'discard bytes read before replacement');
    assert.equal((await registry.list('review')).length, 2);
  } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }

});

function crashWal(state) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db = new Database(process.argv[1]); db.pragma('journal_mode=WAL');
    db.pragma('wal_autocheckpoint=0');
    db.prepare('UPDATE capture_index SET ingested=1, mtime_ms=mtime_ms+1 WHERE event_id=?').run('one');
    process.exit(0);
  `, join(state, 'capture-index.sqlite')], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
}

test('F2 explicit recovery checkpoints a crashed WAL before any read', async () => {
  const state = join(root, 'wal');
  await capture.storeCaptureEvent(state, actor, event('one'));
  await capture.markCaptureIngested(state, 'review', 'one');
  capture.closeCaptureIndexDb(state);
  crashWal(state);
  assert.ok((await stat(join(state, 'capture-index.sqlite-wal'))).size > 0);
  assert.equal(typeof capture.recoverCaptureIndex, 'function');
  await capture.recoverCaptureIndex(state);
  assert.equal((await capture.listCaptureIndexEntries(state, 'review'))[0].ingested, true);
  capture.closeCaptureIndexDb(state);
});

test('F2 recover_ingest can inspect a crashed WAL without Core writes in dry run', async () => {
  const state = join(root, 'redrive');
  await capture.storeCaptureEvent(state, actor, event('one'));
  await capture.markCaptureIngested(state, 'review', 'one');
  capture.closeCaptureIndexDb(state);
  crashWal(state);
  const runtime = createMemhubRuntime({ controlRoot: state, accountId: 'review', disableArchitecture: true });
  await runtime.projects.create('review', { projectId: 'alpha', description: 'fixture' });
  runtime.memoryClient.openSession = async () => { throw new Error('unexpected Core write'); };
  try {
    const result = await recoverCaptureIngest({ stateRoot: state, runtime, eventId: 'one', projectId: 'alpha', dryRun: true });
    assert.equal(result.already_ingested, true);
  } finally { runtime.dispose(); }
});

test('F4 capture reads reuse one memory image and invalidate on writes', async () => {
  const state = join(root, 'snapshot');
  await capture.storeCaptureEvent(state, actor, event('one'));
  const prepare = Database.prototype.prepare;
  const images = new Set();
  Database.prototype.prepare = function (...args) { if (this.memory) images.add(this); return prepare.apply(this, args); };
  try {
    await Promise.all(Array.from({ length: 8 }, () => capture.listCaptureIndexEntries(state, 'review')));
    assert.equal(images.size, 1, 'one deserialized snapshot across parallel reads');
    const [old] = images;
    await capture.storeCaptureEvent(state, actor, event('two'));
    assert.equal((await capture.listCaptureIndexEntries(state, 'review')).length, 2);
    assert.equal(images.size, 2);
    assert.equal(old.open, false, 'superseded snapshot is closed');
  } finally { Database.prototype.prepare = prepare; capture.closeCaptureIndexDb(state); }
});

test('F5 managed canonical architecture overrides another process discovery cache', async () => {
  const architectureRoot = join(root, 'arch');
  await mkdir(join(architectureRoot, 'alpha'), { recursive: true });
  await writeFile(join(architectureRoot, 'alpha', 'package.json'), '{}');
  await writeFile(join(architectureRoot, 'alpha', 'ARCHITECTURE.md'), '# Repository');
  const source = new FileProjectArchitectureSource({ rootDir: architectureRoot, managedRootDir: join(root, 'managed') });
  const input = { accountId: 'review', projectId: 'alpha', query: 'architecture' };
  assert.match((await source.getProjectArchitecture(input))[0].content, /Repository/);
  const canonical = await source.inspectProjectArchitecture(input);
  await mkdir(join(canonical.path, '..'), { recursive: true });
  await writeFile(canonical.path, '# Canonical managed document');
  const result = await source.getProjectArchitecture(input);
  assert.equal(result.length, 1);
  assert.match(result[0].content, /Canonical managed document/);
});

test('F6 F7 unbound resume by ack key and event id, persisted ack status', async () => {
  const state = join(root, 'turns');
  const runtime = createMemhubRuntime({ controlRoot: state, accountId: 'review', disableArchitecture: true });
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async () => ({});
  const server = createMemhubMcpServerForRuntime(runtime, state);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'review', version: '1' });
  await server.server.connect(serverTransport); await client.connect(clientTransport);
  const call = async args => {
    const result = await client.callTool({ name: 'memmy_turn', arguments: args });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try {
    const opened = await call({ action: 'open', user_text: 'unbound' });
    assert.equal(opened.continuity_id, `memhub-unbound:${opened.event_id}`);
    const checkpoint = await call({ action: 'checkpoint', event_id: opened.event_id, assistant_text: 'answer', reasoning_summary: 'public summary' });
    assert.equal(checkpoint.status, 'complete');
    const replay = await call({ action: 'open', event_id: opened.event_id, user_text: 'unbound' });
    assert.equal(replay.status, 'complete');
    for (const key of [{ continuity_id: opened.continuity_id }, { event_id: opened.event_id }]) {
      const resumed = await call({ action: 'resume', ...key });
      assert.equal(resumed.turns.at(-1).event_id, opened.event_id);
    }
    const bound = await call({ action: 'open', conversation_id: 'native-chat', continuity_id: 'custom', user_text: 'bound' });
    assert.equal((await call({ action: 'resume', event_id: bound.event_id })).continuity_id, 'custom');
  } finally { await client.close(); await server.close(); runtime.dispose(); }
});

test('F7 ack reports completed state after a checkpoint and replayed open', async () => {
  const state = join(root, 'ack-status');
  const runtime = createMemhubRuntime({ controlRoot: state, accountId: 'review', disableArchitecture: true });
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async () => ({});
  const server = createMemhubMcpServerForRuntime(runtime, state);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'status', version: '1' });
  await server.server.connect(st); await client.connect(ct);
  const call = async args => {
    const result = await client.callTool({ name: 'memmy_turn', arguments: args });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try {
    const opened = await call({ action: 'open', conversation_id: 'status-chat', user_text: 'user' });
    const checkpoint = await call({ action: 'checkpoint', conversation_id: 'status-chat', event_id: opened.event_id,
      assistant_text: 'answer', tool_summary: 'public audit' });
    assert.equal(checkpoint.status, 'complete');
    const replay = await call({ action: 'open', conversation_id: 'status-chat', event_id: opened.event_id, user_text: 'user' });
    assert.equal(replay.status, 'complete');
  } finally { await client.close(); await server.close(); runtime.dispose(); }
});

test('F9 expiry sweep covers inactive accounts on every wrap/read', async () => {
  const state = join(root, 'expiry');
  const t = new JsonResultTransport(state, 'inactive', 1);
  const first = t.wrap('payload', { readOnly: true });
  const now = Date.now;
  Date.now = () => now() + RESULT_TTL_MS + 1;
  try { new JsonResultTransport(state, 'active').wrap('small'); }
  finally { Date.now = now; }
  assert.throws(() => t.read(first.result_transport.result_id), /expired/);
  const second = t.wrap('payload', { readOnly: true });
  Date.now = () => now() + RESULT_TTL_MS + 1;
  try { assert.throws(() => new JsonResultTransport(state, 'reader').read('invalid'), /invalid result_id/); }
  finally { Date.now = now; }
  assert.throws(() => t.read(second.result_transport.result_id), /expired/);
});

test('F9 unref interval sweeps inactive accounts without requests', async () => {
  const set = globalThis.setInterval;
  let sweep, unrefs = 0;
  globalThis.setInterval = (callback, delay) => {
    assert.ok(delay > 0 && delay <= 60_000);
    sweep = callback;
    return { unref() { unrefs++; } };
  };
  let transport;
  try { transport = await import('../dist/result-transport.js?interval-regression'); }
  finally { globalThis.setInterval = set; }
  assert.equal(unrefs, 1);
  const t = new transport.JsonResultTransport(root, 'interval', 1);
  const result = t.wrap('inactive', { readOnly: true });
  const now = Date.now;
  Date.now = () => now() + RESULT_TTL_MS + 1;
  try { sweep(); } finally { Date.now = now; }
  assert.throws(() => t.read(result.result_transport.result_id), /expired/);
});

test('F9 process-wide byte cap evicts oldest results across accounts', () => {
  const oldest = new JsonResultTransport(root, 'oldest', 1);
  const payload = '😀'.repeat(4_200_000);
  const first = oldest.wrap(payload, { readOnly: true });
  for (let i = 0; i < 18; i++) new JsonResultTransport(root, `cap-${i}`, 1).wrap(payload, { readOnly: true });
  assert.throws(() => oldest.read(first.result_transport.result_id), /expired/);
});

test('F10 passage truncation preserves emoji surrogate pairs', () => {
  const passages = selectPassages('# Matching heading\n\n' + '😀'.repeat(1_000), ['matching'], ['matching'], 'none');
  assert.ok(passages.length);
  for (const p of passages) assert.equal(p.text.isWellFormed(), true);
});
