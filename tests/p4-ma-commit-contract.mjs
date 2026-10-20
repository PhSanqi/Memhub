import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import commitFs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryDb } from '../vendor/memory-core/src/storage/db.js';
import { MemoryService } from '../vendor/memory-core/src/service/memory-service.js';
import { createMemoryHttpServer, closeMemoryHttpServer } from '../vendor/memory-core/src/server/http.js';
import { MemoryRestContextSource } from '../dist/memory-source.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { LocalMemoryRestClient, MemoryCoreHttpError } from '../dist/local-memory-client.js';
import { submitDistillationControl, reconcileDistillationCommit, pruneDistillationCommitRecords,
  writeDistillationCommitFile } from '../dist/distillation-submit.js';
import { withFileMutationLock } from '../dist/file-mutation-lock.js';
import { attachExactDistillationEvidenceRefs, exactDistillationRevisionForMemory,
  canonicalDistillationBody } from '../dist/distillation-contract.js';
import { hydrateMemoryEvidence } from '../dist/memory-hydration.js';
import { enqueueLegacyL1DistillationJob, leaseDistillationJob, listDistillationJobs,
  renewDistillationJobLease, completeDistillationJobAfterCoreCommit, failDistillationJobForLeaseGeneration,
  prepareDistillationLeaseForExternalWrite, retireDistillationMemory } from '../dist/distillation-jobs.js';

const scratch = '/tmp/p4-ma';
await mkdir(scratch, { recursive: true });
const accountId = 'ma-account', projectId = 'ma-project', harness = 'ma-harness';
const evidence = [{ ref: 'l1:source', kind: 'turn', layer: 'L1', timestamp: '2026-10-18T00:00:00Z',
  project_id: projectId, user_text: 'source', assistant_text: 'response' }];
const root = () => mkdtemp(join(scratch, 'case-'));
class Response extends EventEmitter {
  statusCode = 200;
  setHeader() {}
  writeHead(status) { this.statusCode = status; return this; }
  end(body) { this.body = body; this.emit('finish'); }
}
async function coreFixture(path = ':memory:') {
  const initialize = async () => { const db = new MemoryDb({ path }); return { db, service: new MemoryService({ db }) }; };
  // Multiple test processes share one Core database; serialize schema/bootstrap,
  // matching the single Core service startup used in the real stack.
  const { db, service } = path === ':memory:' ? await initialize() : await withFileMutationLock(path + '.setup', initialize);
  const server = createMemoryHttpServer({ service, apiKey: 'test-only', agentSourceExecutor: { dispose: async () => {} } });
  const client = new LocalMemoryRestClient({ endpoint: 'http://127.0.0.1', token: 'test-only',
    fetchImpl: async (url, init) => {
      const req = Readable.from(init.body ? [init.body] : []);
      Object.assign(req, { method: init.method, url: new URL(url).pathname,
        headers: { host: '127.0.0.1', ...init.headers }, socket: { remoteAddress: '127.0.0.1' } });
      const res = new Response();
      const finished = new Promise(done => res.once('finish', done));
      server.emit('request', req, res); await finished;
      return new globalThis.Response(res.body, { status: res.statusCode });
    } });
  return { db, service, client, memory: new MemoryRestContextSource(client),
    close: async () => { await closeMemoryHttpServer(server); db.close(); } };
}
function submitInput(stateRoot, memory, job, content = 'Complete source-grounded canonical timeline.') {
  return { stateRoot, sourceHarness: harness, leaseToken: job?.lease_token,
    args: { kind: 'l2', scope: 'project', content, evidence_refs: job?.evidence_refs ?? evidence.map(e => e.ref), ...(job ? { job_id: job.job_id } : {}) },
    runtime: { accountId, userId: accountId, memory,
      source: { platform: 'test', transport: 'test', principalId: accountId, authenticatedAccount: accountId },
      projects: { resolve: async () => projectId } },
    resolveToolScope: async () => ({ projectId, resolutionSource: 'explicit' }),
    validateDistillationEvidenceChain: async () => evidence };
}
async function lease(stateRoot, suffix = 'source', useLeaseToken = true) {
  await enqueueLegacyL1DistillationJob({ stateRoot, accountId, projectId,
    evidence: evidence.map(e => ({ ...e, ref: `l1:${suffix}` })) });
  return leaseDistillationJob(stateRoot, accountId, { harness, useLeaseToken, target: 'l2' });
}
async function expire(stateRoot, jobId) {
  const path = join(stateRoot, 'distillation/jobs.json');
  const store = JSON.parse(await readFile(path, 'utf8'));
  store.jobs.find(j => j.job_id === jobId).leased_until = '2000-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(store));
}
const changes = f => f.db.db.prepare("SELECT count(*) n FROM memory_change_log WHERE source = 'memory.add'").get().n;
const request = (id, content = 'first body') => ({ requestId: id, adapterId: 'ma-test',
  namespace: { userId: accountId, tenantId: accountId, projectId }, layer: 'L2',
  sourceArtifactId: 'timeline', content, deferProcessing: true });
async function worker(stateRoot, resultPath, hold = 0) {
  const log = openSync(join(stateRoot, `child-${resultPath ? resultPath.split('/').at(-1) : 'crash'}.log`), 'w');
  try {
    await new Promise((done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, P4_MA_CRASH: stateRoot, P4_MA_RESULT: resultPath ?? '', P4_MA_HOLD: String(hold) }, stdio: ['ignore', log, log] });
      child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`commit worker ${code}`)));
    });
  } finally { closeSync(log); }
}

if (process.env.P4_MA_CRASH) {
  const stateRoot = process.env.P4_MA_CRASH;
  const f = await coreFixture(join(stateRoot, 'core.sqlite'));
  const result = await submitDistillationControl(submitInput(stateRoot, { distill: async input => {
    if (Number(process.env.P4_MA_HOLD)) await new Promise(done => setTimeout(done, Number(process.env.P4_MA_HOLD)));
    const result = await f.memory.distill(input);
    if (!process.env.P4_MA_RESULT) process.exit(0); // committed Core, no local completion or response
    return result;
  } }));
  await writeFile(process.env.P4_MA_RESULT, JSON.stringify(result));
  await f.close();
} else {
  test('R02 identical concurrent submits write Core once and replay the entire result', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const job = await lease(stateRoot);
      let calls = 0;
      const memory = { distill: async input => {
        calls++;
        // A real jobs mutation while the artifact gate is held must not deadlock.
        await renewDistillationJobLease(stateRoot, accountId, job.job_id, harness, job.lease_token);
        await new Promise(done => setTimeout(done, 40));
        return f.memory.distill(input);
      } };
      const input = submitInput(stateRoot, memory, job);
      const [a, b] = await Promise.all([submitDistillationControl(input), submitDistillationControl(input)]);
      assert.equal(calls, 1); assert.equal(changes(f), 1); assert.deepEqual(a, b);
      assert.equal(f.service.repos.memories.get(a.memory.id).memoryValue, input.args.content);
      assert.equal((await hydrateMemoryEvidence({ stateRoot, accountId, evidenceRef: a.result_evidence_ref })).content, input.args.content);
    } finally { await f.close(); }
  });
  test('R02 conflicting candidates sharing one lease cannot overwrite the winner', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const job = await lease(stateRoot);
      const results = await Promise.allSettled(['winner', 'loser'].map(text =>
        submitDistillationControl(submitInput(stateRoot, f.memory, job, text))));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(changes(f), 1);
      const winning = results.find(r => r.status === 'fulfilled').value;
      assert.equal(f.service.repos.memories.get(winning.memory.id).memoryValue, 'winner');
    } finally { await f.close(); }
  });
  test('R02 two jobs reread canonical history inside the artifact gate', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const first = await lease(stateRoot, 'first'), second = await lease(stateRoot, 'second');
      const results = await Promise.allSettled([
        submitDistillationControl(submitInput(stateRoot, f.memory, first, '# Timeline\n## Prior event\nEvidence')),
        submitDistillationControl(submitInput(stateRoot, f.memory, second, '# Timeline\n## Different event\nEvidence'))
      ]);
      assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
      assert.match(results[1].reason.message, /drop canonical timeline history/); assert.equal(changes(f), 1);
    } finally { await f.close(); }
  });
  test('R02 direct submits serialize and content can legitimately evolve A to B to A', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const input = submitInput(stateRoot, f.memory);
      const [a, b] = await Promise.all([submitDistillationControl(input), submitDistillationControl(input)]);
      assert.deepEqual(a, b); assert.equal(changes(f), 1);
      await submitDistillationControl(submitInput(stateRoot, f.memory, undefined, 'Second revision'));
      const again = await submitDistillationControl(input);
      assert.equal(changes(f), 3);
      assert.equal(f.service.repos.memories.get(again.memory.id).memoryValue, input.args.content);
      assert.notEqual(again.result_evidence_ref, a.result_evidence_ref,
        'returning to older content creates a new immutable revision for this operation');
      assert.equal((await listDistillationJobs(stateRoot, accountId)).filter(job => job.target === 'l2').length, 3);
    } finally { await f.close(); }
  });
  test('R06 real Core requestId replay is exact; changed and long payloads conflict', async () => {
    const f = await coreFixture();
    try {
      const req = request('replay');
      const [a, b] = await Promise.all([f.client.addMemory(req), f.client.addMemory(req)]);
      assert.deepEqual(a, b); assert.equal(changes(f), 1);
      await assert.rejects(f.client.addMemory({ ...req, content: 'changed' }), e => e.status === 409);
      const long = request('long', 'x'.repeat(25_000) + 'A');
      await f.client.addMemory(long);
      await assert.rejects(f.client.addMemory({ ...long, content: 'x'.repeat(25_000) + 'B' }), e => e.status === 409);
      assert.equal(changes(f), 2);
    } finally { await f.close(); }
  });
  test('R06 failure saving replay result rolls back memory, change log and queued jobs', async () => {
    const f = await coreFixture();
    try {
      const save = f.service.repos.runtime.saveIdempotency;
      f.service.repos.runtime.saveIdempotency = () => { throw new Error('injected replay persistence failure'); };
      await assert.rejects(f.client.addMemory(request('rollback')), /HTTP 500/);
      assert.equal(changes(f), 0);
      assert.equal(f.db.db.prepare('SELECT count(*) n FROM memories').get().n, 0);
      assert.equal(f.db.db.prepare('SELECT count(*) n FROM evolution_jobs').get().n, 0);
      f.service.repos.runtime.saveIdempotency = save;
      await f.client.addMemory(request('rollback')); assert.equal(changes(f), 1);
    } finally { await f.close(); }
  });
  test('R06 retention is bounded by age and count', async () => {
    const f = await coreFixture();
    try {
      const r = f.service.repos.runtime;
      r.saveIdempotency('expired', 'hash', {}, '2000-01-01T00:00:00Z');
      assert.equal(r.getIdempotency('expired'), undefined);
      f.db.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
        INSERT INTO idempotency_keys SELECT 'key-'||x, 'hash', '{}', '2026-10-01T00:00:00Z', NULL FROM n`);
      r.saveIdempotency('new', 'hash', {});
      assert.equal(f.db.db.prepare('SELECT count(*) n FROM idempotency_keys').get().n, 10000);
      assert.deepEqual(r.getIdempotency('new').response, {});
    } finally { await f.close(); }
  });
  test('R02/R06 lost response freezes candidate; exact retry replays Core without another write', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      let lose = true;
      const memory = { distill: async input => { const result = await f.memory.distill(input);
        if (lose) { lose = false; throw new TypeError('response lost after commit'); } return result; } };
      const input = submitInput(stateRoot, memory);
      await assert.rejects(submitDistillationControl(input), /response lost/);
      await assert.rejects(submitDistillationControl(submitInput(stateRoot, memory, undefined, 'different')), /unresolved commit/);
      const result = await submitDistillationControl(input);
      assert.equal(changes(f), 1); assert.equal(result.ok, true);
    } finally { await f.close(); }
  });
  test('R02/R06 process death after real Core commit recovers the frozen operation', async () => {
    const stateRoot = await root();
    await worker(stateRoot);
    const f = await coreFixture(join(stateRoot, 'core.sqlite'));
    try {
      assert.equal(changes(f), 1);
      const result = await submitDistillationControl(submitInput(stateRoot, f.memory));
      assert.equal(changes(f), 1); assert.equal(result.ok, true);
      assert.equal((await listDistillationJobs(stateRoot, accountId)).filter(j => j.target === 'l2').length, 1);
    } finally { await f.close(); }
  });
  test('R02 independent processes submit one artifact once and receive the same result', async () => {
    const stateRoot = await root();
    const initial = await coreFixture(join(stateRoot, 'core.sqlite')); await initial.close();
    const paths = [join(stateRoot, 'one.json'), join(stateRoot, 'two.json')];
    await Promise.all(paths.map(path => worker(stateRoot, path)));
    assert.deepEqual(JSON.parse(await readFile(paths[0], 'utf8')), JSON.parse(await readFile(paths[1], 'utf8')));
    const f = await coreFixture(join(stateRoot, 'core.sqlite'));
    try { assert.equal(changes(f), 1); } finally { await f.close(); }
  });
  test('R07 token lease cannot downgrade; stale holder cannot renew, prepare, commit or fail a new generation', async () => {
    const stateRoot = await root(), old = await lease(stateRoot);
    await expire(stateRoot, old.job_id);
    assert.equal(await leaseDistillationJob(stateRoot, accountId, { harness, useLeaseToken: false }), null);
    const next = await leaseDistillationJob(stateRoot, accountId, { harness, useLeaseToken: true });
    assert.notEqual(next.lease_token, old.lease_token);
    for (const mutation of [
      () => renewDistillationJobLease(stateRoot, accountId, old.job_id, harness, old.lease_token),
      () => prepareDistillationLeaseForExternalWrite(stateRoot, accountId, old.job_id, harness, old.lease_token),
      () => completeDistillationJobAfterCoreCommit(stateRoot, accountId, old.job_id,
        { kind: 'l2', resultId: 'stale', content: 'stale', committedAt: new Date().toISOString() }, harness, old.lease_token),
      () => failDistillationJobForLeaseGeneration(stateRoot, accountId, old.job_id, 'stale', harness, old.lease_token)
    ]) await assert.rejects(mutation(), /token is missing or stale/);
    assert.equal((await listDistillationJobs(stateRoot, accountId))[0].lease_token, next.lease_token);
  });
  test('R07 expired owner-only leases require token migration before reuse', async () => {
    const stateRoot = await root(), old = await lease(stateRoot, 'legacy', false);
    await expire(stateRoot, old.job_id);
    const path = join(stateRoot, 'distillation/jobs.json');
    const store = JSON.parse(await readFile(path, 'utf8'));
    delete store.jobs[0].attempts; // pre-generation legacy files may not have an attempts counter
    await writeFile(path, JSON.stringify(store));
    assert.equal(await leaseDistillationJob(stateRoot, accountId, { harness, useLeaseToken: false }), null);
    const next = await leaseDistillationJob(stateRoot, accountId, { harness, useLeaseToken: true });
    assert.ok(next.lease_token);
    await assert.rejects(prepareDistillationLeaseForExternalWrite(stateRoot, accountId, old.job_id, harness), /token is missing or stale/);
  });
  test('R12 exact evidence matches id and full body hash, independent of timestamps', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const result = await submitDistillationControl(submitInput(stateRoot, f.memory));
      const jobs = await listDistillationJobs(stateRoot, accountId);
      const body = f.service.repos.memories.get(result.memory.id).memoryValue;
      assert.equal(exactDistillationRevisionForMemory(jobs, { id: result.memory.id, memoryLayer: 'L2', body }).result_content, body);
      assert.throws(() => exactDistillationRevisionForMemory(jobs, { id: result.memory.id, memoryLayer: 'L2', body: 'wrong revision' }), /content hash does not match/);
      assert.throws(() => exactDistillationRevisionForMemory(jobs, { id: 'other-id', memoryLayer: 'L2', body }), /does not match/);
      const item = { id: result.memory.id, content: 'snippet', updatedAt: '1900-01-01T00:00:00Z', provenance: { memoryLayer: 'L2' } };
      await attachExactDistillationEvidenceRefs({ stateRoot, accountId, items: [item], readMemory: id => f.client.viewerGet(`/api/v1/memory/${id}`) });
      assert.equal(item.evidenceRef, result.result_evidence_ref);
      await f.client.addMemory({ ...request('outside-writer', 'unledgered content'), sourceArtifactId: 'project-timeline:ma-project' });
      await attachExactDistillationEvidenceRefs({ stateRoot, accountId, items: [item], readMemory: id => f.client.viewerGet(`/api/v1/memory/${id}`) });
      assert.equal(item.evidenceRef, undefined); assert.match(item.provenance.exactEvidenceError, /content hash/);
      await assert.rejects(hydrateMemoryEvidence({ stateRoot, accountId, evidenceRef: `l2:other-id:${jobs.find(j => j.target === 'l2').job_id}` }), /exact Memory revision not found/);
    } finally { await f.close(); }
  });
  test('Round 2 P1 exact refs reuse Core sanitization for new and legacy ledger bodies', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const text = 'Heading  \n\n\n\nTrailing\t  \n\nBody';
      const result = await submitDistillationControl(submitInput(stateRoot, f.memory, undefined, text));
      const stored = f.service.repos.memories.get(result.memory.id).memoryValue;
      assert.notEqual(stored, text); assert.equal(result.memory.body, stored);
      const jobs = await listDistillationJobs(stateRoot, accountId);
      const l2 = jobs.find(job => job.target === 'l2'); assert.equal(l2.result_content, stored);
      for (const layer of ['L2', 'L3', 'L4']) {
        const legacy = { ...l2, target: layer.toLowerCase(), result_kind: layer.toLowerCase(), result_content: text };
        delete legacy.result_core_content_hash;
        assert.equal(exactDistillationRevisionForMemory([legacy], { id: l2.result_id, memoryLayer: layer, body: stored }), legacy);
      }
      const path = join(stateRoot, 'distillation/jobs.json'), store = JSON.parse(await readFile(path, 'utf8'));
      store.jobs.find(job => job.job_id === l2.job_id).result_content = text;
      delete store.jobs.find(job => job.job_id === l2.job_id).result_core_content_hash;
      await writeFile(path, JSON.stringify(store));
      assert.equal((await hydrateMemoryEvidence({ stateRoot, accountId, evidenceRef: result.result_evidence_ref })).content, stored);
      const tricky = 'A<memmy_mem<memos_context>x</memos_context>ory_context>hidden B';
      assert.notEqual(canonicalDistillationBody(tricky), canonicalDistillationBody(canonicalDistillationBody(tricky)));
      const next = await submitDistillationControl(submitInput(stateRoot, f.memory, undefined, tricky));
      const actualBody = f.service.repos.memories.get(next.memory.id).memoryValue;
      const revisions = await listDistillationJobs(stateRoot, accountId);
      const current = revisions.find(job => job.result_operation_id && job.result_content === actualBody);
      assert.ok(current.result_core_content_hash);
      assert.equal(exactDistillationRevisionForMemory(revisions, { id: next.memory.id, memoryLayer: 'L2', body: actualBody }).job_id, current.job_id);
      assert.equal((await hydrateMemoryEvidence({ stateRoot, accountId, evidenceRef: next.result_evidence_ref })).content, actualBody);
    } finally { await f.close(); }
  });
  test('Round 2 Core read failures and bad identities only omit the individual ref', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const result = await submitDistillationControl(submitInput(stateRoot, f.memory));
      const items = ['404', 'timeout', 'identity', 'good'].map(probe => ({ id: result.memory.id, probe,
        content: 'snippet', provenance: { memoryLayer: 'L2' } }));
      let index = 0;
      await attachExactDistillationEvidenceRefs({ stateRoot, accountId, items, readMemory: async id => {
        const mode = items[index++].probe;
        if (mode === '404') throw new MemoryCoreHttpError(404, 'deleted while reading');
        if (mode === 'timeout') throw new Error('timeout');
        if (mode === 'identity') return { id: 'wrong' };
        return f.client.viewerGet(`/api/v1/memory/${id}`);
      } });
      for (const item of items.slice(0, 3)) { assert.equal(item.evidenceRef, undefined); assert.ok(item.provenance.exactEvidenceError); }
      assert.equal(items[3].evidenceRef, result.result_evidence_ref);
      await attachExactDistillationEvidenceRefs({ stateRoot, accountId, items,
        readMemory: id => f.client.viewerGet(`/api/v1/memory/${id}`) });
      assert.ok(items.every(item => item.evidenceRef === result.result_evidence_ref && item.provenance.exactEvidenceError === undefined));
    } finally { await f.close(); }
  });
  test('Round 2 eviction of Core replay records never duplicates a frozen write', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const input = submitInput(stateRoot, { distill: async payload => { await f.memory.distill(payload); throw new TypeError('lost response'); } });
      await assert.rejects(submitDistillationControl(input), /lost response/);
      f.db.db.prepare('DELETE FROM idempotency_keys').run();
      input.runtime.memory = f.memory;
      const result = await submitDistillationControl(input);
      assert.equal(result.memory.body, input.args.content); assert.equal(changes(f), 1);
      const next = submitInput(stateRoot, { distill: async payload => { await f.memory.distill(payload); throw new TypeError('second response lost'); } }, undefined, 'New canonical payload');
      await assert.rejects(submitDistillationControl(next), /second response lost/);
      f.db.db.prepare('DELETE FROM idempotency_keys').run();
      const record = (await reconcileDistillationCommit({ stateRoot, runtime: input.runtime, mode: 'inspect' })).commits[0];
      const recovered = await reconcileDistillationCommit({ stateRoot, runtime: input.runtime, mode: 'reconcile',
        commitId: record.commit_id, generation: record.generation });
      assert.equal(recovered.outcome, 'committed'); assert.equal(recovered.frozen_args.source_harness, harness);
      next.runtime.memory = f.memory;
      await submitDistillationControl(next); assert.equal(changes(f), 2);
    } finally { await f.close(); }
  });
  test('Round 2 uncertain 4xx outcomes remain frozen and reconcile without re-sending', async () => {
    for (const status of [408, 429, 404, 425]) {
      const stateRoot = await root(), f = await coreFixture();
      try {
        const input = submitInput(stateRoot, { distill: async payload => { await f.memory.distill(payload); throw new MemoryCoreHttpError(status, 'uncertain proxy response'); } });
        await assert.rejects(submitDistillationControl(input), new RegExp(`HTTP ${status}`));
        await assert.rejects(submitDistillationControl(submitInput(stateRoot, f.memory, undefined, 'different candidate')), /unresolved commit/);
        input.runtime.memory = f.memory;
        await submitDistillationControl(input); assert.equal(changes(f), 1);
      } finally { await f.close(); }
    }
  });
  test('Round 2 operator can inspect, reconcile or explicitly abandon unknown operations with generation fencing', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const input = submitInput(stateRoot, { distill: async () => { throw new TypeError('request never reached Core'); } });
      await assert.rejects(submitDistillationControl(input), /never reached/);
      input.runtime.memory = f.memory;
      await assert.rejects(submitDistillationControl(input), /outcome is unknown/); assert.equal(changes(f), 0);
      const operator = { stateRoot, runtime: input.runtime, mode: 'inspect' };
      const record = (await reconcileDistillationCommit(operator)).commits[0];
      assert.equal(record.payload.content, input.args.content);
      const server = createMemhubMcpServerForRuntime(input.runtime, stateRoot), client = new Client({ name: 'ma-operator', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(st); await client.connect(ct);
        const result = await client.callTool({ name: 'memhub_distill', arguments: { action: 'reconcile_commit', reconcile_mode: 'inspect', commit_id: record.commit_id } });
        assert.ok(!result.isError, result.content[0].text);
        assert.equal(JSON.parse(result.content[0].text).generation, record.generation);
      } finally { await client.close(); await server.close(); }
      const operation = { ...operator, commitId: record.commit_id, generation: record.generation };
      await assert.rejects(reconcileDistillationCommit({ ...operation, mode: 'reconcile' }), /outcome is unknown/);
      await assert.rejects(reconcileDistillationCommit({ ...operation, mode: 'abandon', generation: 'stale' }), /generation changed/);
      await assert.rejects(reconcileDistillationCommit({ ...operation, mode: 'abandon' }), /explicit operator confirmation/);
      await reconcileDistillationCommit({ ...operation, mode: 'abandon', reason: 'Operator verified no Core write', confirmation: `abandon:${record.generation}` });
      await submitDistillationControl(input); assert.equal(changes(f), 1);
    } finally { await f.close(); }
  });
  test('Round 2 success replay cannot revive a retired revision', async () => {
    const stateRoot = await root(), f = await coreFixture();
    try {
      const input = submitInput(stateRoot, f.memory), result = await submitDistillationControl(input);
      await retireDistillationMemory({ stateRoot, accountId, memoryId: result.memory.id, operation: 'deleted',
        mutateCore: () => f.client.viewerDelete(`/api/v1/memory/${result.memory.id}`) });
      await assert.rejects(submitDistillationControl(input), /result is retired/); assert.equal(changes(f), 1);
    } finally { await f.close(); }
  });
  test('Round 2 terminal retention is bounded while unresolved and corrupt records stay protected', async () => {
    const stateRoot = await root(), directory = join(stateRoot, 'distillation/commits');
    const input = submitInput(stateRoot, {});
    const payload = { accountId, userId: accountId, kind: 'l2', projectId, content: 'body', sourceHarness: harness };
    for (let i = 0; i < 258; i++) await writeDistillationCommitFile(join(directory, i.toString(16).padStart(64, '0') + '.json'),
      { generation: String(i), candidateHash: String(i), payload, response: { ok: true }, terminalAt: new Date().toISOString() });
    const pending = join(directory, 'f'.repeat(64) + '.json'), corrupt = join(directory, 'e'.repeat(64) + '.json');
    await writeDistillationCommitFile(pending, { generation: 'pending', candidateHash: 'pending', payload });
    await writeFile(corrupt, '{');
    await pruneDistillationCommitRecords(stateRoot, input.runtime.accountId);
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 258);
    assert.equal(JSON.parse(await readFile(pending, 'utf8')).generation, 'pending'); assert.equal(await readFile(corrupt, 'utf8'), '{');
    assert.ok(!(await readdir(directory)).some(name => name.includes('.tmp-')));
    const agedRoot = await root(), agedDirectory = join(agedRoot, 'distillation/commits');
    const aged = join(agedDirectory, 'a'.repeat(64) + '.json');
    await writeDistillationCommitFile(aged, { generation: 'aged', candidateHash: 'aged', payload,
      rejected: true, terminalAt: '2000-01-01T00:00:00Z' });
    await pruneDistillationCommitRecords(agedRoot, accountId);
    assert.deepEqual(await readdir(agedDirectory), []);
  });
  test('Round 2 commit writes fsync and bound Windows rename retries without losing the old record', async () => {
    const directory = await root(), path = join(directory, 'commit.json');
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalRename = commitFs.rename, originalOpen = commitFs.open;
    let attempts = 0, syncs = 0;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      commitFs.open = async (...args) => {
        const handle = await originalOpen(...args), sync = handle.sync.bind(handle);
        handle.sync = async () => { syncs++; await sync(); }; return handle;
      };
      commitFs.rename = async (...args) => {
        if (++attempts <= 2) throw Object.assign(new Error('simulated Windows AV lock'), { code: 'EPERM' });
        return originalRename(...args);
      };
      await writeDistillationCommitFile(path, { generation: 'durable', candidateHash: 'hash' });
      assert.equal(attempts, 3); assert.equal(syncs, 1);
      attempts = 0;
      commitFs.rename = async () => { attempts++; throw Object.assign(new Error('persistent Windows AV lock'), { code: 'EACCES' }); };
      await assert.rejects(writeDistillationCommitFile(path, { generation: 'failed', candidateHash: 'other' }), /persistent Windows/);
      assert.equal(attempts, 6); assert.equal(syncs, 2);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).generation, 'durable');
      assert.deepEqual(await readdir(directory), ['commit.json']);
    } finally {
      commitFs.rename = originalRename; commitFs.open = originalOpen;
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
  test('Round 2 cross-process gate survives a hold longer than the Core HTTP timeout', async () => {
    const stateRoot = await root(), initial = await coreFixture(join(stateRoot, 'core.sqlite')); await initial.close();
    const firstPath = join(stateRoot, 'one.json'), secondPath = join(stateRoot, 'two.json');
    const first = worker(stateRoot, firstPath, 16_200);
    const deadline = Date.now() + 5000;
    while (true) {
      const names = await readdir(join(stateRoot, 'distillation/commits')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (names.some(name => name.endsWith('.json'))) break;
      if (Date.now() > deadline) throw new Error('worker did not acquire artifact gate');
      await new Promise(done => setTimeout(done, 10));
    }
    await Promise.all([first, worker(stateRoot, secondPath)]);
    assert.deepEqual(JSON.parse(await readFile(firstPath, 'utf8')), JSON.parse(await readFile(secondPath, 'utf8')));
    const f = await coreFixture(join(stateRoot, 'core.sqlite'));
    try { assert.equal(changes(f), 1); } finally { await f.close(); }
  });
}
