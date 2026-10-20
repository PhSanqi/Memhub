// Opt-in orchestration benchmark: deterministic in-process Core double; no network/model latency.
import { assertTestPaths, createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
// Optional third argument points to an independently compiled baseline inside
// this checkout (for example .tmp-tests/phase2-baseline-source/dist).
// A fourth argument reuses that benchmark fixture for a sequential comparison.
const moduleRoot = resolve(process.argv[3] ?? 'dist');
assertTestPaths({ moduleRoot });
const modules = pathToFileURL(moduleRoot + '/');
const { createMemhubRuntime } = await import(new URL('runtime.js', modules));
const { createMemhubMcpServerForRuntime } = await import(new URL('mcp.js', modules));
const { storeCaptureEvent, markCaptureIngested } = await import(new URL('capture.js', modules));
const { enqueueDerivedDistillationJob } = await import(new URL('distillation-jobs.js', modules));

const root = process.argv[4] ? resolve(process.argv[4]) : await createTestRoot('phase2-benchmark-');
assertTestPaths({ root });
isolateTestEnvironment(root, join(root, 'architecture'));
await mkdir(join(root, 'architecture'), { recursive: true });
const accountId = 'benchmark';
const now = new Date().toISOString();
const projects = Array.from({ length: 40 }, (_, i) => ({
  accountId, projectId: `project-${String(i).padStart(2, '0')}`, name: `Project ${i}`,
  description: `Production-size description ${i}. ` + 'Current truth and engineering context. '.repeat(175),
  distilledDescription: 'Verified project facts. '.repeat(180), descriptionSource: 'distilled',
  todos: Array.from({ length: 20 }, (_, t) => ({ id: `todo-${t}`, text: 'Pending engineering work '.repeat(6), status: 'pending', createdAt: now, updatedAt: now })),
  aliases: [`alias-${i}`], state: 'active', createdAt: now, updatedAt: now
}));
let registryText = JSON.stringify({ version: 1, projects }, null, 2);
if (!process.argv[4]) {
  await writeFile(join(root, 'project-registry.json'), registryText);
  for (let i = 0; i < 1200; i++) {
    await storeCaptureEvent(root, { account_id: accountId, actor_id: 'benchmark' }, {
      event_id: `capture-${i}`, host: 'benchmark', conversation_id: `chat-${i % 40}`, continuity_id: `chat-${i % 40}`,
      timestamp: now, project_hint: projects[i % 40].projectId, user_text: `Request ${i}`, assistant_text: `Response ${i}`, capture_status: 'complete'
    });
    await markCaptureIngested(root, accountId, `capture-${i}`);
  }
  await enqueueDerivedDistillationJob({ stateRoot: root, accountId, target: 'l3', projectId: projects[0].projectId,
    evidence: [{ ref: 'fixture', kind: 'artifact', timestamp: now, content: 'Fixture evidence' }] });
  const jobsPath = join(root, 'distillation', 'jobs.json');
  const template = JSON.parse(await readFile(jobsPath, 'utf8')).jobs[0];
  await writeFile(jobsPath, JSON.stringify({ version: 2, jobs: Array.from({ length: 1000 }, (_, i) => ({ ...template, job_id: `job-${i}`, project_id: projects[i % 40].projectId })) }));
} else registryText = await readFile(join(root, 'project-registry.json'), 'utf8');
const runtime = createMemhubRuntime({ controlRoot: root, accountId, architectureRoot: join(root, 'architecture') });
const skills = projects.slice(0, 30).map((p, i) => ({ id: `skill-${i}`, kind: 'skill', memoryLayer: 'Skill', status: 'activated',
  title: `Diagnostic ${i}`, snippet: `# Diagnostic ${i}\n## When to use\nUse for engineering diagnostics ${i}.\n## Procedure\nRead evidence.`,
  tags: ['artifact:skill', `project:${p.projectId}`], score: 0.8 - i / 1000, source: 'search', retrievalRoutes: ['agent_memory'] }));
let searches = 0;
runtime.memoryClient.search = async (request) => {
  searches++;
  return { debug: { hits: request.layers?.includes('Skill') ? skills.filter(h => !request.namespace?.projectId || h.tags.includes(`project:${request.namespace.projectId}`)).slice(0, request.limit) : [] } };
};
const server = createMemhubMcpServerForRuntime(runtime, root);
const client = new Client({ name: 'phase2-benchmark', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st); await client.connect(ct);
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content[0].text);
  let data = JSON.parse(response.content[0].text);
  let wireBytes = Buffer.byteLength(JSON.stringify(response));
  if (data.result_transport) {
    let text = data.result_chunk, offset = data.result_transport.next_offset;
    while (offset !== null) {
      const next = await client.callTool({ name: 'memhub_result', arguments: { result_id: data.result_transport.result_id, offset } });
      wireBytes += Buffer.byteLength(JSON.stringify(next));
      const part = JSON.parse(next.content[0].text); text += part.result_chunk; offset = part.result_transport.next_offset;
    }
    data = JSON.parse(text);
  }
  return { bytes: Buffer.byteLength(JSON.stringify(data)), wireBytes };
}
try {
  const results = {};
  for (const [name, args] of [['memmy_context', { query: 'engineering diagnostics', project: projects[0].projectId }], ['memmy_project_list', {}], ['memmy_project_list:detail', { detail: true }]]) {
    // The baseline has no detail parameter; its default is already the full shape.
    const tools = await client.listTools();
    const hasDetail = !!tools.tools.find(t => t.name === 'memmy_project_list').inputSchema.properties.detail;
    const actualArgs = name.endsWith(':detail') && !hasDetail ? {} : args;
    const toolName = name.split(':')[0];
    await call(toolName, actualArgs); await call(toolName, actualArgs);
    const samples = []; searches = 0; let size;
    for (let i = 0; i < 12; i++) { const start = performance.now(); size = await call(toolName, actualArgs); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    results[name] = { medianMs: +samples[6].toFixed(2), p95Ms: +samples[11].toFixed(2), ...size, coreSearchesPerCall: searches / 12 };
  }
  const output = { root, moduleRoot, fixture: { registryBytes: Buffer.byteLength(registryText), projects: 40, jobs: 1000, captures: 1200, skillProjects: 30 }, results };
  if (process.argv[2]) {
    const outputPath = resolve(process.argv[2]);
    assertTestPaths({ outputPath });
    await writeFile(outputPath, JSON.stringify({ ...output, tools: (await client.listTools()).tools }, null, 2));
  }
  console.log(JSON.stringify(output, null, 2));
} finally { await client.close(); await server.close(); runtime.dispose?.(); }
