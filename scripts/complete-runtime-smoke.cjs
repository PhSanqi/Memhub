#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 20) throw new Error(`Node.js 20+ required, found ${process.version}`);

for (const relative of [
  "dist/mcp.js",
  "dist/bridge.js",
  "vendor/memory-core/src/server/index.js",
  "web-assets/logo-mark.png",
  "web-assets/logo-lockup.png"
]) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Complete runtime missing ${relative}`);
}

const Database = require("better-sqlite3");
const db = new Database(":memory:");
const value = db.prepare("select 42 as value").get().value;
db.close();
if (value !== 42) throw new Error("better-sqlite3 smoke failed");

require.resolve("sqlite-vec");
const ort = require("onnxruntime-node");
if (typeof ort.InferenceSession !== "function") throw new Error("onnxruntime-node smoke failed");

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  betterSqlite3: true,
  sqliteVec: true,
  onnxruntime: true
}));
