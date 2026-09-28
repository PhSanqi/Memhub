#!/usr/bin/env node

// A deliberately static GitHub Pages mirror. Do not export authenticated
// /user, /admin, API routes, project fixtures, or any production state.
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocs, renderLanding } from "../dist/web-ui.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] || join(repo, ".review-runtime/public-site"));
const pages = [
  ["", renderLanding()],
  ["docs", renderDocs("/memhub/docs")],
  ...["install", "workflows", "privacy", "troubleshooting"].map((slug) =>
    [`docs/${slug}`, renderDocs(`/memhub/docs/${slug}`)]
  )
];

for (const [route, source] of pages) {
  // The self-hosted Landing has one desktop-only entry to that instance's
  // authenticated console. GitHub Pages is documentation-only, so remove it
  // instead of publishing a dead/private workspace link.
  const publicSource = source.replace(/<a class="console-entry"[^>]*>.*?<\/a>/g, "");
  // Rewrite only *navigation/asset attributes*, never code examples such as
  // http://127.0.0.1:3001/memhub/mcp inside the documentation.
  const html = publicSource.replace(/((?:href|src)=["'])\/memhub(?=\/|["'])/g, "$1/Memhub");
  const privateLink = /(?:href|src)=["'][^"']*\/(?:user|admin)(?:\/|["'?#])/i;
  if (privateLink.test(html) || /(?:href|src)=["']\/Memhub\/(?:user|admin)/i.test(html)) {
    throw new Error(`Private workspace link found in public route: ${route || "/"}`);
  }
  if (/打开我的记忆|Open my memory|EXAMPLE PROJECT<\/span><b>Memhub<\/b>/.test(html)) {
    throw new Error(`Personalized landing content found in public route: ${route || "/"}`);
  }
  if (/class="console-entry"|>进入管理台<|>Open console</.test(html)) {
    throw new Error(`Self-hosted console entry leaked into static public route: ${route || "/"}`);
  }
  const file = join(output, route, "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}

const assets = join(output, "assets");
await mkdir(assets, { recursive: true });
for (const filename of ["logo-mark.png", "logo-lockup.png"]) {
  await copyFile(join(repo, "web-assets", filename), join(assets, filename));
}
await writeFile(join(output, ".nojekyll"), "");
console.log(`Public-only static site: ${output} (6 HTML pages, 2 logo assets)`);
