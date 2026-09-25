import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "vendor", "manifest.json"), "utf8"));
assert.equal(manifest.format, "memhub-vendor-manifest-v1");
async function walk(dir) {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
for (const [label, component] of Object.entries(manifest.components)) {
  const source = join(root, "vendor", component.path);
  const files = await walk(source);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(source, file).replaceAll("\\", "/"), "utf8");
    hash.update("\u0000");
    hash.update(createHash("sha256").update(await readFile(file)).digest("hex"), "utf8");
    hash.update("\u0001");
  }
  assert.equal(files.length, component.files, `${label}: file count drift`);
  assert.equal(hash.digest("hex"), component.sha256, `${label}: vendor tree drift`);
}
console.log("vendor-manifest-e2e: ok");
