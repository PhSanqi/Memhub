import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';
import { storeCaptureEvent, listFreshCaptureEvidence, closeCaptureIndexDb } from '../dist/capture.js';
import { MemoryRestContextSource, clipFreshText } from '../dist/memory-source.js';
import { captureCoreRawTurnId, captureTurnId } from '../dist/capture-ingest.js';
import { renderConsole } from '../dist/web-ui.js';
import { buildTurnKnowledgePlan } from '../dist/turn-knowledge-plan.js';
import { buildContextCapsule } from '../dist/context-capsule.js';
import { createMemhubRuntime } from '../dist/runtime.js';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const hit = (layer, updatedAt = '2026-10-19T00:00:00.000Z', id = layer) => ({
  id, kind: 'profile', memoryLayer: layer, status: 'activated', snippet: `${layer} retrieval repair history`,
  score: 0.9, tags: ['project:demo'], source: 'search', updatedAt
});
const request = { accountId: 'acct', userId: 'user', query: 'retrieval repair', projectId: 'demo', limit: 8 };
const fresh = result => result.projectMemory.filter(item => item.provenance?.freshness === 'undistilled');
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(run) {
  const root = await createTestRoot('p6-fresh-');
  isolateTestEnvironment(root, root);
  const add = (event_id, overrides = {}, account_id = 'acct') => storeCaptureEvent(root, { account_id, actor_id: 'test' }, {
    event_id, host: 'test', conversation_id: 'transport', continuity_id: 'continuity', project_hint: 'demo',
    timestamp: '2026-10-20T00:00:00.000Z', user_text: 'retrieval repair request', assistant_text: 'retrieval repair complete',
    capture_status: 'complete', ...overrides
  });
  const source = (hits = [hit('L3'), hit('L2')], raw = []) => new MemoryRestContextSource({
    async search(req) { return { hits: req.layers.includes('L3') || req.layers.includes('L2') ? hits : req.layers.includes('L1') ? raw : [] }; }
  }, root);
  try { await run({ root, add, source }); }
  finally { closeCaptureIndexDb(root); await rm(root, { recursive: true, force: true }); }
}

test('stale L2 admits labelled fresh L1 after L3 and before chronology', () => fixture(async ({ add, source }) => {
  await add('fresh');
  const result = await source().recall(request);
  assert.deepEqual(result.projectMemory.map(item => item.id), ['L3', 'fresh', 'L2']);
  const item = fresh(result)[0];
  assert.equal(item.authority, 'evidence');
  assert.equal(item.provenance.memoryLayer, 'L1');
  assert.equal(item.evidenceRef, 'l1:fresh');
  assert.equal(item.projectId, 'demo');
}));

test('newer or equal L2 watermark excludes distilled captures', () => fixture(async ({ add, source }) => {
  await add('old');
  for (const timestamp of ['2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z']) {
    assert.equal(fresh(await source([hit('L2', timestamp)]).recall(request)).length, 0);
  }
}));

test('fresh caps are four turns, 600 chars each, 2400 chars total; newest first', () => fixture(async ({ add, source }) => {
  for (let i = 0; i < 7; i++) await add(`event-${i}`, {
    timestamp: `2026-10-20T00:00:0${i}.000Z`, user_text: `retrieval repair ${'😀'.repeat(500)}`, assistant_text: 'repair '.repeat(200)
  });
  const items = fresh(await source().recall(request));
  assert.deepEqual(items.map(item => item.id), ['event-6', 'event-5', 'event-4', 'event-3']);
  assert.ok(items.every(item => item.content.length <= 600 && !/[\uD800-\uDBFF]$/.test(item.content)));
  assert.ok(items.reduce((sum, item) => sum + item.content.length, 0) <= 2400);
  assert.ok(items.every(item => item.content.includes('Assistant:')));
}));

test('no project uses only two complete turns of explicit continuity', () => fixture(async ({ add, source }) => {
  for (let i = 0; i < 3; i++) await add(`same-${i}`, { timestamp: `2026-10-20T00:00:0${i}.000Z` });
  await add('wrong-continuity', { continuity_id: 'other', timestamp: '2026-10-21T00:00:00.000Z' });
  const result = await source().recall({ ...request, projectId: null, continuityId: 'continuity' });
  assert.deepEqual(fresh(result).map(item => item.id), ['same-2', 'same-1']);
  assert.ok(fresh(result).every(item => item.authority === 'evidence' && !item.projectId));
  assert.equal(fresh(await source().recall({ ...request, projectId: null })).length, 0);
  assert.equal(fresh(await source().recall({ ...request, projectId: null, conversationId: 'continuity' })).length, 0);
}));

test('privacy-excluded, incomplete, other project and account never enter fresh evidence', () => fixture(async ({ add, source }) => {
  await add('allowed');
  await add('private', { user_text: '<private>private data</private>', assistant_text: '<no-memory>private reply</no-memory>' });
  for (const capture_status of ['open', 'partial', 'truncated', 'failed']) await add(capture_status, { capture_status });
  await add('other-project', { project_hint: 'other' });
  await add('other-account', {}, 'other-account');
  assert.deepEqual(fresh(await source().recall(request)).map(item => item.id), ['allowed']);
}));

test('legacy raw capture is redacted again on read without changing its stored bytes', () => fixture(async ({ root, add, source }) => {
  await add('legacy');
  const path = join(root, 'captures', hash('acct'), `${hash('legacy')}.json`);
  const event = JSON.parse(await readFile(path, 'utf8'));
  const secret = `sk-proj-${'a'.repeat(48)}`;
  event.user_text = `retrieval repair key ${secret} <private>hidden data</private>`;
  await writeFile(path, JSON.stringify(event));
  const before = await readFile(path, 'utf8');
  const indexPath = join(root, 'capture-index.sqlite');
  const indexBefore = await readFile(indexPath);
  const metadata = await stat(indexPath);
  const result = fresh(await source().recall(request));
  assert.equal(result.length, 1);
  assert.ok(!result[0].content.includes(secret));
  assert.ok(!result[0].content.includes('hidden data'));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.equal((await stat(indexPath)).mtimeMs, metadata.mtimeMs);
}));

test('very low lexical relevance stays behind L2, relevant fresh evidence survives a small limit', () => fixture(async ({ add, source }) => {
  await add('unrelated', { user_text: 'botanical garden visit', assistant_text: 'orchids bloomed' });
  assert.deepEqual((await source().recall(request)).projectMemory.map(item => item.id), ['L3', 'L2', 'unrelated']);
  await add('relevant', { timestamp: '2026-10-20T01:00:00.000Z' });
  assert.deepEqual((await source().recall({ ...request, limit: 2 })).projectMemory.map(item => item.id), ['L3', 'relevant']);
}));

test('L1-only Core fallback is retained without duplicate capture evidence', () => fixture(async ({ add, source }) => {
  await add('captured');
  const raw = [
    { ...hit('L1', undefined, 'raw-core'), snippet: 'independent retrieval repair evidence' },
    { ...hit('L1', undefined, captureTurnId('acct', 'test', 'captured')), snippet: 'retrieval repair request retrieval repair complete' }
  ];
  const result = await source([], raw).recall(request);
  assert.ok(result.projectMemory.some(item => item.id === 'raw-core'));
  assert.ok(!result.projectMemory.some(item => item.id === captureTurnId('acct', 'test', 'captured')));
  assert.equal(result.diagnostics.lanes.project.candidateCount, 3);
  assert.equal(result.diagnostics.lanes.project.dedupedCount, 2);
  assert.equal(new Set(result.projectMemory.map(item => item.id)).size, result.projectMemory.length);
}));

test('project storage aliases and latest fetched L2 watermark are respected', () => fixture(async ({ add, source }) => {
  await add('historical', { project_hint: 'old-demo' });
  const result = await source().recall({ ...request, projectStorageIds: ['demo', 'old-demo'] });
  assert.ok(fresh(result).some(item => item.id === 'historical' && item.projectId === 'demo'));
  const newer = hit('L2', '2026-10-21T00:00:00.000Z', 'newest');
  assert.equal(fresh(await source([hit('L2'), newer]).recall(request)).length, 0);
}));

test('read helper requires account and project or continuity scope and handles an empty store', () => fixture(async ({ root }) => {
  assert.deepEqual(await listFreshCaptureEvidence(root, 'acct', { limit: 4 }), []);
  assert.deepEqual(await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 }), []);
  await assert.rejects(listFreshCaptureEvidence(root, '', { projectIds: ['demo'], limit: 4 }));
}));


test('knowledge plan labels fresh turns as supporting evidence without hydration', () => fixture(async ({ add, source }) => {
  await add('fresh-plan');
  const recalled = await source().recall(request);
  const plan = await buildTurnKnowledgePlan({
    query: request.query,
    capsule: { ...recalled, projectArchitecture: [], resolvedProjectId: 'demo', recallScope: 'global_and_project',
      ambiguities: [], contextBudget: { truncatedItems: 0, droppedItems: 0 } },
    hydrateEvidence: async () => { throw new Error('fresh L1 must not require hydration'); }
  });
  assert.equal(plan.required.some(item => item.kind === 'L1'), false);
  const evidence = plan.supporting.find(item => item.id === 'fresh-plan');
  assert.equal(evidence.kind, 'L1');
  assert.equal(evidence.evidence_ref, 'l1:fresh-plan');
  assert.equal(evidence.reason, 'undistilled_turn_evidence');
}));


test('L3 without L2 still admits complete local evidence, even before Core ingest', () => fixture(async ({ add, source }) => {
  await add('before-ingest');
  const result = await source([hit('L3')]).recall(request);
  assert.deepEqual(result.projectMemory.map(item => item.id), ['L3', 'before-ingest']);
  assert.equal(fresh(result)[0].evidenceRef, 'l1:before-ingest');
}));


test('capsule keeps resolved evidence and admits only explicitly scoped unbound continuity evidence when unresolved', () => {
  const item = { id: 'fresh', evidenceRef: 'l1:fresh', content: 'retrieval repair', authority: 'evidence',
    scope: 'project', source: 'memhub-capture',
    provenance: { memoryLayer: 'L1', freshness: 'undistilled', continuityId: 'continuity' } };
  const input = { accountId: 'acct', resolution: { projectId: null, source: 'none', recallScope: 'global_only', candidates: [], evidence: [] },
    projectMemory: [item, { ...item, id: 'bound', projectId: 'demo' },
      { ...item, id: 'wrong', provenance: { ...item.provenance, continuityId: 'wrong' } },
      { ...item, id: 'remembered', authority: 'remembered' },
      { ...item, id: 'not-fresh', provenance: { ...item.provenance, freshness: 'distilled' } } ] };
  assert.equal(buildContextCapsule(input).projectMemory.length, 0);
  assert.equal(buildContextCapsule({ ...input, conversationId: 'continuity' }).projectMemory.length, 0);
  const capsule = buildContextCapsule({ ...input, continuityId: 'continuity' });
  assert.deepEqual(capsule.projectMemory.map(item => item.id), ['fresh']);
  assert.equal(capsule.resolvedProjectId, null);
  assert.equal(capsule.recallScope, 'global_only');
  const resolved = buildContextCapsule({ ...input, resolution: { ...input.resolution, projectId: 'demo', recallScope: 'global_and_project' } });
  assert.deepEqual(resolved.projectMemory.map(item => item.id), ['bound']);
});

test('memmy_context returns populated fresh evidence through runtime, router and MCP; load and why hydrate its exact L1 ref', () => fixture(async ({ root, add }) => {
  const runtime = createMemhubRuntime({ accountId: 'acct', controlRoot: root, disableArchitecture: true,
    memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '' });
  runtime.memoryClient.search = async req => ({ debug: { hits: req.layers.includes('L2') ? [hit('L3'), hit('L2')] : [] } });
  await runtime.projects.create('acct', { projectId: 'demo', description: 'Retrieval repair project' });
  for (let i = 0; i < 5; i++) await add(`mcp-${i}`, { timestamp: `2026-10-20T00:00:0${i}.000Z`,
    user_text: `retrieval repair request ${i} ${'u'.repeat(500)}`, assistant_text: `retrieval repair complete ${i} ${'a'.repeat(500)}` });
  await add('mcp-open', { capture_status: 'open' });
  await add('mcp-private', { user_text: '<private>hidden</private>', assistant_text: '<private>hidden</private>' });
  await add('mcp-other-account', {}, 'other-account');
  const server = createMemhubMcpServerForRuntime(runtime, root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'p6-fresh', version: '1.0' });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, `${name} must succeed`);
    return { data: JSON.parse(response.content[0].text), bytes: Buffer.byteLength(response.content[0].text, 'utf8') };
  };
  try {
    const { data, bytes } = await call('memmy_context', { query: 'retrieval repair', project: 'demo', cross_project_skills: false });
    assert.equal(data.resolvedProjectId, 'demo');
    assert.deepEqual(fresh(data).map(item => item.id), ['mcp-4', 'mcp-3', 'mcp-2', 'mcp-1']);
    assert.equal(data.projectMemory[0].provenance.memoryLayer, 'L3');
    assert.ok(fresh(data).every(item => item.authority === 'evidence' && item.projectId === 'demo' &&
      item.provenance.memoryLayer === 'L1' && item.evidenceRef === `l1:${item.id}`));
    assert.ok(fresh(data).every(item => item.content.length <= 600));
    assert.ok(bytes < 10000, 'populated brief MCP response must remain below 10000 bytes');
    console.log(`p6_populated_brief_bytes=${bytes}`);
    const item = fresh(data)[0];
    assert.equal(item.provenance.hydration.evidence_ref, item.evidenceRef);
    const { data: loaded } = await call('memhub_memory', { action: 'load', evidence_ref: item.evidenceRef });
    assert.equal(loaded.item.evidence_ref, 'l1:mcp-4');
    assert.equal(loaded.item.layer, 'L1');
    assert.equal(loaded.item.memory_id, 'mcp-4');
    assert.match(loaded.item.content, /retrieval repair complete 4/);
    assert.ok(loaded.item.content.length > item.content.length);
    const { data: why } = await call('memhub_memory', { action: 'why', evidence_ref: item.evidenceRef, query: 'retrieval repair' });
    assert.equal(why.evidence_ref, item.evidenceRef);
    assert.equal(why.root.layer, 'L1');
    const { data: noContinuity } = await call('memmy_context', { query: 'continue the repair', conversation_id: 'continuity', cross_project_skills: false });
    assert.equal(noContinuity.resolvedProjectId, null);
    assert.equal(noContinuity.projectMemory.length, 0);
    const { data: continued } = await call('memmy_context', { query: 'continue the repair', continuity_id: 'continuity', cross_project_skills: false });
    assert.equal(continued.resolvedProjectId, null);
    assert.equal(continued.recallScope, 'global_only');
    assert.deepEqual(fresh(continued).map(item => item.id), ['mcp-4', 'mcp-3']);
    assert.ok(fresh(continued).every(item => item.authority === 'evidence' && !item.projectId));
    assert.equal((await runtime.projects.list('acct')).length, 1, 'continuity must not create projects');
  } finally {
    await client.close();
    await server.close();
    runtime.dispose();
  }
}));

test('Core raw-turn ids from the L1 fallback are deduped for the same fresh capture', () => fixture(async ({ add, source }) => {
  await add('core-raw');
  const rawId = captureCoreRawTurnId('acct', 'test', 'core-raw');
  const raw = [{ ...hit('L1', undefined, rawId), snippet: 'retrieval repair request retrieval repair complete' }];
  const result = await source([], raw).recall(request);
  assert.deepEqual(result.projectMemory.map(item => item.id), ['core-raw']);
  assert.equal(result.projectMemory.filter(item => item.id === rawId).length, 0);
  assert.deepEqual(fresh(result).map(item => item.id), ['core-raw']);
}));

test('fresh evidence SQL is bounded before file reads', () => fixture(async ({ root, add }) => {
  // 40 complete captures pass the SQL filter but are privacy-excluded after
  // reading. With LIMIT 4*8=32 the older valid capture is never reached.
  for (let i = 0; i < 40; i++) {
    await add(`excluded-${i}`, {
      timestamp: `2026-10-20T00:00:${String(i).padStart(2, '0')}.000Z`,
      user_text: '<private>excluded</private>', assistant_text: '<no-memory>excluded</no-memory>'
    });
  }
  await add('old-valid', { timestamp: '2026-10-19T00:00:00.000Z' });
  assert.deepEqual(await listFreshCaptureEvidence(root, 'acct', { projectIds: ['demo'], limit: 4 }), []);
}));

test('missing or identity-mismatched capture files are skipped with id-only warnings', () => fixture(async ({ root, add, source }) => {
  await add('deleted');
  await add('mismatch', { timestamp: '2026-10-20T00:00:01.000Z' });
  await add('intact', { timestamp: '2026-10-20T00:00:02.000Z' });
  const captureDir = join(root, 'captures', hash('acct'));
  await rm(join(captureDir, `${hash('deleted')}.json`));
  const mismatchPath = join(captureDir, `${hash('mismatch')}.json`);
  const mismatched = JSON.parse(await readFile(mismatchPath, 'utf8'));
  mismatched.event_id = 'some-other-event';
  await writeFile(mismatchPath, JSON.stringify(mismatched));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await source().recall(request);
    assert.deepEqual(fresh(result).map(item => item.id), ['intact']);
    assert.deepEqual(result.projectMemory.map(item => item.id), ['L3', 'intact', 'L2']);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.some(line => line.includes('deleted')), true);
  assert.equal(warnings.some(line => line.includes('mismatch')), true);
  assert.ok(warnings.every(line => !line.includes('retrieval repair')), 'warnings must not include capture text');
}));

test('clipFreshText treats non-positive budgets as empty', () => {
  assert.equal(clipFreshText('abc', 0), '');
  assert.equal(clipFreshText('abc', -5), '');
  assert.equal(clipFreshText('', 0), '');
  assert.equal(clipFreshText('abc', 10), 'abc');
  assert.equal(clipFreshText('abcdef', 4), 'abc…');
});

test('L1 include-incomplete is sent only when toggled and the toggle re-queries', () => {
  const html = renderConsole({
    account: { account_id: 'acct', username: 'tester', role: 'user' },
    accounts: [{ account_id: 'acct', username: 'tester', role: 'user' }],
    projects: [], adminView: false, localControl: true, selectedAccountId: 'acct'
  });
  assert.match(html, /if\(kind==='l1'&&includeIncompleteToggle\?\.checked\)q\.set\('include_incomplete','1'\)/);
  assert.doesNotMatch(html, /if\(kind==='l1'\)q\.set\('include_incomplete','1'\)/);
  assert.match(html, /includeIncompleteToggle\.onchange=\(\)=>load\(current\)/);
});
