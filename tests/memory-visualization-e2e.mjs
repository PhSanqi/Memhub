import assert from "node:assert/strict";
import { buildMemoryVisualization } from "../dist/memory-visualization.js";

const revision1 = "# Alpha timeline\n\n## 2026-10-01：Capture v1 candidate\nBridge capture candidate entered validation.\n\n## 2026-10-01：Dashboard v1 start\nProject status dashboard work started.";
const revision2 = revision1 + "\n\n## 2026-10-02：Capture v2 deployed\nCapture v2 passed local regression and deployed to the candidate runtime.";
const revision3 = revision2 + "\n\n## 2026-10-03：Dashboard v2 pending\nDashboard v2 is waiting for final browser acceptance.";

const result = buildMemoryVisualization({
  projectId: "alpha",
  l2: [{
    id: "timeline-alpha",
    title: "Alpha timeline",
    project_id: "alpha",
    status: "activated",
    body: revision3,
    updatedAt: "2026-10-03T09:00:00.000Z",
    tags: ["project:alpha", "evidence:l1:turn-current"]
  }],
  revisions: [
    {
      ref: "l2:timeline-alpha:revision-1",
      layer: "L2",
      memory_id: "timeline-alpha",
      project_id: "alpha",
      committed_at: "2026-10-01T08:00:00.000Z",
      content: revision1,
      evidence_refs: ["l1:turn-1"]
    },
    {
      ref: "l2:timeline-alpha:revision-2",
      layer: "L2",
      memory_id: "timeline-alpha",
      project_id: "alpha",
      committed_at: "2026-10-02T08:00:00.000Z",
      content: revision2,
      evidence_refs: ["l1:turn-1", "l1:turn-2"]
    },
    {
      ref: "l2:timeline-alpha:revision-3",
      layer: "L2",
      memory_id: "timeline-alpha",
      project_id: "alpha",
      committed_at: "2026-10-03T08:00:00.000Z",
      content: revision3,
      evidence_refs: ["l1:turn-1", "l1:turn-2", "l1:turn-3"]
    }
  ],
  todos: [{
    id: "todo-alpha",
    text: "Finish Project State browser acceptance",
    status: "pending",
    createdAt: "2026-10-03T08:30:00.000Z",
    updatedAt: "2026-10-03T08:30:00.000Z"
  }]
});

assert.equal(result.visualization_contract, "memhub-project-state-ir-v1");
assert.equal(result.source_of_truth, "canonical-l2");
assert.equal(result.revision_source, "exact-l2-revision-ledger");
assert.equal(result.projection_only, true);
assert.equal(result.requires_project, false);
assert.equal(result.project_id, "alpha");

// Cumulative L2 revisions must collapse to four project events rather than
// duplicating the repeated events from every historical revision.
assert.equal(result.state.events.length, 4);
assert.equal(result.stats.events, 4);
assert.equal(result.stats.l2_revisions, 3);
assert.equal(result.drilldown.revisions.length, 3);
assert.equal(result.drilldown.todos.length, 1);
assert.equal(result.stats.pending_todos, 1);

const captureEvents = result.state.events.filter((event) => /Capture/.test(event.title));
const dashboardEvents = result.state.events.filter((event) => /Dashboard/.test(event.title));
assert.equal(captureEvents.length, 2);
assert.equal(dashboardEvents.length, 2);
assert.equal(new Set(captureEvents.map((event) => event.workstream_id)).size, 1);
assert.equal(new Set(dashboardEvents.map((event) => event.workstream_id)).size, 1);
assert.notEqual(captureEvents[0].workstream_id, dashboardEvents[0].workstream_id);
assert.ok(result.state.workstreams.length >= 2);
assert.ok(result.state.workstreams.some((stream) => /Capture/i.test(stream.label)));
assert.ok(result.state.workstreams.some((stream) => /Dashboard/i.test(stream.label)));

assert.ok(result.state.events.some((event) => event.version === "v1"));
assert.ok(result.state.events.some((event) => event.version === "v2"));
assert.equal(result.stats.versions, 2);
assert.equal(result.state.events.filter((event) => event.current_head).length, 1);
assert.match(result.state.events.find((event) => event.current_head)?.title ?? "", /Dashboard v2 pending/);
assert.equal(result.state.current_head_event_id, result.state.events.find((event) => event.current_head)?.id);
assert.equal(result.state.latest_l2_revision_at, "2026-10-03T09:00:00.000Z");

const current = result.state.events.find((event) => event.current_head);
assert.equal(current.revision_count, 1);
assert.equal(current.latest_revision_ref, "l2:timeline-alpha:revision-3");
assert.ok(result.drilldown.revisions.find((revision) => revision.ref === current.latest_revision_ref)?.evidence_refs.includes("l1:turn-3"));
assert.equal(result.drilldown.revisions.at(-1).current, true);

// Archify is a disposable projection of the same L2 state, not another memory graph.
assert.equal(result.archify.role, "optional_export_and_design_reference");
assert.equal(result.archify.exportable, true);
assert.deepEqual(result.archify.compatible_diagram_types, ["lifecycle"]);
assert.equal(result.archify.lifecycle_ir.schema_version, 2);
assert.equal(result.archify.lifecycle_ir.diagram_type, "lifecycle");
assert.equal(result.archify.lifecycle_ir.meta.output, "memhub-project-state-alpha.html");
assert.ok(result.archify.lifecycle_ir.lanes.length <= 4);
assert.ok(result.archify.lifecycle_ir.states.length <= result.state.events.length);
assert.deepEqual(result.archify.lifecycle_ir.states.map((state) => state.col), result.archify.lifecycle_ir.states.map((_, index) => index));
assert.ok(result.archify.lifecycle_ir.states.every((state) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(state.id)));
assert.ok(result.archify.lifecycle_ir.lanes.every((lane) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(lane.id)));
assert.equal(result.archify.lifecycle_ir.transitions.length, result.archify.lifecycle_ir.states.length - 1);
assert.match(result.archify.lifecycle_ir.meta.subtitle, /L2 progress flow/);
assert.match(result.archify.invariant, /transition lines encode chronology/i);
assert.equal(result.archify.lifecycle_ir.cards.length, 0);
assert.ok(result.state.events.every((event) => !Object.hasOwn(event, "evidence_refs")));
assert.ok(result.archify.lifecycle_ir.states.every((state) => !Object.hasOwn(state, "evidence_refs")));

// No project selection intentionally produces no account-wide graph.
const noProject = buildMemoryVisualization({ l2: [] });
assert.equal(noProject.requires_project, true);
assert.equal(noProject.project_id, null);
assert.equal(noProject.state.events.length, 0);
assert.equal(noProject.state.workstreams.length, 0);
assert.equal(noProject.archify.exportable, false);
assert.equal(noProject.archify.lifecycle_ir.states.length, 0);

const singleEvent = buildMemoryVisualization({
  projectId: "single",
  l2: [{ id: "timeline-single", body: "# Timeline\n\n## 2026-10-01：Only event\nOne durable state.", updatedAt: "2026-10-01T10:00:00.000Z" }]
});
assert.equal(singleEvent.state.events.length, 1);
assert.equal(singleEvent.archify.exportable, false);

// A superseded/archived L2 revision remains exact drill-down provenance, but
// historical-only states must never leak into the canonical L2 main graph.
const staleLedgerEvent = buildMemoryVisualization({
  projectId: "alpha",
  l2: [{
    id: "timeline-current",
    body: "# Timeline\n\n## 2026-10-10：Current head\nCurrent canonical state.",
    updatedAt: "2026-10-10T10:05:16.750Z"
  }],
  revisions: [{
    ref: "l2:timeline-stale:revision-1",
    layer: "L2",
    memory_id: "timeline-stale",
    project_id: "alpha",
    committed_at: "2026-10-07T07:25:29.733Z",
    content: "# Timeline\n\n## 2026-09-26：Historical unique event\nPreserved only by the exact revision ledger.",
    evidence_refs: ["l1:historical-evidence"]
  }]
});
assert.equal(staleLedgerEvent.state.events.some((event) => event.memory_id === "timeline-stale" || /Historical unique event/.test(event.title)), false);
assert.equal(staleLedgerEvent.state.events.length, 1);
assert.equal(staleLedgerEvent.drilldown.revisions.length, 1);
assert.equal(staleLedgerEvent.drilldown.revisions[0].ref, "l2:timeline-stale:revision-1");
assert.deepEqual(staleLedgerEvent.drilldown.revisions[0].event_ids, []);
assert.deepEqual(staleLedgerEvent.drilldown.revisions[0].evidence_refs, ["l1:historical-evidence"]);
assert.equal(staleLedgerEvent.state.latest_l2_revision_at, "2026-10-10T10:05:16.750Z");

console.log("memory-visualization-e2e: ok");
