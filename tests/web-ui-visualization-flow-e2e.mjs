import assert from "node:assert/strict";
import { renderConsole } from "../dist/web-ui.js";

const account = { account_id: "acct-test", username: "tester", role: "user" };
const html = renderConsole({
  account,
  accounts: [account],
  projects: [{ projectId: "alpha", name: "Alpha", aliases: [], todos: [], state: "active" }],
  adminView: false,
  localControl: true,
  selectedAccountId: account.account_id
});

// Project State is a line/progress-flow projection of L2 rather than the old
// Gantt-like date grid. Evidence/revisions stay behind node drill-down.
assert.match(html, /project-flow-canvas/);
assert.match(html, /project-flow-edge/);
assert.match(html, /L2 进度流/);
assert.match(html, /线只表达 L2 事件顺序，不表达 evidence 依赖关系/);
assert.match(html, /来源追溯 · L2 revision \/ evidence/);
assert.match(html, /完整 L2 时间线/);
assert.doesNotMatch(html, /project-state-time-track/);
assert.doesNotMatch(html, /project-state-lane-row/);
assert.doesNotMatch(html, /证据关系[^<]*<\/span>/);

console.log("web-ui-visualization-flow-e2e: ok");
