import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createTestRoot, isolateTestEnvironment, testEnvironment } from './test-isolation.mjs';
import { addAccount, setAccountRole, ensureLocalAdminToken } from '../dist/auth.js';
import { webPath } from '../dist/gateway-http.js';
import { createMemhubRuntime } from '../dist/runtime.js';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { resolveCaptureProject } from '../dist/capture-project-resolution.js';
import { assignCaptureProjects, countUnassignedCaptures, projectClarification, listUnassignedCaptures } from '../dist/capture-project-assignments.js';
import { storeCaptureEvent, closeCaptureIndexDb, listFreshCaptureEvidence, markCaptureIngested, scheduleCaptureProjectBackfill, withCaptureIndexDb } from '../dist/capture.js';
import { discoverDistillationJobs } from '../dist/distillation-discovery.js';
import { setDistillationConfig } from '../dist/distillation-jobs.js';
import { listL1Turns, upsertL1Turn } from '../dist/turn-log.js';
import { handleMemoryControlRead } from '../dist/memory-control-http.js';
import { handleMemoryControlAction } from '../dist/memory-control-actions.js';
import { renderConsole } from '../dist/web-ui.js';

const at = '2026-10-20T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const capturePath = (root, id) => join(root, 'captures', hash('acct'), hash(id) + '.json');
async function waitForIndex(root, check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const db = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
    try { if (check(db)) return; } finally { db.close(); }
    await new Promise(done => setTimeout(done, 10));
  }
  assert.fail('capture index did not reach the expected state');
}
async function fixture(run) {
  const root = await createTestRoot('p6-project-');
  isolateTestEnvironment(root, root);
  const runtime = createMemhubRuntime({ controlRoot: root, accountId: 'acct', disableArchitecture: true });
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async () => ({});
  runtime.memoryClient.search = async () => ({ hits: [] });
  runtime.memoryClient.viewerGet = async () => ({ items: [], total: 0, stats: {} });
  for (const projectId of ['demo', 'other']) await runtime.projects.create('acct', {
    projectId, name: projectId, aliases: projectId === 'demo' ? ['Demo Alias'] : [], description: 'fixture project'
  });
  const add = async (event_id, extra = {}, account_id = 'acct') => (await storeCaptureEvent(root, { account_id, actor_id: 'test' }, {
    event_id, host: 'test', conversation_id: 'transport', continuity_id: 'thread', timestamp: at,
    user_text: 'Please investigate the unresolved project routing in this request.', assistant_text: 'Done.', capture_status: 'complete', ...extra
  })).event;
  const assign = extra => assignCaptureProjects({ stateRoot: root, accountId: 'acct', projects: runtime.projects, assignedBy: 'host', ...extra });
  const resolve = event => resolveCaptureProject(event, ref => runtime.projects.resolve('acct', ref), root);
  const server = createMemhubMcpServerForRuntime(runtime, root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bug2-test', version: '1' });
  await server.server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try { await run({ root, runtime, add, assign, resolve, call }); }
  finally {
    await client.close(); await server.close();
    runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}

test('resolution: hint > event assignment > continuity binding > workspace > none', () => fixture(async ({ add, assign, resolve }) => {
  const hinted = await add('hint', { project_hint: 'Demo Alias', workspace_path: '/workspaces/other' });
  await assign({ project: 'other', eventIds: ['hint'] });
  assert.equal((await resolve(hinted)).projectId, 'demo');
  const direct = await add('direct', { workspace_path: '/workspaces/other' });
  await assign({ project: 'demo', eventIds: ['direct'], continuityId: 'thread' });
  assert.equal((await resolve(direct)).source, 'assignment');
  const later = await add('later', { timestamp: '2026-10-20T00:01:00.000Z', workspace_path: '/workspaces/other' });
  assert.equal((await resolve(later)).source, 'continuity');
  assert.equal((await resolve(later)).projectId, 'demo');
  const workspace = await add('workspace', { continuity_id: 'separate', workspace_path: 'C:\\workspaces\\OTHER\\src' });
  assert.equal((await resolve(workspace)).source, 'workspace_path');
  assert.equal((await resolve(await add('none', { continuity_id: 'none' }))).projectId, null);
}));

test('different explicit project ends continuity binding; same canonical alias does not', () => fixture(async ({ add, assign, resolve }) => {
  await add('start'); await assign({ project: 'demo', continuityId: 'thread' });
  await add('alias', { timestamp: '2026-10-20T00:01:00.000Z', project_hint: 'Demo Alias' });
  assert.equal((await resolve(await add('same', { timestamp: '2026-10-20T00:02:00.000Z' }))).projectId, 'demo');
  await add('switch', { timestamp: '2026-10-20T00:03:00.000Z', project_hint: 'other' });
  assert.equal((await resolve(await add('after', { timestamp: '2026-10-20T00:04:00.000Z' }))).projectId, null);
}));

test('unregistered hint remains a candidate and falls through assignment, continuity and workspace', () => fixture(async ({ root, add, assign, resolve }) => {
  const raw = await add('unknown', { project_hint: '灵巧手', continuity_id: 'unknown' });
  assert.deepEqual(await resolve(raw), { projectId: null, source: 'none', candidate: '灵巧手' });
  await assign({ project: 'Demo Alias', eventIds: ['unknown'], continuityId: 'unknown' });
  assert.deepEqual(await resolve(raw), { projectId: 'demo', source: 'assignment', candidate: '灵巧手' });
  const later = await add('unknown-later', { project_hint: '灵巧手', continuity_id: 'unknown', timestamp: '2026-10-20T00:01:00.000Z' });
  assert.deepEqual(await resolve(later), { projectId: 'demo', source: 'continuity', candidate: '灵巧手' });
  const after = await add('unknown-after', { continuity_id: 'unknown', timestamp: '2026-10-20T00:02:00.000Z' });
  assert.equal((await resolve(after)).projectId, 'demo', 'unregistered hints cannot terminate the user binding');
  const path = await add('unknown-path', { project_hint: '灵巧手', continuity_id: 'path', workspace_path: '/workspaces/other' });
  assert.deepEqual(await resolve(path), { projectId: 'other', source: 'workspace_path', candidate: '灵巧手' });
  const db = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
  assert.equal(db.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='unknown'").get().resolved_project_id, 'demo'); db.close();
}));

test('registered hint still wins over a conflicting event assignment', () => fixture(async ({ add, assign, resolve }) => {
  const event = await add('registered', { project_hint: 'Demo Alias' });
  await assign({ project: 'other', eventIds: ['registered'] });
  assert.deepEqual(await resolve(event), { projectId: 'demo', source: 'project_hint', candidate: 'Demo Alias' });
}));

test('unknown hint is captured, offered for governed creation and remains assignable through MCP', () => fixture(async ({ root, runtime, call }) => {
  await upsertL1Turn({ stateRoot: root, runtime, actorId: `mcp:${runtime.source.transport}`, turn: {
    event_id: 'raw-hint', host: runtime.source.platform, conversation_id: 'raw', continuity_id: 'raw',
    project_hint: '灵巧手', user_text: 'Please investigate the project routing of this substantive request.', capture_status: 'open'
  } });
  const commit = await call('memmy_turn', { action: 'commit', event_id: 'raw-hint', assistant_text: 'Review completed.' });
  assert.equal(commit.project_resolution.candidate, '灵巧手');
  assert.match(commit.project_resolution.ask.en, /Create via memmy_project_manage with user approval/);
  assert.ok(Buffer.byteLength(JSON.stringify(commit.project_resolution, null, 2).replace(/\n/g, '\n  ')) <= 600);
  assert.equal((await runtime.projects.list('acct')).length, 2, 'unknown hint never creates a project automatically');
  await call('memmy_turn', { action: 'assign', project: 'demo', event_ids: ['raw-hint'] });
  const evidence = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 });
  assert.deepEqual(evidence.map(event => event.event_id), ['raw-hint']);
}));

test('assignment validates project/account, caps batches, rejects mixed scopes without partial writes', () => fixture(async ({ add, assign, resolve }) => {
  const own = await add('own'); await add('foreign', {}, 'foreign-account');
  await assert.rejects(assign({ project: 'unknown', eventIds: ['own'] }), /unknown project/);
  await assert.rejects(assign({ project: 'demo', eventIds: ['own', 'foreign'] }), /account/);
  await assert.rejects(assign({ project: 'demo', eventIds: Array(201).fill('own') }), /1-200/);
  await assert.rejects(assign({ project: 'demo', continuityId: 'wrong', eventIds: ['own'] }), /continuity/);
  await assert.rejects(assign({ project: 'demo', keepGlobal: true, eventIds: ['own'] }), /provide project/);
  await assert.rejects(assign({ keepGlobal: true, continuityId: 'foreign-only' }), /not found/);
  assert.equal((await resolve(own)).projectId, null);
}));

test('idempotent append-only reassign/keep-global leaves capture and frozen intent byte-identical', () => fixture(async ({ root, add, assign, resolve }) => {
  const event = await add('immutable', { workspace_path: '/workspaces/demo' });
  const path = join(root, 'captures', hash('acct'), hash('immutable') + '.json');
  const bytes = await readFile(path);
  await writeFile(path + '.ingest-intent', 'frozen-test-hash');
  assert.equal((await assign({ project: 'DEMO', eventIds: ['immutable'] })).assigned, 1);
  assert.equal((await assign({ project: 'Demo Alias', eventIds: ['immutable'] })).unchanged, 1);
  await assign({ project: 'other', eventIds: ['immutable'] });
  assert.equal((await resolve(event)).projectId, 'other');
  await assign({ keepGlobal: true, eventIds: ['immutable'], continuityId: 'thread' });
  assert.equal((await resolve(event)).source, 'keep_global');
  assert.equal((await resolve(await add('future', { timestamp: '2026-10-20T00:01:00.000Z', workspace_path: '/workspaces/demo' }))).source, 'keep_global');
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(await readFile(path + '.ingest-intent', 'utf8'), 'frozen-test-hash');
  const db = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
  const rows = db.prepare("SELECT * FROM capture_project_assignments WHERE scope='event'").all();
  assert.equal(rows.length, 3); assert.equal(rows[1].supersedes, rows[0].id); assert.equal(rows[2].project_id, null); db.close();
}));

test('canonical aliases, workspace and later assignments appear in fresh L1 and admin project filter', () => fixture(async ({ root, runtime, add, assign }) => {
  await add('alias', { project_hint: 'Demo Alias' }); await add('path', { workspace_path: '/workspaces/demo' }); await add('assigned');
  await assign({ project: 'demo', eventIds: ['assigned'] });
  const evidence = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 });
  assert.deepEqual(evidence.map(e => e.event_id).sort(), ['alias', 'assigned', 'path']);
  const turns = await listL1Turns({ stateRoot: root, accountId: 'acct', projectId: 'demo', resolveProject: ref => runtime.projects.resolve('acct', ref) });
  assert.deepEqual(turns.map(e => e.event_id).sort(), ['alias', 'assigned', 'path']);
  assert.ok(turns.every(e => e.resolved_project_id === 'demo'));
}));

test('new ingests use the resolver while already-ingested Core copies are never retagged', () => fixture(async ({ root, runtime, assign }) => {
  const sessions = [];
  runtime.memoryClient.openSession = async request => { sessions.push(request); return {}; };
  const turn = { event_id: 'ingested', host: 'test', conversation_id: 'transport', continuity_id: 'thread', timestamp: at,
    user_text: 'Please implement the project routing repair for this substantive request.', assistant_text: 'Done.', capture_status: 'complete' };
  const input = { stateRoot: root, runtime, actorId: 'test', turn };
  assert.equal((await upsertL1Turn(input)).project_id, null);
  await assign({ project: 'demo', eventIds: ['ingested'], continuityId: 'thread' });
  assert.equal((await upsertL1Turn(input)).project_id, 'demo');
  assert.equal(sessions.length, 1); assert.equal(sessions[0].projectId, undefined);
  assert.equal((await upsertL1Turn({ ...input, turn: { ...turn, event_id: 'new-ingest', timestamp: '2026-10-20T00:01:00.000Z' } })).project_id, 'demo');
  assert.equal(sessions.length, 2); assert.equal(sessions[1].projectId, 'demo');
  assert.equal((await upsertL1Turn({ ...input, turn: { ...turn, event_id: 'workspace-ingest', continuity_id: 'workspace', workspace_path: '/workspaces/demo' } })).project_id, 'demo');
  assert.equal(sessions[2].projectId, 'demo');
}));

test('legacy NULL-column migration falls back immediately and backfills without touching capture bytes', () => fixture(async ({ root, add }) => {
  await add('legacy', { project_hint: 'Demo Alias' }); closeCaptureIndexDb(root);
  const path = join(root, 'capture-index.sqlite'); const db = new Database(path);
  db.exec('DROP INDEX idx_capture_resolved_project; DROP INDEX idx_capture_unassigned; ALTER TABLE capture_index DROP COLUMN resolved_project_id'); db.close();
  const evidence = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 });
  assert.equal(evidence[0]?.event_id, 'legacy');
  scheduleCaptureProjectBackfill(root, 'acct');
  await new Promise(done => setTimeout(done, 80));
  const migrated = new Database(path, { readonly: true });
  assert.equal(migrated.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='legacy'").get().resolved_project_id, 'demo'); migrated.close();
}));

test('resolved-global backlog cannot crowd project evidence out of the bounded fresh query', () => fixture(async ({ root, add }) => {
  await add('project-evidence', { project_hint: 'Demo Alias' });
  for (let i = 0; i < 40; i++) await add(`global-${i}`, { timestamp: '2026-10-20T01:00:00.000Z' });
  const result = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 });
  assert.deepEqual(result.map(event => event.event_id), ['project-evidence']);
}));

test('assignment makes already-ingested captures eligible for project L2 discovery', () => fixture(async ({ root, add, assign, runtime }) => {
  await setDistillationConfig(root, { auto_enabled: true, turn_threshold: 2, idle_minutes: 1 });
  for (const id of ['one', 'two']) { await add(id); await markCaptureIngested(root, 'acct', id); }
  const input = { stateRoot: root, accountId: 'acct', resolveProject: ref => runtime.projects.resolve('acct', ref), enqueue: true,
    now: new Date(Date.now() + 120_000) };
  assert.equal((await discoverDistillationJobs(input)).eligible, 0);
  await assign({ project: 'demo', continuityId: 'thread' });
  const report = await discoverDistillationJobs(input);
  assert.equal(report.eligible, 2); assert.equal(report.queued, 1);
}));

test('lazy batches advance beyond 100 unresolved rows without starving later canonical evidence', () => fixture(async ({ root, add }) => {
  for (let i = 0; i < 101; i++) await add(`unresolved-${String(i).padStart(3, '0')}`);
  await add('zz-alias', { project_hint: 'Demo Alias' });
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_index SET resolved_project_id=NULL WHERE account_id='acct'").run(); db.close();
  const pending = new Database(join(root, 'capture-index.sqlite'));
  pending.prepare("UPDATE capture_project_backfill SET cursor='',complete=0 WHERE account_id='acct'").run(); pending.close();
  scheduleCaptureProjectBackfill(root, 'acct');
  let project;
  for (let i = 0; i < 100 && project !== 'demo'; i++) {
    await new Promise(done => setTimeout(done, 20));
    const view = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
    project = view.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='zz-alias'").get().resolved_project_id;
    view.close();
  }
  assert.equal(project, 'demo');
}));

test('unassigned SQL count and grouped page never read capture files or resolve off-page candidates', () => fixture(async ({ root, runtime, add, assign }) => {
  for (let i = 0; i < 25; i++) await add(`queue-${i}`, { continuity_id: `group-${i}` });
  await add('private-queue', { user_text: '<private>hidden</private>', assistant_text: '<private>hidden</private>' });
  await add('global-queue', { continuity_id: 'kept' });
  await assign({ keepGlobal: true, eventIds: ['global-queue'] });
  for (let i = 0; i < 25; i++) await writeFile(capturePath(root, `queue-${i}`), 'unreadable capture fixture');
  let suggestions = 0;
  const projects = { suggest: async () => { suggestions++; return []; } };
  assert.equal(await countUnassignedCaptures(root, 'acct'), 25);
  const page = await listUnassignedCaptures({ stateRoot: root, accountId: 'acct', projects, offset: 10, limit: 2 });
  assert.equal(page.items.length, 2); assert.equal(page.total, 25); assert.equal(page.unresolved_count, 25);
  assert.equal(suggestions, 2); assert.ok(page.items.every(group => group.events.length === 1 && group.first_user_line));
  runtime.projects.suggest = async () => { throw new Error('overview must not compute queue candidates'); };
  const account = { account_id: 'acct', username: 'test', role: 'admin' };
  const response = new Response();
  await handleMemoryControlRead({ stateRoot: root, runtime, accounts: [account], selectedAccount: account,
    callerAccountId: 'acct', adminView: true, response, url: new URL('http://test/admin/api?kind=overview') });
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).unresolved_count, 25);
}));

test('L1 resolves a bounded pending probe before SQL pagination and reuses registry lookups', () => fixture(async ({ root, runtime, add }) => {
  for (let i = 0; i < 5; i++) await add(`project-${i}`, { project_hint: 'Demo Alias', timestamp: `2026-10-20T00:00:0${i}.000Z` });
  for (let i = 0; i < 40; i++) {
    await add(`irrelevant-${i}`, { project_hint: i % 2 ? 'other' : undefined, timestamp: '2026-10-20T01:00:00.000Z' });
    await writeFile(capturePath(root, `irrelevant-${i}`), 'this file must be outside the project page');
  }
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_index SET resolved_project_id=NULL WHERE account_id='acct'").run(); db.close();
  let resolutions = 0;
  const turns = await listL1Turns({ stateRoot: root, accountId: 'acct', projectId: 'demo', limit: 2, offset: 1,
    resolveProject: ref => { resolutions++; return runtime.projects.resolve('acct', ref); } });
  assert.deepEqual(turns.map(turn => turn.event_id), ['project-3', 'project-2']);
  assert.equal(resolutions, 1); // One lookup per distinct registry reference, shared by pending and returned rows.
}));

test('assigning continuity through e3 anchors at e1 and publishes every affected row atomically', () => fixture(async ({ root, add, assign, resolve }) => {
  const turns = [];
  for (let i = 1; i <= 3; i++) turns.push(await add(`e${i}`, { timestamp: `2026-10-20T00:00:0${i}.000Z` }));
  assert.equal((await assign({ project: 'demo', continuityId: 'thread', eventIds: ['e3'] })).assigned, 1);
  for (const event of turns) assert.equal((await resolve(event)).projectId, 'demo');
  const db = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
  assert.deepEqual(db.prepare("SELECT resolved_project_id FROM capture_index WHERE account_id='acct' ORDER BY event_id").all().map(row => row.resolved_project_id), ['demo','demo','demo']);
  assert.equal(db.prepare("SELECT anchor_timestamp FROM capture_project_assignments WHERE scope='continuity'").get().anchor_timestamp, turns[0].timestamp);
  db.close();
  assert.equal(await countUnassignedCaptures(root, 'acct'), 0);
}));

test('backfill skips bad rows with ID-only warnings and resumes from a durable cursor across reopen', () => fixture(async ({ root, add }) => {
  for (const id of ['000-before-cursor', '060-bad', '070-mismatch', '080-missing', 'zz-good']) await add(id, { project_hint: 'Demo Alias' });
  await writeFile(capturePath(root, '000-before-cursor'), 'private-before-cursor');
  await writeFile(capturePath(root, '060-bad'), 'private-broken-json');
  const mismatch = JSON.parse(await readFile(capturePath(root, '070-mismatch'), 'utf8')); mismatch.account_id = 'foreign';
  await writeFile(capturePath(root, '070-mismatch'), JSON.stringify(mismatch));
  await rm(capturePath(root, '080-missing'));
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_index SET resolved_project_id=NULL WHERE account_id='acct'").run();
  db.prepare("UPDATE capture_project_backfill SET cursor='050',complete=0 WHERE account_id='acct'").run(); db.close();
  const warnings = [], original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    scheduleCaptureProjectBackfill(root, 'acct');
    await waitForIndex(root, index => index.prepare("SELECT complete FROM capture_project_backfill WHERE account_id='acct'").get().complete === 1);
    const done = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
    assert.equal(done.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='zz-good'").get().resolved_project_id, 'demo');
    assert.equal(done.prepare("SELECT cursor FROM capture_project_backfill WHERE account_id='acct'").get().cursor, 'zz-good'); done.close();
    assert.deepEqual(warnings.sort(), ['060-bad','070-mismatch','080-missing'].map(id => `memhub: skipping capture project backfill ${id}`));
    closeCaptureIndexDb(root); scheduleCaptureProjectBackfill(root, 'acct');
    await new Promise(done => setTimeout(done, 40));
    assert.equal(warnings.length, 3, 'completed durable cursor does not replay old failures');
  } finally { console.warn = original; }
}));

test('a workspace capture indexed before project creation re-resolves after registry creation', () => fixture(async ({ root, runtime, add }) => {
  await add('before-project', { workspace_path: '/workspaces/future/src' });
  const before = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
  assert.equal(before.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='before-project'").get().resolved_project_id, ''); before.close();
  assert.deepEqual(await listFreshCaptureEvidence(root, 'acct', { projectIds: ['future'], limit: 4 }), []);
  await runtime.projects.create('acct', { projectId: 'future', description: 'new registry project' });
  const evidence = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['future'], limit: 4 });
  assert.deepEqual(evidence.map(event => event.event_id), ['before-project']);
  await waitForIndex(root, db => db.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='before-project'").get().resolved_project_id === 'future');
}));

test('alias, merge and delete routing changes invalidate and lazily re-derive cached projects', () => fixture(async ({ root, runtime, add }) => {
  await add('changing-project', { project_hint: 'New Alias' });
  await runtime.projects.update('acct', 'demo', { aliases: ['New Alias'] });
  assert.deepEqual((await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 })).map(event => event.event_id), ['changing-project']);
  await waitForIndex(root, db => db.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='changing-project'").get().resolved_project_id === 'demo');
  await runtime.projects.merge('acct', 'demo', 'other');
  scheduleCaptureProjectBackfill(root, 'acct');
  await waitForIndex(root, db => db.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='changing-project'").get().resolved_project_id === 'other');
  assert.deepEqual((await listFreshCaptureEvidence(root, 'acct', { projectIds: ['other'], limit: 4 })).map(event => event.event_id), ['changing-project']);
  await runtime.projects.delete('acct', 'other');
  scheduleCaptureProjectBackfill(root, 'acct');
  await waitForIndex(root, db => db.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='changing-project'").get().resolved_project_id === '');
  assert.deepEqual(await listFreshCaptureEvidence(root, 'acct', { projectIds: ['other'], limit: 4 }), []);
  assert.equal(await countUnassignedCaptures(root, 'acct'), 1);
}));

test('70 newer global NULL rows cannot fill the fresh project LIMIT window', () => fixture(async ({ root, add }) => {
  await add('older-project', { project_hint: 'Demo Alias' });
  for (let i = 0; i < 70; i++) {
    await add(`new-global-${i}`, { timestamp: '2026-10-20T01:00:00.000Z' });
    await writeFile(capturePath(root, `new-global-${i}`), 'irrelevant legacy global capture');
  }
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_index SET resolved_project_id=NULL WHERE account_id='acct'").run(); db.close();
  const result = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 });
  assert.deepEqual(result.map(event => event.event_id), ['older-project']);
}));

test('NULL continuity candidates are resolved before file reads and cannot displace cached project evidence', () => fixture(async ({ root, add, assign }) => {
  await add('binding', { continuity_id: 'mixed', timestamp: '2026-10-19T00:00:00.000Z' });
  await assign({ project: 'demo', continuityId: 'mixed' });
  await add('cached-project', { project_hint: 'demo' });
  for (let i = 0; i < 20; i++) {
    await add(`mixed-${i}`, { continuity_id: 'mixed', project_hint: 'other', timestamp: '2026-10-20T01:00:00.000Z' });
    await writeFile(capturePath(root, `mixed-${i}`), 'off-project NULL capture must not be read');
  }
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_index SET resolved_project_id=NULL WHERE event_id LIKE 'mixed-%'").run(); db.close();
  const warnings = [], original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 1 });
    assert.deepEqual(result.map(event => event.event_id), ['cached-project']);
    assert.deepEqual(warnings, []);
  } finally { console.warn = original; }
}));

test('context and turn clarification share the persisted 30-minute continuity throttle', () => fixture(async ({ root, call }) => {
  const query = 'Please investigate this unresolved project routing without assuming a project.';
  assert.ok((await call('memmy_context', { query, continuity_id: 'throttled' })).clarification);
  assert.equal((await call('memmy_context', { query, continuity_id: 'throttled' })).clarification, undefined);
  assert.equal((await call('memmy_turn', { action: 'open', user_text: query, continuity_id: 'throttled' })).project_resolution, undefined);
  assert.ok((await call('memmy_context', { query, continuity_id: 'separate' })).clarification);
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_project_questions SET asked_at=? WHERE account_id='acct' AND continuity_id='throttled'").run(Date.now() - 30 * 60_000 - 1); db.close();
  assert.ok((await call('memmy_context', { query, continuity_id: 'throttled' })).clarification);
}));

test('clarification is substantive/privacy gated, compact, top-three and rate-limited per account/continuity', () => fixture(async ({ root, runtime }) => {
  const base = { stateRoot: root, accountId: 'acct', projects: runtime.projects, continuityId: 'thread', rateLimit: true, now: 1000 };
  assert.equal(await projectClarification({ ...base, text: 'hello' }), undefined);
  assert.equal(await projectClarification({ ...base, text: '<private>' + 'hidden'.repeat(20) + '</private>' }), undefined);
  const text = 'Please investigate this routing error and explain which project owns it.';
  const first = await projectClarification({ ...base, text });
  assert.ok(first); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 600); assert.ok(first.candidates.length <= 3);
  assert.ok(Buffer.byteLength(JSON.stringify(first, null, 2).replace(/\n/g, '\n  ')) <= 600);
  assert.match(first.ask.en, /user approval/);
  assert.equal(await projectClarification({ ...base, text, now: 1001 }), undefined);
  assert.ok(await projectClarification({ ...base, text, now: 1_801_000 }));
  assert.ok(await projectClarification({ ...base, text: '/workspaces/demo/src', continuityId: 'path' }));
  assert.ok(await projectClarification({ ...base, text: '```ts\nx\n```', continuityId: 'code' }));
}));

test('MCP open/commit clarify once, assign binds new ingests; explicit and keep-global suppress questions', () => fixture(async ({ call }) => {
  const opened = await call('memmy_turn', { action: 'open', continuity_id: 'mcp-thread', user_text: 'Please investigate project routing and repair the unresolved captures.' });
  assert.ok(opened.project_resolution); assert.equal(opened.project_id, null);
  const committed = await call('memmy_turn', { action: 'commit', event_id: opened.event_id, assistant_text: 'Completed audit.' });
  assert.equal(committed.continuity_id, 'mcp-thread'); assert.equal(committed.project_resolution, undefined);
  await call('memmy_turn', { action: 'assign', project: 'Demo Alias', continuity_id: 'mcp-thread' });
  const later = await call('memmy_turn', { action: 'open', continuity_id: 'mcp-thread', user_text: 'Continue investigating the same project routing and capture assignment.' });
  assert.equal(later.project_id, 'demo'); assert.equal(later.project_resolution, undefined);
  const context = await call('memmy_context', { query: 'Continue investigating the same project routing and capture assignment.', continuity_id: 'mcp-thread' });
  assert.equal(context.resolvedProjectId, 'demo'); assert.equal(context.clarification, undefined);
  const explicit = await call('memmy_turn', { action: 'open', project: 'demo', user_text: 'This substantive request is explicitly scoped to the demo project.' });
  assert.equal(explicit.project_resolution, undefined);
  await call('memmy_turn', { action: 'assign', keep_global: true, continuity_id: 'mcp-thread' });
  const global = await call('memmy_turn', { action: 'open', continuity_id: 'mcp-thread', user_text: 'This substantive follow-up should intentionally remain globally scoped.' });
  assert.equal(global.project_id, null); assert.equal(global.project_resolution, undefined);
}));

test('MCP context clarifies unresolved substantive queries only, within 600 bytes; private turn is safe', () => fixture(async ({ call }) => {
  const result = await call('memmy_context', { query: 'Please investigate unresolved routing without assuming a particular project.' });
  assert.ok(result.clarification); assert.ok(Buffer.byteLength(JSON.stringify(result.clarification)) <= 600);
  assert.equal((await call('memmy_context', { query: 'hello' })).clarification, undefined);
  assert.equal((await call('memmy_context', { query: 'Please investigate this explicitly scoped project request.', project: 'demo' })).clarification, undefined);
  const hidden = await call('memmy_turn', { action: 'open', user_text: '<private>' + 'secret '.repeat(20) + '</private>' });
  assert.equal(hidden.project_resolution, undefined);
  await assert.rejects(call('memmy_turn', { action: 'assign', project: 'unknown', event_ids: [hidden.event_id] }), /unknown project/);
}));

test('admin queue is grouped/newest first/paginated, excludes incomplete/private/foreign/keep-global', () => fixture(async ({ root, runtime, add, assign }) => {
  await add('older'); await add('newer', { timestamp: '2026-10-20T00:01:00.000Z' });
  await add('second', { continuity_id: 'second' });
  await add('private', { user_text: '<private>hidden</private>', assistant_text: '<private>hidden</private>' });
  await add('open', { capture_status: 'open' }); await add('foreign', {}, 'foreign');
  await add('global', { continuity_id: 'global' }); await assign({ keepGlobal: true, eventIds: ['global'] });
  const queue = await listUnassignedCaptures({ stateRoot: root, accountId: 'acct', projects: runtime.projects, limit: 1 });
  assert.equal(queue.unresolved_count, 3); assert.equal(queue.total, 2); assert.equal(queue.has_more, true);
  assert.equal(queue.items[0].continuity_id, 'thread'); assert.equal(queue.items[0].count, 2);
  assert.equal(queue.items[0].events[0].event_id, 'newer');
}));

class Response extends EventEmitter {
  headers = {}; statusCode = 200;
  setHeader(k, v) { this.headers[k] = v; }
  writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); return this; }
  end(body = '') { this.body = body; return this; }
}
test('admin handlers require admin/caller account, reject cross-account and cap/validate assignments', () => fixture(async ({ root, runtime, add }) => {
  await add('own'); await add('foreign', {}, 'foreign');
  const account = { account_id: 'acct', username: 'test', role: 'admin' };
  const base = { stateRoot: root, runtime, accounts: [account], selectedAccount: account, adminView: true, callerAccountId: 'acct' };
  for (const extra of [{ adminView: false }, { callerAccountId: 'foreign' }, { callerAccountId: undefined }]) {
    const response = new Response();
    await handleMemoryControlRead({ ...base, ...extra, response, url: new URL('http://test/custom/admin/api?kind=unassigned') });
    assert.equal(response.statusCode, 403);
  }
  const read = new Response(); await handleMemoryControlRead({ ...base, response: read, url: new URL('http://test/custom/admin/api?kind=unassigned') });
  assert.equal(read.statusCode, 200); assert.equal(JSON.parse(read.body).unresolved_count, 1);
  const action = async (body, extra = {}) => {
    const request = Readable.from([JSON.stringify({ action: 'assign-captures', ...body })]);
    request.headers = { 'content-type': 'application/json' };
    const response = new Response();
    await handleMemoryControlAction({ ...base, ...extra, request, response }); return response;
  };
  assert.equal((await action({ project: 'demo', event_ids: ['own'] }, { adminView: false })).statusCode, 403);
  assert.equal((await action({ project: 'demo', event_ids: ['own'] }, { callerAccountId: 'foreign' })).statusCode, 403);
  assert.equal((await action({ project: 'demo', account_id: 'foreign', event_ids: ['own'] })).statusCode, 403);
  assert.equal((await action({ project: 'demo', event_ids: ['foreign'] })).statusCode, 404);
  assert.equal((await action({ project: 'unknown', event_ids: ['own'] })).statusCode, 400);
  assert.equal((await action({ project: 'demo', event_ids: Array(201).fill('own') })).statusCode, 400);
  assert.equal((await action({ project: 'demo', event_ids: ['own'] })).statusCode, 200);
}));

test('HTTP gateway owner can list/assign/keep-global/count; auth, CSRF and cross-account checks hold under every base path', { timeout: 30_000 }, async () => {
  const core = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: [], total: 0, stats: {} }));
  });
  await new Promise((done, reject) => { core.once('error', reject); core.listen(0, '127.0.0.1', done); });
  try {
    for (const basePath of ['/', '/memhub', '/custom/nested']) {
      const root = await createTestRoot('p6-project-http-');
      isolateTestEnvironment(root, root);
      const owner = await addAccount(root, 'owner');
      const foreign = await addAccount(root, 'foreign');
      await setAccountRole(root, owner.account_id, 'admin');
      const token = await ensureLocalAdminToken(root);
      const runtime = createMemhubRuntime({ controlRoot: root, accountId: owner.account_id, disableArchitecture: true });
      let child;
      try {
        await runtime.projects.create(owner.account_id, { projectId: 'demo', aliases: ['Demo Alias'], description: 'HTTP fixture' });
        const add = (event_id, continuity_id, account_id = owner.account_id, project_hint) => storeCaptureEvent(root,
          { account_id, actor_id: 'http-fixture' }, { event_id, host: 'test', conversation_id: 'transport', continuity_id,
            timestamp: at, project_hint, user_text: 'Please investigate the unresolved project routing in this substantive request.',
            assistant_text: 'Done.', capture_status: 'complete' });
        await add('assign-event', 'assign', owner.account_id, '灵巧手');
        await add('global-one', 'global'); await add('global-two', 'global');
        await add('foreign-event', 'foreign', foreign.account_id);
        const eventPath = join(root, 'captures', hash(owner.account_id), hash('assign-event') + '.json');
        const before = await readFile(eventPath);
        child = spawn(process.execPath, ['dist/mcp.js', '--http', '0', '--base-path', basePath, '--state-root', root,
          '--account', owner.account_id, '--memory-url', `http://127.0.0.1:${core.address().port}`, '--memory-token', 'http-test-only', '--no-architecture'],
          { env: testEnvironment(root, root), stdio: ['ignore', 'ignore', 'pipe'] });
        const stderr = [];
        child.stderr.on('data', chunk => stderr.push(chunk.toString()));
        const endpoint = await new Promise((done, reject) => {
          const timeout = setTimeout(() => reject(new Error('isolated HTTP gateway startup timeout')), 8000);
          const ready = chunk => {
            const match = stderr.join('').match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timeout); child.stderr.off('data', ready); done(match[1]); }
          };
          child.stderr.on('data', ready);
          child.once('exit', code => { clearTimeout(timeout); reject(new Error(`isolated gateway exited ${code}`)); });
        });
        const headers = { authorization: `Basic ${Buffer.from(`local:${token}`).toString('base64')}`, 'content-type': 'application/json' };
        const url = (suffix, query = {}) => endpoint + webPath(basePath, suffix) + '?' + new URLSearchParams(query);
        const get = async query => {
          const response = await fetch(url('/admin/api', query), { headers });
          const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
        };
        const post = async (body, query = {}, extraHeaders = {}) => {
          const response = await fetch(url('/admin/action', query), { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ action: 'assign-captures', ...body }) });
          const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
        };
        const unauthenticated = await fetch(url('/admin/api', { kind: 'unassigned' }));
        assert.equal(unauthenticated.status, 401); await unauthenticated.text();
        const queue = await get({ kind: 'unassigned', limit: '1' });
        assert.equal(queue.status, 200); assert.equal(queue.data.unresolved_count, 3);
        assert.equal(queue.data.total, 2); assert.equal(queue.data.has_more, true);
        assert.ok(!JSON.stringify(queue.data).includes('foreign-event'));
        assert.equal((await get({ kind: 'unassigned' })).data.items.find(item => item.continuity_id === 'assign').candidate, '灵巧手');
        const overview = await get({ kind: 'overview' });
        assert.equal(overview.status, 200); assert.equal(overview.data.unresolved_count, 3);
        assert.equal((await get({ kind: 'unassigned', account_id: foreign.account_id })).status, 403);
        assert.equal((await get({ kind: 'unassigned', account_id: 'does-not-exist' })).status, 404);
        assert.equal((await post({ project: 'demo', event_ids: ['foreign-event'] })).status, 404);
        assert.equal((await post({ project: 'demo', event_ids: ['foreign-event'] }, { account_id: foreign.account_id })).status, 403);
        assert.equal((await post({ keep_global: true, continuity_id: 'foreign' }, { account_id: foreign.account_id })).status, 403);
        assert.equal((await post({ project: 'demo', event_ids: ['assign-event'], account_id: foreign.account_id })).status, 403);
        assert.equal((await post({ project: 'demo', event_ids: ['assign-event'] }, {}, { origin: 'https://foreign.invalid' })).status, 403);
        const assigned = await post({ project: 'Demo Alias', event_ids: ['assign-event'] });
        assert.equal(assigned.status, 200); assert.equal(assigned.data.assigned, 1);
        const projectL1 = await get({ kind: 'l1', project: 'demo' });
        assert.equal(projectL1.status, 200);
        assert.ok(projectL1.data.items.some(item => item.event_id === 'assign-event' && item.project_id === 'demo'));
        const replay = await post({ project: 'demo', event_ids: ['assign-event'] });
        assert.equal(replay.status, 200); assert.equal(replay.data.assigned, 0); assert.equal(replay.data.unchanged, 1);
        assert.equal((await get({ kind: 'overview' })).data.unresolved_count, 2);
        const remaining = await get({ kind: 'unassigned' });
        assert.equal(remaining.status, 200); assert.equal(remaining.data.items[0].continuity_id, 'global');
        const kept = await post({ keep_global: true, continuity_id: 'global' });
        assert.equal(kept.status, 200); assert.equal(kept.data.assigned, 2);
        assert.equal((await get({ kind: 'overview' })).data.unresolved_count, 0);
        assert.equal((await get({ kind: 'unassigned' })).data.total, 0);
        assert.deepEqual(await readFile(eventPath), before);
        const db = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
        assert.equal(db.prepare("SELECT COUNT(*) n FROM capture_project_assignments WHERE account_id=? AND assigned_by='admin' AND scope='event'").get(owner.account_id).n, 3);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM capture_project_assignments WHERE account_id=?').get(foreign.account_id).n, 0);
        db.close();
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise(done => {
            const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
            child.once('exit', () => { clearTimeout(timeout); done(); }); child.kill('SIGTERM');
          });
        }
        runtime.dispose(); closeCaptureIndexDb(root); await rm(root, { recursive: true, force: true });
      }
    }
  } finally { await new Promise(done => core.close(done)); }
});

test('queue UI preserves base paths, escapes content, parses and uses existing mutation feedback', () => {
  const account = { account_id: 'acct', username: 'test', role: 'admin' };
  for (const basePath of ['/', '/memhub', '/custom/nested']) {
    const html = renderConsole({ account, accounts: [account], selectedAccountId: 'acct', projects: [], adminView: true, localControl: true, basePath });
    assert.ok(html.includes('data-view="unassigned"'));
    assert.ok(html.includes('<option value="unassigned"'));
    assert.ok(html.includes('assign-captures')); assert.ok(html.includes('data-global-event'));
    assert.ok(html.includes('esc(x.first_user_line)'));
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
    assert.ok(html.includes(JSON.stringify((basePath === '/' ? '' : basePath) + '/admin/action')));
  }
});


test('NULL continuities remain separate event groups and the rendered action assigns event_ids', () => fixture(async ({ root, runtime, add, assign }) => {
  await add('null-one'); await add('null-two');
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.exec(`CREATE TABLE nullable_index AS SELECT * FROM capture_index;
    DROP TABLE capture_index; ALTER TABLE nullable_index RENAME TO capture_index;
    UPDATE capture_index SET continuity_id=NULL`);
  db.close();
  const queue = await listUnassignedCaptures({ stateRoot: root, accountId: 'acct', projects: runtime.projects });
  assert.equal(queue.total, 2); assert.equal(queue.unresolved_count, 2);
  assert.deepEqual(queue.items.map(group => group.group_key).sort(), ['event:null-one', 'event:null-two']);
  assert.ok(queue.items.every(group => group.continuity_id === null && group.events.length === 1));
  const account = { account_id: 'acct', username: 'test', role: 'admin' };
  const html = renderConsole({ account, accounts: [account], selectedAccountId: 'acct', projects: [], adminView: true, localControl: true });
  const source = html.slice(html.indexOf('async function assignUnassigned('), html.indexOf('function renderL1('));
  const posted = [];
  const action = new Function('window', 'runMutation', 'postAction', 'toast', 'load', 'lang', source + ';return assignUnassigned;')(
    { visibleItems: queue.items }, async (_key, _trigger, run) => run(), async body => posted.push(body), () => {}, async () => {}, 'en');
  await action('0', false, false, 'demo');
  assert.deepEqual(posted, [{ action: 'assign-captures', event_ids: [queue.items[0].events[0].event_id], project: 'demo' }]);
  await assign({ eventIds: posted[0].event_ids, project: 'demo' });
  assert.equal(await countUnassignedCaptures(root, 'acct'), 1);
}));

test('registry revision preserves queue truth during backfill, including unreadable assigned files and NULL caches', () => fixture(async ({ root, runtime, add, assign }) => {
  await add('assigned'); await assign({ eventIds: ['assigned'], project: 'demo' });
  await add('kept', { continuity_id: 'kept' }); await assign({ eventIds: ['kept'], keepGlobal: true });
  await add('workspace', { continuity_id: 'workspace', workspace_path: '/workspaces/demo' });
  await add('unresolved', { continuity_id: 'unresolved' });
  for (const id of ['assigned', 'kept', 'workspace']) await writeFile(capturePath(root, id), 'unreadable capture');
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  db.prepare("UPDATE capture_index SET resolved_project_id=NULL WHERE event_id IN ('assigned','kept')").run(); db.close();
  await runtime.projects.create('acct', { projectId: 'revision-change', name: 'revision-change', description: 'routing revision fixture' });
  const warnings = [], original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // Each read schedules/reuses the worker; even failed rows retain their previous routing value.
    for (let i = 0; i < 30; i++) {
      assert.equal(await countUnassignedCaptures(root, 'acct'), 1);
      const queue = await listUnassignedCaptures({ stateRoot: root, accountId: 'acct', projects: runtime.projects });
      assert.equal(queue.unresolved_count, 1); assert.deepEqual(queue.items.flatMap(x => x.events.map(e => e.event_id)), ['unresolved']);
      await new Promise(done => setTimeout(done, 5));
    }
    await waitForIndex(root, db => db.prepare("SELECT complete FROM capture_project_backfill WHERE account_id='acct'").get().complete === 1);
    const check = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
    try { assert.equal(check.prepare("SELECT resolved_project_id FROM capture_index WHERE event_id='workspace'").get().resolved_project_id, 'demo'); }
    finally { check.close(); }
    assert.equal(warnings.length, 3);
  } finally { console.warn = original; }
}));

test('L1 exact indexed pagination survives 550 newer nonmatching continuity candidates', () => fixture(async ({ root, add, assign }) => {
  await add('binding', { timestamp: '2026-10-19T00:00:00.000Z' });
  await assign({ project: 'demo', continuityId: 'thread' });
  for (let i = 0; i < 3; i++) await add(`match-${i}`, { project_hint: 'demo', timestamp: `2026-10-20T00:00:0${i}.000Z` });
  await add('nonmatch-template', { project_hint: 'other', timestamp: '2026-10-20T01:00:00.000Z' });
  closeCaptureIndexDb(root);
  const db = new Database(join(root, 'capture-index.sqlite'));
  const columns = db.pragma('table_info(capture_index)').map(column => column.name);
  const select = columns.map(column => column === 'event_id' ? '?' : column === 'resolved_project_id' ? 'NULL' : column).join(',');
  const clone = db.prepare(`INSERT INTO capture_index (${columns.join(',')}) SELECT ${select} FROM capture_index WHERE event_id='nonmatch-template'`);
  db.transaction(() => { for (let i = 0; i < 550; i++) clone.run(`nonmatch-${i}`); })(); db.close();
  const first = await listL1Turns({ stateRoot: root, accountId: 'acct', projectId: 'demo', limit: 2 });
  const second = await listL1Turns({ stateRoot: root, accountId: 'acct', projectId: 'demo', limit: 2, offset: 2 });
  assert.deepEqual(first.map(turn => turn.event_id), ['match-2', 'match-1']);
  assert.deepEqual(second.map(turn => turn.event_id), ['match-0', 'binding']);
}));

test('L1 prefetches all page assignments in one readonly snapshot before registry I/O', () => fixture(async ({ root, runtime, add }) => {
  for (let i = 0; i < 12; i++) await add(`snapshot-${i}`, { project_hint: 'demo' });
  const original = Database.prototype.prepare, snapshots = new Set();
  let assignmentReads = 0, registryReads = 0;
  Database.prototype.prepare = function(sql) {
    if (/SELECT \* FROM capture_project_assignments/.test(sql)) { snapshots.add(this); assignmentReads++; }
    return original.call(this, sql);
  };
  try {
    const turns = await listL1Turns({ stateRoot: root, accountId: 'acct', limit: 12,
      resolveProject: ref => {
        registryReads++; assert.equal(assignmentReads, 24, 'event and continuity decisions for the entire page were prefetched');
        return runtime.projects.resolve('acct', ref);
      } });
    assert.equal(turns.length, 12); assert.equal(snapshots.size, 1); assert.equal(registryReads, 1);
    assert.equal(assignmentReads, 24, 'no per-row index rereads after the page snapshot');
  } finally { Database.prototype.prepare = original; }
}));

test('assignment resolves registry I/O before its synchronous transaction and lookup failure leaves no decision', () => fixture(async ({ root, runtime, add, assign }) => {
  await add('tx-one', { project_hint: 'unknown' }); await add('tx-two', { timestamp: '2026-10-20T00:01:00.000Z' });
  const db = await withCaptureIndexDb(root, db => db);
  const original = runtime.projects.resolve.bind(runtime.projects);
  let reads = 0;
  runtime.projects.resolve = async (account, ref) => {
    reads++; assert.equal(db.inTransaction, false, 'registry I/O must never hold the shared SQLite transaction');
    await new Promise(done => setImmediate(done));
    assert.equal(db.inTransaction, false);
    return original(account, ref);
  };
  assert.equal((await assign({ project: 'demo', continuityId: 'thread', eventIds: ['tx-two'] })).assigned, 1);
  assert.ok(reads >= 2);
  assert.deepEqual(db.prepare("SELECT resolved_project_id FROM capture_index ORDER BY event_id").all().map(x => x.resolved_project_id), ['demo','demo']);
  const before = db.prepare('SELECT COUNT(*) AS n FROM capture_project_assignments').get().n;
  runtime.projects.resolve = async (account, ref) => { if (ref === 'unknown') throw new Error('registry unavailable'); return original(account, ref); };
  await assert.rejects(assign({ project: 'other', continuityId: 'thread' }), /registry unavailable/);
  assert.equal(db.inTransaction, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_project_assignments').get().n, before);
}));
