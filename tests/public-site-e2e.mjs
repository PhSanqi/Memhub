import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "memhub-public-site-"));
try {
  const exportResult = spawnSync(process.execPath, ["scripts/export-public-site.mjs", root], {
    cwd: resolve("."), encoding: "utf8"
  });
  assert.equal(exportResult.status, 0, exportResult.stderr || exportResult.stdout);

  for (const page of ["", "docs", "docs/install", "docs/workflows", "docs/privacy", "docs/troubleshooting"]) {
    const html = await readFile(join(root, page, "index.html"), "utf8");
    assert.match(html, /<html\b/);
    assert.doesNotMatch(html, /(?:href|src)="[^"]*\/(?:user|admin)(?:\/|["?#])/i,
      `public page ${page} links to a private workspace`);
    assert.doesNotMatch(html, /打开我的记忆|Open my memory|updated 2m ago/,
      `public page ${page} contains personal/demo-ambiguous copy`);
    assert.doesNotMatch(html, /class="console-entry"|>进入管理台<|>Open console</,
      `public page ${page} must not expose a self-hosted console entry`);
    assert.doesNotMatch(
      html,
      /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\/home\/(?!USER\/)[A-Za-z0-9._-]+\/|C:\\Users\\(?!USER\\)[^\\]+\\/i,
      `public page ${page} contains an email or operator home path`);
    for (const match of html.matchAll(/(?:href|src)="(\/Memhub(?:\/[^"#?]*)?)/g)) {
      const route = match[1].replace(/^\/Memhub\/?/, "");
      const file = /\.(?:png|svg|jpg|webp)$/i.test(route)
        ? join(root, route)
        : join(root, route, "index.html");
      assert.ok((await stat(file)).isFile(), `broken public link: ${match[1]} from ${page || "/"}`);
    }
    if (!page) {
      assert.match(html, /href="\/Memhub\/docs\/install" data-zh="安装 Memhub"/);
      assert.match(html, /EXAMPLE PROJECT/);
      assert.match(html, /Atlas Demo/);
    }
  }
  for (const image of ["logo-mark.png", "logo-lockup.png"]) {
    const data = await readFile(join(root, "assets", image));
    assert.equal(data.toString("ascii", 1, 4), "PNG");
  }
  console.log("memhub-public-site-e2e: ok (six public routes, links, synthetic preview, privacy gate)");
} finally {
  await rm(root, { recursive: true, force: true });
}
