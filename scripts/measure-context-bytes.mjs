import { createTestRoot, isolateTestEnvironment } from '../tests/test-isolation.mjs';
import { createMemhubRuntime } from '../dist/runtime.js';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { ContextRouter } from '../dist/context-router.js';
import { MemoryRestContextSource } from '../dist/memory-source.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function measureContextBytes() {
  const root = await createTestRoot('memhub-measure-');
  isolateTestEnvironment(root, join(root, 'architecture'));
  const projectDir = join(root, 'architecture', 'memhub');
  const archDocsDir = join(projectDir, 'docs', 'architecture');
  await mkdir(archDocsDir, { recursive: true });
  await writeFile(join(projectDir, 'package.json'), '{}');
  await writeFile(join(projectDir, 'ARCHITECTURE.md'), '# Memhub Architecture Overview\n\nHigh-level architectural design.');

  // 4 large architecture docs (~6-8 KB each) with markdown headings and sections
  for (let i = 1; i <= 4; i++) {
    const headings = Array.from({ length: 8 }, (_, h) =>
      `## Section ${h + 1} of Architecture Module ${i}\n\n` +
      `Detailed architectural specifications for component ${i}.${h + 1}. ` +
      `This section establishes contract boundaries, runtime safety constraints, data layouts, and lifecycle guarantees. ` +
      `All implementations must enforce strict validation, idempotent error handling, and memory isolation.\n\n` +
      `Furthermore, secondary subsystems must adhere to zero-trust privilege minimization and deterministic state transitions. ` +
      `Periodic health checks verify ledger invariants, replay logs, and ephemeral locks across all node clusters. ` +
      `Telemetry emitters stream performance diagnostics to the observation pipeline with strict volume budgets.`
    ).join('\n\n');
    await writeFile(join(archDocsDir, `module-${i}.md`), `# Architecture Module ${i}\n\n${headings}`);
  }

  const runtime = createMemhubRuntime({
    controlRoot: root,
    architectureRoot: join(root, 'architecture')
  });

  // Capture ingestion is isolated from any running Memory Core.
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async () => ({});

  const mockClient = {
    async search(req) {
      const layers = req.layers ?? [];
      const project = req.namespace?.projectId;
      if (layers.includes("L2") || layers.includes("L3")) {
        return {
          debug: {
            hits: [
              {
                id: "l2-chronology",
                kind: "decision",
                memoryLayer: "L2",
                status: "activated",
                title: "Memhub L2 Chronology",
                snippet: "# Memhub L2 Chronology\n\n- Milestone 1: SQLite vector indexing.\n- Milestone 2: Distillation pipeline.\n- Milestone 3: MCP tools.",
                score: 0.9,
                tags: ["l2", `project:${project}`],
                source: "search",
                retrievalRoutes: ["agent_memory"]
              },
              {
                id: "l3-truth",
                kind: "profile",
                memoryLayer: "L3",
                status: "activated",
                title: "Memhub L3 Current Truth",
                snippet: "# Memhub L3 Current Truth\n\n- Rule 1: Always resolve project from explicit evidence; never guess.\n- Rule 2: Plan -> user approval -> execute for mutations.\n- Rule 3: EvidenceRef must pass through.",
                score: 0.95,
                tags: ["l3", `project:${project}`, "current_truth"],
                source: "search",
                retrievalRoutes: ["agent_memory"]
              }
            ]
          }
        };
      }
      return { debug: { hits: [] } };
    }
  };

  const memorySource = new MemoryRestContextSource(mockClient);
  runtime.router = new ContextRouter(memorySource, runtime.architecture, runtime.projects, runtime.branches);

  const server = createMemhubMcpServerForRuntime(runtime, root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'measure-client', version: '1.0' });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // Register project
    await runtime.projects.create(runtime.accountId, {
      projectId: 'memhub',
      name: 'Memhub Runtime',
      description: 'Private account/project-scoped long-term memory system with provenance and temporal continuity.'
    });

    // Add project todos
    await runtime.projects.addTodo(runtime.accountId, 'memhub', 'Verify context diet footprint under 10000 bytes');
    await runtime.projects.addTodo(runtime.accountId, 'memhub', 'Ensure progressive disclosure backward compatibility');

    // 1. Measure tools/list payload size
    const toolsList = await client.listTools();
    const toolsListJson = JSON.stringify(toolsList);
    const toolsListBytes = Buffer.byteLength(toolsListJson, 'utf8');

    // 2. Measure memmy_context brief (default)
    const briefRes = await client.callTool({
      name: 'memmy_context',
      arguments: {
        query: 'architecture contracts and runtime safety constraints',
        project: 'memhub'
      }
    });
    const briefText = briefRes.content[0].text;
    const briefBytes = Buffer.byteLength(briefText, 'utf8');

    // 3. Measure memmy_context full
    const fullRes = await client.callTool({
      name: 'memmy_context',
      arguments: {
        query: 'architecture contracts and runtime safety constraints',
        project: 'memhub',
        detail: 'full'
      }
    });
    const fullText = fullRes.content[0].text;
    const fullBytes = Buffer.byteLength(fullText, 'utf8');

    const results = {
      toolsListBytes,
      briefBytes,
      fullBytes,
      briefSavingsPct: ((fullBytes - briefBytes) / fullBytes * 100).toFixed(1)
    };

    return results;
  } finally {
    await client.close();
    await server.close();
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('measure-context-bytes.mjs')) {
  const stats = await measureContextBytes();
  console.log('--- Context Footprint Measurement Results ---');
  console.log(`tools/list payload:     ${stats.toolsListBytes.toLocaleString()} bytes`);
  console.log(`memmy_context (brief):  ${stats.briefBytes.toLocaleString()} bytes`);
  console.log(`memmy_context (full):   ${stats.fullBytes.toLocaleString()} bytes`);
  console.log(`Reduction / Savings:    ${stats.briefSavingsPct}%`);
}
