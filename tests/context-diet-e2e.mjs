import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';
import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createMemhubRuntime } from '../dist/runtime.js';
import { createMemhubMcpServerForRuntime } from '../dist/mcp.js';
import { ContextRouter } from '../dist/context-router.js';
import { MemoryRestContextSource } from '../dist/memory-source.js';
import { buildContextCapsule } from '../dist/context-capsule.js';

async function runContextDietTests() {
  const root = await createTestRoot('memhub-diet-e2e-');
  isolateTestEnvironment(root, join(root, 'architecture'));
  const projectDir = join(root, 'architecture', 'memhub');
  const archDocsDir = join(projectDir, 'docs', 'architecture');
  await mkdir(archDocsDir, { recursive: true });
  await writeFile(join(projectDir, 'package.json'), '{}');
  await writeFile(join(projectDir, 'ARCHITECTURE.md'), '# Memhub Architecture Overview\n\nHigh-level architectural design.');

  // Create 4 large architecture docs (~6-8 KB each) with markdown headings and sections
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
      if (layers.includes('L2') || layers.includes('L3')) {
        return {
          debug: {
            hits: [
              {
                id: 'l2-chronology',
                kind: 'decision',
                memoryLayer: 'L2',
                status: 'activated',
                title: 'Memhub L2 Chronology',
                snippet: '# Memhub L2 Chronology\n\n- Milestone 1: SQLite vector indexing.\n- Milestone 2: Distillation pipeline.\n- Milestone 3: MCP tools.',
                score: 0.9,
                tags: ['l2', `project:${project}`],
                source: 'search',
                retrievalRoutes: ['agent_memory']
              },
              {
                id: 'l3-truth',
                kind: 'profile',
                memoryLayer: 'L3',
                status: 'activated',
                title: 'Memhub L3 Current Truth',
                snippet: '# Memhub L3 Current Truth\n\n- Rule 1: Always resolve project from explicit evidence; never guess.\n- Rule 2: Plan -> user approval -> execute for mutations.\n- Rule 3: EvidenceRef must pass through.',
                score: 0.95,
                tags: ['l3', `project:${project}`, 'current_truth'],
                source: 'search',
                retrievalRoutes: ['agent_memory']
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
  const client = new Client({ name: 'diet-test-client', version: '1.0' });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // Register project and add sample todos
    await runtime.projects.create(runtime.accountId, {
      projectId: 'memhub',
      name: 'Memhub Runtime',
      description: 'Private account/project-scoped long-term memory system with provenance and temporal continuity.'
    });
    await runtime.projects.addTodo(runtime.accountId, 'memhub', 'Verify context diet footprint under 10000 bytes');
    await runtime.projects.addTodo(runtime.accountId, 'memhub', 'Ensure progressive disclosure backward compatibility');

    // -------------------------------------------------------------
    // Test 1: Tool and Parameter Description Limits
    // -------------------------------------------------------------
    console.log('Testing tool descriptions and parameter limits...');
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools;
    assert.equal(tools.length, 11, 'Expected 11 MCP tools');

    let fullToolsText = '';

    for (const tool of tools) {
      const desc = tool.description ?? '';
      fullToolsText += ' ' + desc;
      if (tool.name === 'memmy_context' || tool.name === 'memmy_turn') {
        assert(
          desc.length <= 600,
          `Tool ${tool.name} description exceeded 600 chars: length is ${desc.length}`
        );
      } else {
        assert(
          desc.length <= 350,
          `Tool ${tool.name} description exceeded 350 chars: length is ${desc.length}`
        );
      }

      const properties = tool.inputSchema?.properties ?? {};
      for (const [paramName, prop] of Object.entries(properties)) {
        if (prop.description) {
          assert(
            prop.description.length <= 120,
            `Parameter ${tool.name}.${paramName} description exceeded 120 chars: length is ${prop.description.length}`
          );
        }
      }
    }

    // Verify key governance survives in shortened tool descriptions:
    // 1. plan -> explicit user approval -> execute
    assert(fullToolsText.includes('plan') && (fullToolsText.includes('execute') || fullToolsText.includes('architecture_execute')), 'Governance rule plan -> execute missing');
    assert(fullToolsText.includes('授权') || fullToolsText.includes('批准') || fullToolsText.includes('approval'), 'Governance rule user approval/authorization missing');
    // 2. project/workspace conflict fails closed
    assert(fullToolsText.includes('冲突') || fullToolsText.includes('conflict'), 'Governance rule conflict fails closed missing');
    // 3. never guess project
    assert(fullToolsText.includes('猜测') || fullToolsText.includes('guess'), 'Governance rule never guess project missing');
    // 4. evidenceRef pass-through
    assert(fullToolsText.includes('evidenceRef') || fullToolsText.includes('evidence_ref'), 'Governance rule evidenceRef missing');
    console.log('✓ Tool and parameter description limits pass');

    // -------------------------------------------------------------
    // Test 2: Brief Mode (Default) Response Footprint <= 10,000 Bytes
    // -------------------------------------------------------------
    console.log('Testing memmy_context brief mode footprint and structure...');
    const briefRes = await client.callTool({
      name: 'memmy_context',
      arguments: {
        query: 'architecture contracts and runtime safety constraints',
        project: 'memhub'
      }
    });

    const briefJsonText = briefRes.content[0].text;
    const briefBytes = Buffer.byteLength(briefJsonText, 'utf8');
    console.log(`Brief response size: ${briefBytes} bytes`);

    assert(
      briefBytes <= 10000,
      `Brief response must be <= 10,000 bytes, but got ${briefBytes} bytes`
    );

    const briefData = JSON.parse(briefJsonText);

    // Progressive disclosure omitted in brief
    assert.equal(briefData.progressiveDisclosure, undefined, 'progressiveDisclosure must be omitted in brief mode');

    // turnKnowledgePlan rules omitted in brief
    assert.equal(
      briefData.turnKnowledgePlan?.rules,
      undefined,
      'turnKnowledgePlan.rules must be omitted in brief mode'
    );

    // projectCandidates simplified in brief when resolved
    assert(Array.isArray(briefData.projectCandidates), 'projectCandidates must be an array');
    assert.equal(briefData.projectCandidates.length, 1, 'projectCandidates should contain only the single resolved project');
    const resolvedCandidate = briefData.projectCandidates[0];
    assert.equal(resolvedCandidate.aliases, undefined, 'aliases must be omitted in simplified projectCandidates');
    assert(Array.isArray(resolvedCandidate.relevantTodos), 'relevantTodos should be an array');
    assert(resolvedCandidate.relevantTodos.length <= 5, 'relevantTodos must have <= 5 items');

    // retrievalDiagnostics streamlined in brief
    assert.equal(
      briefData.retrievalDiagnostics?.lanes?.[0]?.queryTerms,
      undefined,
      'retrievalDiagnostics per-lane queryTerms must be omitted in brief mode'
    );
    assert.equal(
      briefData.retrievalDiagnostics?.lanes?.[0]?.weights,
      undefined,
      'retrievalDiagnostics per-lane weights must be omitted in brief mode'
    );
    assert(
      Array.isArray(briefData.retrievalDiagnostics?.queryTerms),
      'retrievalDiagnostics top-level queryTerms must be present'
    );

    // -------------------------------------------------------------
    // Test 3: Extractive Brief Preserves id, evidenceRef, and provenance.brief
    // -------------------------------------------------------------
    console.log('Testing extractive brief preservation of id, evidenceRef, and provenance.brief...');
    const allCapsuleItems = [
      ...(briefData.globalMemory ?? []),
      ...(briefData.projectMemory ?? []),
      ...(briefData.reusableSkills ?? []),
      ...(briefData.projectArchitecture ?? [])
    ];
    assert(allCapsuleItems.length > 0, 'allCapsuleItems must not be empty');

    let foundBriefProvenance = false;
    for (const item of allCapsuleItems) {
      assert(item.id, `Item ${item.id} must have id preserved`);
      if (item.evidenceRef) {
        assert(typeof item.evidenceRef === 'string');
      }
      if (item.provenance?.brief) {
        foundBriefProvenance = true;
        assert(
          item.provenance.brief.originalBytes > 0,
          `Item ${item.id} provenance.brief.originalBytes must be > 0`
        );
        assert(
          item.provenance.brief.method === 'extractive-passages' || item.provenance.brief.method === 'head-tail',
          `Item ${item.id} provenance.brief.method must be extractive-passages or head-tail`
        );
      }
    }
    assert(foundBriefProvenance, 'At least one item should have provenance.brief set in this 4-doc fixture');

    // Also explicitly verify that buildContextCapsule preserves id and evidenceRef on extractive brief
    const longContent = Array.from({ length: 50 }, (_, i) => `## Section ${i + 1}\n\nDetailed specifications and architectural guidance for component section ${i + 1} ensuring proper validation.`).join('\n\n');
    const testCapsule = buildContextCapsule({
      accountId: 'test-acc',
      resolution: { projectId: 'test-proj', source: 'deterministic_binding', recallScope: 'global_and_project', candidates: ['test-proj'], evidence: [] },
      globalMemory: [],
      projectMemory: [{
        id: 'memory-with-evidence',
        content: longContent,
        authority: 'remembered',
        scope: 'project',
        source: 'memmy-memory',
        projectId: 'test-proj',
        evidenceRef: 'l3:memory-with-evidence:revision-42'
      }],
      reusableSkills: [],
      projectArchitecture: [],
      detail: 'brief',
      query: 'section 2 details'
    });
    const boundedItem = testCapsule.projectMemory[0];
    assert.equal(boundedItem.id, 'memory-with-evidence', 'Extractive brief must preserve item.id');
    assert.equal(boundedItem.evidenceRef, 'l3:memory-with-evidence:revision-42', 'Extractive brief must preserve item.evidenceRef');
    assert(boundedItem.provenance?.brief, 'Item must have provenance.brief');

    // Test dedupe in turnKnowledgePlan: capsule items do not repeat passages text
    const capsuleIds = new Set(allCapsuleItems.map(i => i.id));
    const allPlanItems = [
      ...(briefData.turnKnowledgePlan?.required ?? []),
      ...(briefData.turnKnowledgePlan?.supporting ?? [])
    ];
    for (const planItem of allPlanItems) {
      if (capsuleIds.has(planItem.id)) {
        assert.equal(
          planItem.passages,
          undefined,
          `Plan item ${planItem.id} is present in capsule and should not contain passages text`
        );
      }
    }
    console.log('✓ Extractive brief preservation and dedupe pass');

    // -------------------------------------------------------------
    // Test 4: Full Mode Unchanged Semantics
    // -------------------------------------------------------------
    console.log('Testing memmy_context full mode semantics...');
    const fullRes = await client.callTool({
      name: 'memmy_context',
      arguments: {
        query: 'architecture contracts and runtime safety constraints',
        project: 'memhub',
        detail: 'full'
      }
    });

    const fullJsonText = fullRes.content[0].text;
    const fullBytes = Buffer.byteLength(fullJsonText, 'utf8');
    console.log(`Full response size: ${fullBytes} bytes`);

    assert(
      fullBytes > briefBytes,
      `Full response (${fullBytes} B) should be larger than brief response (${briefBytes} B)`
    );

    const fullData = JSON.parse(fullJsonText);

    // progressiveDisclosure present in full
    assert(fullData.progressiveDisclosure, 'progressiveDisclosure must be present in full mode');
    assert(fullData.progressiveDisclosure.discover, 'discover must be present in progressiveDisclosure');
    assert(fullData.progressiveDisclosure.contextualize, 'contextualize must be present in progressiveDisclosure');

    // turnKnowledgePlan.rules present in full
    assert(Array.isArray(fullData.turnKnowledgePlan?.rules), 'turnKnowledgePlan.rules must be present in full mode');
    assert(fullData.turnKnowledgePlan.rules.length > 0, 'turnKnowledgePlan.rules must not be empty');

    // projectCandidates full list in full mode
    assert(Array.isArray(fullData.projectCandidates), 'projectCandidates must be an array in full mode');

    // retrievalDiagnostics full per-lane details in full mode
    assert(
      fullData.retrievalDiagnostics?.lanes?.project?.queryTerms !== undefined,
      'retrievalDiagnostics per-lane queryTerms must be present in full mode'
    );
    console.log('✓ Full mode semantics pass');

    // -------------------------------------------------------------
    // Test 5: memmy_turn Ack Contains None of Submitted Texts
    // -------------------------------------------------------------
    console.log('Testing memmy_turn small ack without text echoes...');
    const userSecret = 'USER_SECRET_QUERY_98765';
    const assistantSecret = 'ASSISTANT_SECRET_ANSWER_43210';
    const reasoningSecret = 'REASONING_SECRET_STEP_13579';
    const toolSecret = 'TOOL_SECRET_CALL_24680';

    const turnRes = await client.callTool({
      name: 'memmy_turn',
      arguments: {
        action: 'open',
        conversation_id: 'conv-diet-1',
        user_text: userSecret,
        assistant_text: assistantSecret,
        reasoning_summary: reasoningSecret,
        tool_summary: toolSecret,
        project: 'memhub'
      }
    });

    const turnJsonText = turnRes.content[0].text;
    assert(!turnJsonText.includes(userSecret), 'memmy_turn ack must not contain user_text');
    assert(!turnJsonText.includes(assistantSecret), 'memmy_turn ack must not contain assistant_text');
    assert(!turnJsonText.includes(reasoningSecret), 'memmy_turn ack must not contain reasoning_summary');
    assert(!turnJsonText.includes(toolSecret), 'memmy_turn ack must not contain tool_summary');

    const turnData = JSON.parse(turnJsonText);
    assert.equal(turnData.ok, true, 'memmy_turn ack ok must be true');
    assert.equal(turnData.action, 'open', 'memmy_turn ack action must be open');
    assert(turnData.event_id, 'memmy_turn ack must contain event_id');
    assert(turnData.status, 'memmy_turn ack must contain status');

    // Test checkpoint ack
    const cpRes = await client.callTool({
      name: 'memmy_turn',
      arguments: {
        action: 'checkpoint',
        event_id: turnData.event_id,
        conversation_id: 'conv-diet-1',
        user_text: userSecret,
        assistant_text: assistantSecret,
        reasoning_summary: reasoningSecret
      }
    });
    const cpJsonText = cpRes.content[0].text;
    assert(!cpJsonText.includes(userSecret), 'checkpoint ack must not contain user_text');
    assert(!cpJsonText.includes(assistantSecret), 'checkpoint ack must not contain assistant_text');
    assert(!cpJsonText.includes(reasoningSecret), 'checkpoint ack must not contain reasoning_summary');
    const cpData = JSON.parse(cpJsonText);
    assert.equal(cpData.ok, true);
    assert.equal(cpData.action, 'checkpoint');

    // Test commit ack
    const commitRes = await client.callTool({
      name: 'memmy_turn',
      arguments: {
        action: 'commit',
        event_id: turnData.event_id,
        conversation_id: 'conv-diet-1',
        user_text: userSecret,
        assistant_text: assistantSecret
      }
    });
    const commitJsonText = commitRes.content[0].text;
    assert(!commitJsonText.includes(userSecret), 'commit ack must not contain user_text');
    assert(!commitJsonText.includes(assistantSecret), 'commit ack must not contain assistant_text');
    const commitData = JSON.parse(commitJsonText);
    assert.equal(commitData.ok, true);
    assert.equal(commitData.action, 'commit');

    // Test resume DOES return content
    const resumeRes = await client.callTool({
      name: 'memmy_turn',
      arguments: {
        action: 'resume',
        conversation_id: 'conv-diet-1'
      }
    });
    const resumeData = JSON.parse(resumeRes.content[0].text);
    assert(Array.isArray(resumeData.turns), 'resume must return turns array');
    assert(resumeData.turns.length > 0, 'resume turns must not be empty');
    console.log('✓ memmy_turn ack privacy and resume pass');

    console.log('\nAll context diet e2e assertions passed successfully!');
  } finally {
    await client.close();
    await server.close();
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

await runContextDietTests();
