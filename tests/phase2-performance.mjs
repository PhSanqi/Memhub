import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { FileProjectArchitectureSource } from '../dist/architecture-source.js';
import { captureIndexStats, captureIndexWatermark, closeCaptureIndexDb, listCaptureEvents, markCaptureIngested, readCaptureAuditSnapshot, storeCaptureEvent } from '../dist/capture.js';
import { discoverDistillationJobs } from '../dist/distillation-discovery.js';
import { listDistillationJobs, setDistillationConfig } from '../dist/distillation-jobs.js';
import { auditDistillationPipeline } from '../dist/distillation-audit.js';
import { JsonResultTransport, RESULT_TTL_MS } from '../dist/result-transport.js';
import { createMemhubRuntime } from '../dist/runtime.js';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { MemoryRestContextSource } from '../dist/memory-source.js';
import { rankRecallHits } from '../dist/retrieval-ranker.js';

const root = await createTestRoot('phase2-regressions-');
isolateTestEnvironment(root, join(root, 'architecture'));
const account = 'phase2';
const actor = { account_id: account, actor_id: 'test' };
async function capture(state, id, extra = {}) {
  return storeCaptureEvent(state, actor, { event_id: id, host: 'test', conversation_id: 'chat', continuity_id: 'chat',
    timestamp: '2026-10-18T00:00:00.000Z', project_hint: 'alpha', user_text: `User ${id}`, assistant_text: `Assistant ${id}`,
    capture_status: 'complete', ...extra });
}
async function snapshot(path) {
  const entries = {};
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name), info = await stat(file), key = relative(path, file);
      entries[key] = { mode: info.mode, mtimeMs: info.mtimeMs, size: info.isDirectory() ? null : info.size,
        hash: info.isFile() ? createHash('sha256').update(await readFile(file)).digest('hex') : null };
      if (info.isDirectory()) await walk(file);
    }
  }
  await walk(path); return entries;
}
function child(code, args) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}

async function registryCache() {
  const path = join(root, 'registry.json'), registry = new JsonProjectRegistry(path);
  await registry.create(account, { projectId: 'alpha', description: 'cache-fixture' });
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = (text, ...args) => { if (typeof text === 'string' && text.includes('cache-fixture')) parses++; return originalParse(text, ...args); };
  try {
    await Promise.all(Array.from({ length: 40 }, () => registry.storageIds(account, 'alpha')));
    await registry.resolve(account, 'alpha'); await registry.list(account);
    assert.equal(parses, 1, 'parallel reads validate/parse once per fill');
  } finally { JSON.parse = originalParse; }
  const copy = (await registry.list(account))[0]; copy.aliases.push('poison'); copy.description = 'poison';
  assert.deepEqual(await registry.storageIds(account, 'alpha'), ['alpha']);
  await registry.update(account, 'alpha', { description: 'own update' });
  assert.equal((await registry.list(account))[0].description, 'own update');
  child(`import { JsonProjectRegistry } from './dist/project-registry.js'; await new JsonProjectRegistry(process.argv[1]).update('phase2','alpha',{description:'cross-process update'});`, [path]);
  assert.equal((await registry.list(account))[0].description, 'cross-process update');
  child(`import { readFile, writeFile } from 'node:fs/promises'; const path=process.argv[1];
    await writeFile(path,(await readFile(path,'utf8')).replaceAll('cross-process update','same-inode modification'));`, [path]);
  assert.equal((await registry.list(account))[0].description, 'same-inode modification');
  await registry.update(account, 'alpha', { description: 'cross-process update' });
  const before = await stat(path), text = await readFile(path, 'utf8');
  const replacement = path + '.replacement';
  await writeFile(replacement, text.replace('cross-process update', 'equal-length-replace'));
  await utimes(replacement, before.atime, before.mtime); await rename(replacement, path);
  assert.equal((await registry.list(account))[0].description, 'equal-length-replace', 'inode invalidates same-size/same-mtime replacement');
  await writeFile(path, text.replace('"projectId": "alpha"', '"projectId": ".."'));
  await assert.rejects(registry.list(account), /safe path segment/);
  console.log('P2-1 registry: PASS');
}

async function architectureCache() {
  const architectureRoot = join(root, 'architecture'), managedRootDir = join(root, 'managed');
  await mkdir(architectureRoot, { recursive: true });
  const source = new FileProjectArchitectureSource({ rootDir: architectureRoot, managedRootDir });
  assert.deepEqual(await source.listProjects(account), []);
  await mkdir(join(architectureRoot, 'alpha'), { recursive: true });
  await writeFile(join(architectureRoot, 'alpha', 'package.json'), '{}');
  await writeFile(join(architectureRoot, 'alpha', 'ARCHITECTURE.md'), '# Architecture');
  assert.deepEqual(await source.listProjects(account), [], 'discovery cached within TTL');
  assert.deepEqual(await source.listProjects('other'), ['alpha'], 'account caches independent');
  const doc = await source.inspectProjectArchitecture({ accountId: account, projectId: 'alpha' });
  await source.writeProjectArchitecture({ accountId: account, projectId: 'alpha', expectedPath: doc.path, expectedFingerprint: doc.fingerprint, content: '# Managed Architecture' });
  assert.deepEqual(await source.listProjects(account), ['alpha'], 'own write invalidates discovery');
  const second = new FileProjectArchitectureSource({ rootDir: architectureRoot, managedRootDir });
  assert.deepEqual(await second.listProjects(account), ['alpha']);
  await mkdir(join(architectureRoot, 'beta'), { recursive: true });
  await writeFile(join(architectureRoot, 'beta', 'package.json'), '{}');
  await writeFile(join(architectureRoot, 'beta', 'ARCHITECTURE.md'), '# Beta');
  const now = Date.now; Date.now = () => now() + 30_001;
  try { assert.deepEqual(await source.listProjects(account), ['alpha', 'beta']); } finally { Date.now = now; }
  const gamma = await second.inspectProjectArchitecture({ accountId: account, projectId: 'gamma' });
  await second.writeProjectArchitecture({ accountId: account, projectId: 'gamma', expectedPath: gamma.path,
    expectedFingerprint: gamma.fingerprint, content: '# Gamma' });
  assert.deepEqual(await source.listProjects(account), ['alpha', 'beta', 'gamma'], 'another source in this process invalidates the shared cache');
  console.log('P2-4 architecture: PASS');
}

async function pureCaptureReads() {
  const state = join(root, 'captures'); await capture(state, 'one'); await markCaptureIngested(state, account, 'one');
  const index = join(state, 'capture-index.sqlite');
  const db = new Database(index); assert.equal(db.pragma('journal_mode', { simple: true }), 'wal'); db.close();
  for (const openWriter of [true, false]) {
    if (!openWriter) closeCaptureIndexDb(state);
    const before = await snapshot(state);
    assert.equal((await listCaptureEvents(state, account)).length, 1);
    assert.equal((await captureIndexStats(state, account)).ingested, 1);
    assert.equal((await readCaptureAuditSnapshot(state, account)).ingestedComplete.length, 1);
    await auditDistillationPipeline({ stateRoot: state, accountId: account, resolveProject: async h => h });
    assert.deepEqual(await snapshot(state), before, `whole-tree zero-write audit (writer=${openWriter})`);
  }
  // A dirty index must never be repaired by a read.
  const dirty = new Database(index); dirty.prepare('INSERT INTO capture_index_dirty VALUES (?,?)').run(account, 'one'); dirty.close();
  const beforeDirty = await snapshot(state);
  await assert.rejects(listCaptureEvents(state, account), /existing clean index/);
  await assert.rejects(readCaptureAuditSnapshot(state, account), /existing clean index/);
  assert.deepEqual(await snapshot(state), beforeDirty);
  // The explicit capture mutator repairs it and remains usable after disposal.
  await capture(state, 'two');
  assert.equal((await listCaptureEvents(state, account)).length, 2);
  closeCaptureIndexDb(state);
  const missing = join(root, 'missing-index');
  await mkdir(join(missing, 'captures', createHash('sha256').update(account).digest('hex')), { recursive: true });
  await writeFile(join(missing, 'captures', createHash('sha256').update(account).digest('hex'), 'orphan.json'), '{}');
  const beforeMissing = await snapshot(missing);
  await assert.rejects(listCaptureEvents(missing, account), /existing clean index/);
  await assert.rejects(readCaptureAuditSnapshot(missing, account), /existing clean index/);
  assert.deepEqual(await snapshot(missing), beforeMissing);
  for (const jobs of [{ version: 1, jobs: [{ job_id: 'legacy', account_id: account, project_id: 'alpha',
    status: 'pending', reason: 'manual', created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z',
    evidence: [{ event_id: 'one', timestamp: '2026-10-18T00:00:00.000Z', user_text: 'user', assistant_text: 'assistant' }] }] }, { version: 2, jobs: {} }]) {
    await mkdir(join(state, 'distillation'), { recursive: true });
    await writeFile(join(state, 'distillation', 'jobs.json'), JSON.stringify(jobs));
    const before = await snapshot(state);
    const audit = () => auditDistillationPipeline({ stateRoot: state, accountId: account, resolveProject: async h => h });
    if (jobs.version === 1) await audit();
    else await assert.rejects(audit(), /jobs must be an array/);
    assert.deepEqual(await snapshot(state), before, 'v1/invalid jobs audit performs zero writes');
  }
  const runtime = createMemhubRuntime({ controlRoot: state, accountId: account, disableArchitecture: true });
  await capture(state, 'three');
  child(`import { storeCaptureEvent, markCaptureIngested, closeCaptureIndexDb } from './dist/capture.js';
    const state=process.argv[1]; await storeCaptureEvent(state,{account_id:'phase2',actor_id:'test'},
    {event_id:'child',host:'test',conversation_id:'chat',timestamp:'2026-10-18T00:00:00Z',user_text:'child',assistant_text:'reply',capture_status:'complete'});
    await markCaptureIngested(state,'phase2','child'); closeCaptureIndexDb(state);`, [state]);
  assert.equal((await listCaptureEvents(state, account)).length, 4, 'two process handles see each other writes');
  const beforeChildRead = await snapshot(state);
  child(`import { listCaptureEvents } from './dist/capture.js'; await listCaptureEvents(process.argv[1],'phase2');`, [state]);
  assert.deepEqual(await snapshot(state), beforeChildRead, 'separate-process WAL reads perform zero filesystem changes');
  runtime.dispose();
  await assert.rejects(stat(index + '-wal'), { code: 'ENOENT' }, 'runtime disposal closes the last writer');
  console.log('P2-5/P2-6 capture WAL + pure reads: PASS');
}

async function transport() {
  const state = join(root, 'transport'); await mkdir(state);
  const payload = { text: 'Evidence 界😀'.repeat(35_000) };
  const before = await snapshot(state);
  const t = new JsonResultTransport(state, account), first = t.wrap(payload, { readOnly: true });
  let text = first.result_chunk, next = first.result_transport.next_offset;
  const otherInstance = new JsonResultTransport(state, account);
  while (next !== null) { const part = otherInstance.read(first.result_transport.result_id, next); text += part.result_chunk; next = part.result_transport.next_offset; }
  assert.deepEqual(JSON.parse(text), payload);
  assert.deepEqual(await snapshot(state), before, 'large readonly result + continuation perform zero writes');
  assert.throws(() => new JsonResultTransport(state, 'other').read(first.result_transport.result_id));
  const disk = t.wrap(payload), spool = join(state, 'result-spool', createHash('sha256').update(account).digest('hex').slice(0, 24));
  const old = new Date(Date.now() - RESULT_TTL_MS - 1000);
  const expired = [];
  for (let i = 0; i < 160; i++) { const path = join(spool, `${randomUUID()}.json`); await writeFile(path, 'expired'); await utimes(path, old, old); expired.push(path); }
  const protectedFile = join(spool, 'revision-evidence.json'); await writeFile(protectedFile, 'protected'); await utimes(protectedFile, old, old);
  t.wrap(payload);
  const firstScanFiles = new Set(await readdir(spool));
  const remaining = expired.filter(path => firstScanFiles.has(path.split(/[\\/]/).at(-1))).length;
  assert.ok(remaining >= 96 && remaining < 160, 'one retention pass scans at most 64 entries');
  for (let i = 0; i < 5; i++) t.wrap(payload);
  for (const path of expired) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await readFile(protectedFile, 'utf8'), 'protected');
  assert.equal(t.read(disk.result_transport.result_id).result_transport.offset, 0, 'fresh spool survives retention');
  const now = Date.now; Date.now = () => now() + RESULT_TTL_MS + 1;
  try { assert.throws(() => otherInstance.read(first.result_transport.result_id), /result spool expired; rerun the original Memhub tool/); }
  finally { Date.now = now; }
  console.log('P2-6 transport memory + bounded retention: PASS');
}

async function discovery() {
  const state = join(root, 'discovery');
  const config = await setDistillationConfig(state, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });
  await capture(state, 'a'); await capture(state, 'b');
  await markCaptureIngested(state, account, 'a'); await markCaptureIngested(state, account, 'b');
  const now = new Date(Date.now() + 1000);
  const run = (offset = 0, extra = {}) => discoverDistillationJobs({ stateRoot: state, accountId: account, resolveProject: async h => h,
    enqueue: true, skipUnchanged: true, now: new Date(now.getTime() + offset), ...extra });
  assert.equal((await run()).queued, 1);
  assert.equal((await run(60_000)).scanned, 0, 'unchanged successful reconciliation skipped');
  assert.equal((await run(15 * 60_000)).scanned, 2, 'periodic full scan at 15 minutes');
  const watermark = await captureIndexWatermark(state, account);
  await capture(state, 'c'); await markCaptureIngested(state, account, 'c');
  assert.notEqual(await captureIndexWatermark(state, account), watermark);
  assert.equal((await run(16 * 60_000)).waiting, 1);
  assert.equal((await run(17 * 60_000)).scanned, 0, 'waiting history skips until idle deadline');
  assert.equal((await run(31 * 60_000)).queued, 1, 'unchanged waiting capture still becomes idle');
  assert.equal((await listDistillationJobs(state, account)).length, 2, 'exactly once');
  await setDistillationConfig(state, { idle_minutes: 45 });
  assert.equal((await run(32 * 60_000)).scanned, 3, 'configuration invalidates skip');
  assert.equal((await run(33 * 60_000, { enqueue: false })).scanned, 3, 'dry run retains full report');
  assert.ok(config.auto_since); closeCaptureIndexDb(state);
  console.log('P2-7 discovery watermark + periodic scan + idle/exactly once: PASS');
}

async function projectPayload() {
  const state = join(root, 'mcp'), runtime = createMemhubRuntime({ controlRoot: state, accountId: account, disableArchitecture: true });
  await runtime.projects.create(account, { projectId: 'alpha', description: '😀'.repeat(281), aliases: ['first'] });
  await runtime.projects.addTodo(account, 'alpha', 'Pending work');
  const server = createMemhubMcpServerForRuntime(runtime, state), client = new Client({ name: 'phase2', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const call = async (name, args) => { const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, response.content[0].text); return JSON.parse(response.content[0].text); };
  try {
    const before = await snapshot(state);
    for (const [name, args] of [['memmy_project_list', {}], ['memmy_project', { action: 'list' }]]) {
      const summary = await call(name, args), detail = await call(name, { ...args, detail: true });
      const s = (summary.projectDetails ?? summary.projects)[0], d = (detail.projectDetails ?? detail.projects)[0];
      assert.deepEqual(Object.keys(s).sort(), ['project','name','aliases','state','descriptionSource','description','descriptionTruncated','pendingTodoCount'].sort());
      assert.equal(Array.from(s.description).length, 280); assert.equal(s.descriptionTruncated, true); assert.equal(s.pendingTodoCount, 1);
      assert.equal(d.description, '😀'.repeat(281)); assert.equal(d.todos.length, 1); assert.equal(d.pendingTodos.length, 1);
    }
    assert.deepEqual(await snapshot(state), before);
    const matches = await call('memmy_project_list', { query: 'alpha' }); assert.equal(matches.matches[0].descriptionTruncated, true);
    const listed = (await client.listTools()).tools;
    // Compare tool schema/description fingerprints.
    for (const tool of listed) {
      assert.equal(createHash('sha256').update(JSON.stringify([tool.description, tool.inputSchema])).digest('hex'), contracts[tool.name], tool.name);
    }
  } finally { await client.close(); await server.close(); runtime.dispose(); }
  console.log('P2-3 project summary/detail + unchanged tool contracts: PASS');
}

async function skillFanoutConvergence() {
  const skillProjects = ['proj-a', 'proj-b', 'proj-c', 'proj-d', 'proj-e'];
  const allSkills = skillProjects.map((p, i) => ({
    id: `skill-${p}`,
    kind: 'skill',
    memoryLayer: 'Skill',
    status: 'activated',
    title: `Diagnostic ${p}`,
    snippet: `# Diagnostic ${p}\n## When to use\nUse for diagnostics in ${p}.\n## Procedure\nCheck status.`,
    tags: ['artifact:skill', `project:${p}`],
    score: 0.85 - i * 0.05,
    source: 'search',
    retrievalRoutes: ['agent_memory']
  }));
  // More than the former shared 24-candidate window, ordered to starve
  // later projects unless the single request preserves per-project quotas.
  allSkills.splice(1, 0, ...Array.from({ length: 30 }, (_, i) => ({
    ...allSkills[0], id: `flood-${i}`, title: `Routine ${i}`,
    snippet: `Routine maintenance ${i}`, score: 0.84 - i * 0.001
  })));
  allSkills.push({
    id: 'skill-excluded',
    kind: 'skill',
    memoryLayer: 'Skill',
    status: 'activated',
    title: 'Excluded Skill',
    snippet: 'Should never appear in results',
    tags: ['artifact:skill', 'project:unregistered'],
    score: 0.99,
    source: 'search',
    retrievalRoutes: ['agent_memory']
  });

  let searches = 0;
  const client = {
    async search(request) {
      searches++;
      const layers = request.layers ?? [];
      if (layers.includes('L4')) {
        return { debug: { hits: [{ id: 'global-1', kind: 'profile', memoryLayer: 'L4', status: 'activated', snippet: 'Global profile', tags: ['global'], score: 0.9, source: 'search' }] } };
      }
      if (layers.includes('L3') || layers.includes('L2')) {
        return { debug: { hits: [{ id: 'project-l3', kind: 'profile', memoryLayer: 'L3', status: 'activated', snippet: 'Project L3 profile', tags: ['project:proj-a'], score: 0.8, source: 'search' }] } };
      }
      if (layers.includes('Skill')) {
        const scopedHits = allSkills.filter(h => {
          if (request.namespace?.projectId) return h.tags.includes(`project:${request.namespace.projectId}`);
          if (Array.isArray(request.projectIds)) return request.projectIds.some(p => h.tags.includes(`project:${p}`));
          return true;
        });
        const hits = request.projectIds?.length > 1
          ? request.projectIds.flatMap(p => scopedHits.filter(h => h.tags.includes(`project:${p}`)).slice(0, request.limit))
          : scopedHits.slice(0, request.limit);
        return { debug: { hits } };
      }
      return { debug: { hits: [] } };
    }
  };

  const source = new MemoryRestContextSource(client);
  searches = 0;
  const recalled = await source.recall({
    accountId: account,
    userId: 'test',
    query: 'diagnostics troubleshooting',
    projectId: 'proj-a',
    projectStorageIds: ['proj-a'],
    limit: 6,
    reusableSkillProjectIds: skillProjects
  });

  // Core search count for skills dropped to exactly 1 (total 3 for the call)
  assert.equal(searches, 3, 'Core search count for multi-project fixture is 3 (1 global, 1 project, 1 account-level skill)');

  // Compare results against simulated old per-project loop
  const oldSkills = (await Promise.all(skillProjects.map(async (projectId) => {
    const res = await client.search({
      adapterId: 'memhub',
      namespace: { source: 'memhub', profileId: 'default', userId: 'test', tenantId: account, projectId },
      query: 'diagnostics troubleshooting',
      limit: 24,
      layers: ['Skill'],
      tags: ['artifact:skill'],
      verbose: true
    });
    return (res.debug?.hits ?? []).filter(h => h.memoryLayer === 'Skill' && h.tags.includes('artifact:skill') && h.tags.includes(`project:${projectId}`));
  }))).flat().sort((a, b) => b.score - a.score);

  const newSkillIds = recalled.reusableSkills.map(s => s.id);
  assert.deepEqual(newSkillIds, rankRecallHits(oldSkills, 'diagnostics troubleshooting', 6).hits.map(s => s.hit.id), 'Skill results old vs new are identical for multi-project fixture');
  assert.ok(newSkillIds.some(id => id === 'skill-proj-e'), 'later project survives a flooded first project');
  assert.ok(!newSkillIds.includes('skill-excluded'), 'excluded project skill must never appear');
  console.log('P2-2 skill search convergence & identical results: PASS');
}

// The distill fingerprint includes the authorized generation-fenced reconcile_commit action.
const contracts = {"memhub_result":"aba09811776d11c4936a8fd2ff54ff7ed8cec9122b22772b3bbc66ab91e9d93d","memmy_turn":"7f33e823d11eaa61aee3ef88c0a35023fc8fa7b50af48a764be8139504bc88d0","memmy_context":"c1f76ef348f268cf2ebd5f7da0f9ea77f9c25a2f2b72ecdb74440031200b3079","memhub_memory":"bcad026561ec0a8406fb1efc2d1e89f043b5c1b1088c27b7d7fea9d9769709eb","memhub_branch":"7bf46ba1781569d150e14e3c5d20fb4aee436fe878d6f03f2018617f4b63ff9a","memhub_skill":"dad6672351ed28fdff6f0c81aaf7b908d38166eb87552d16a221ac65ef8653f1","memhub_distill":"6f80a876cf1e3bd54de705b925def988e0f54ef753798d20ac22f1ca424ae875","memmy_project_list":"454fbe81a358f02b75b9dbaa010e3dcd669ef19be4844009275f246f5bdc2c54","memhub_todo":"613779078165945be9fddb94f5b20f302ef1829d67c28b3b928d8efd844ee2c7","memmy_project_manage":"bbe854ecac70a9a28ca0b9f428caaeff966a59d3168fffdc0a88e557be4041b9","memmy_project":"07b56b08103e50194a17a482da0f7c9a8f7248ead171164e6b9882158894c68b"};
await registryCache(); await architectureCache(); await pureCaptureReads(); await transport(); await discovery(); await projectPayload(); await skillFanoutConvergence();
console.log('phase2-performance: ok');
