import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(fileURLToPath(new URL("../scripts/cloudflare-health.mjs", import.meta.url)));
const server = createServer((request, response) => {
  response.setHeader("content-type", request.url === "/metrics" ? "text/plain" : "application/json");
  if (request.url === "/health") return response.end('{"ok":true}');
  if (request.url === "/metrics") return response.end([
    "cloudflared_tunnel_ha_connections 4",
    "quic_client_closed_connections 40",
    `process_start_time_seconds ${Date.now() / 1000 - 3600}`
  ].join("\n") + "\n");
  if (request.url === "/config") return response.end(JSON.stringify({ config: { ingress: [{
    hostname: "memhub.example.test", service: "http://127.0.0.1:3001",
    originRequest: { connectTimeout: 30, tcpKeepAlive: 30, keepAliveTimeout: 90, keepAliveConnections: 100 }
  }] } }));
  response.writeHead(404).end('{}');
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
try {
  const port = server.address().port;
  const child = spawn(process.execPath, [script,
    "--origin", `http://127.0.0.1:${port}/health`, "--metrics", `http://127.0.0.1:${port}`,
    "--attempts", "1", "--http2-ab-result", "failed"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const code = await new Promise((done) => child.once("exit", done));
  assert.equal(code, 0, err);
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.http2_ab_result, "failed");
  assert.equal(result.metrics.ha_connections, 4);
  assert.ok(result.metrics.quic_closed_connections_per_hour >= 39);
  assert.ok(result.warnings.some((line) => line.includes("forced HTTP/2 already failed")));
  assert.ok(result.warnings.some((line) => line.includes("separate controlled trial of 5s")));
  assert.ok(result.warnings.every((line) => !line.includes("consider an A/B test with cloudflared --protocol http2")));
  console.log("memhub-network-report-e2e: ok");
} finally {
  await new Promise((closed) => server.close(closed));
}
