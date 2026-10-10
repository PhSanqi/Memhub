import assert from "node:assert/strict";
import { renderConsole } from "../dist/web-ui.js";

const html = renderConsole({
  account: { account_id: "acct-test", username: "tester", role: "user" },
  accounts: [{ account_id: "acct-test", username: "tester", role: "user" }],
  projects: [{
    accountId: "acct-test",
    projectId: "alpha",
    name: "Alpha",
    description: "Alpha project",
    aliases: [],
    state: "active",
    updatedAt: "2026-10-10T10:00:00.000Z",
    todos: []
  }],
  adminView: false,
  localControl: true,
  selectedAccountId: "acct-test"
});

// Project overview is deliberately vertical: Current Truth first, then the
// full-width Next Work section, avoiding a tall narrow right-hand column.
assert.match(html, /\.project-overview-detail\{display:flex;flex-direction:column;gap:14px\}/);
assert.match(html, /class=\\?"project-truth/);
assert.match(html, /class=\\?"project-next/);

// Historical migration failures must never be presented as a current project
// failure. Current processing state is separate from provenance/content badges.
assert.match(html, /actionableFailed=jobs\.filter\(isActionableFailedJob\)\.length/);
assert.doesNotMatch(html, /failed=jobs\.filter\(x=>statusOf\(x\)===['"]failed['"]\)\.length/);
assert.match(html, /project-processing-state/);
assert.match(html, /处理状态/);

// L2 is read top-to-bottom from newest event date to oldest; undated events
// fall to the bottom instead of appearing as the newest item.
assert.match(html, /ad=a\.date\|\|['"]0000-00-00['"],bd=b\.date\|\|['"]0000-00-00['"]/);
assert.match(html, /bd\.localeCompare\(ad\)/);
assert.match(html, /按事件日期从新到旧/);

// Long Next Work lists stay bounded in overview and expose the full project
// todo view instead of turning the overview into an unbounded page.
assert.match(html, /todos\.slice\(0,5\)/);
assert.match(html, /查看全部 ['"]?\+todos\.length/);

console.log("web-ui-overview-e2e: ok");
