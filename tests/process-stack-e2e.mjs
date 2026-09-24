import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedProcessStack } from "../dist/process-stack.js";
import { loopbackPortOccupied, probeService, waitForService } from "../dist/service-readiness.js";

const root = await mkdtemp(join(tmpdir(), "memhub-managed-stack-"));
const fixture = join(root, "fixture.cjs");
await writeFile(fixture, `
const fs=require('node:fs');
const http=require('node:http');
const [kind,port,pidFile,delay='0',firstOnlyMarker]=process.argv.slice(2);
fs.writeFileSync(pidFile,String(process.pid));
const started=Date.now();
const readinessDelay=firstOnlyMarker && !fs.existsSync(firstOnlyMarker)
  ? (fs.writeFileSync(firstOnlyMarker,String(process.pid)),Number(delay))
  : firstOnlyMarker ? 0 : Number(delay);
const server=http.createServer((req,res)=>{
  if(req.url!=='/health'){res.writeHead(404).end();return}
  if(Date.now()-started<readinessDelay){res.writeHead(503).end();return}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(kind==='core'
    ? {ok:true,serviceVersion:'test',protocolVersion:1,storage:{ready:true}}
    : {ok:true,service:kind==='gateway'?'memhub':'memhub-bridge'}));
});
server.listen(Number(port),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`, "utf8");

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}
async function until(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("timed out waiting for process-stack condition");
}
const events = [];
let stack;
try {
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const specs = ["core", "gateway", "bridge"].map((kind, i) => ({
    name: kind,
    kind,
    entrypoint: fixture,
    args: [kind, String(ports[i]), join(root, `${kind}.pid`)],
    healthUrl: `http://127.0.0.1:${ports[i]}/health`,
    cwd: root
  }));
  assert.equal((await probeService(specs[0].healthUrl, "core")).ok, false);
  await assert.rejects(() => waitForService({ url: "https://example.com/health", kind: "core" }), /loopback/);
  stack = new ManagedProcessStack({
    services: specs,
    readinessTimeoutMs: 4_000,
    healthIntervalMs: 100,
    failureThreshold: 2,
    restartWindowMs: 10_000,
    maxRestarts: 3,
    onEvent: (event) => events.push(event)
  });
  await Promise.all([stack.start(), stack.start()]);
  assert.equal(stack.status.ready, true);
  const firstPids = stack.status.pids;
  assert.equal(Object.keys(firstPids).length, 3);
  assert.deepEqual(events.filter((event) => event.type === "started").map((event) => event.service), ["core", "gateway", "bridge"]);
  for (const spec of specs) assert.equal((await probeService(spec.healthUrl, spec.kind)).ok, true);

  // A child crash restarts only the owned group, in dependency order.
  process.kill(firstPids.core, "SIGTERM");
  await until(() => stack.status.ready && stack.status.pids.core !== firstPids.core);
  const secondPids = stack.status.pids;
  for (const kind of ["core", "gateway", "bridge"]) assert.notEqual(firstPids[kind], secondPids[kind]);
  assert.ok(events.some((event) => event.type === "restart_scheduled"));
  assert.equal(stack.status.fatalReason, undefined);
  // Repeated crashes must eventually stop rather than create an endless
  // restart loop. No previously owned children may survive the fatal state.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = stack.status.pids.core;
    if (!current || !stack.status.desired) break;
    process.kill(current, "SIGTERM");
    if (attempt < 2) await until(() => stack.status.ready && stack.status.pids.core !== current);
  }
  await until(() => Boolean(stack.status.fatalReason));
  assert.match(stack.status.fatalReason, /restart budget exhausted/);
  assert.equal(stack.status.desired, false);
  await until(() => Object.keys(stack.status.pids).length === 0);
  await stack.stop();
  assert.equal(stack.status.desired, false);
  assert.deepEqual(stack.status.pids, {});
  for (const spec of specs) assert.equal(await loopbackPortOccupied(spec.healthUrl), false);

  // A port owned by a different process is never adopted or killed.
  const occupied = await freePort();
  const external = createServer((_, response) => response.writeHead(200).end("external"));
  await new Promise((resolveReady) => external.listen(occupied, "127.0.0.1", resolveReady));
  const conflict = new ManagedProcessStack({ services: [{
    name: "core", kind: "core", entrypoint: fixture,
    args: ["core", String(occupied), join(root, "conflict.pid")],
    healthUrl: `http://127.0.0.1:${occupied}/health`, cwd: root
  }] });
  await assert.rejects(conflict.start(), /port already in use/);
  await conflict.stop();
  assert.equal(external.listening, true);
  await new Promise((resolveClosed) => external.close(resolveClosed));

  // Startup cancellation tears down its own in-flight child.
  const slowPort = await freePort();
  const slow = new ManagedProcessStack({ services: [{
    name: "core", kind: "core", entrypoint: fixture,
    args: ["core", String(slowPort), join(root, "slow.pid"), "2000"],
    healthUrl: `http://127.0.0.1:${slowPort}/health`, cwd: root
  }], readinessTimeoutMs: 3_000 });
  const starting = slow.start();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  await slow.stop();
  await assert.rejects(starting, /cancelled|exited/);
  assert.equal(await loopbackPortOccupied(`http://127.0.0.1:${slowPort}/health`), false);

  // Transient initial readiness failure is retried by the same supervisor.
  const retryPort = await freePort();
  const retryMarker = join(root, "retry-first-only.marker");
  const retryEvents = [];
  const retry = new ManagedProcessStack({ services: [{
    name: "core", kind: "core", entrypoint: fixture,
    args: ["core", String(retryPort), join(root, "retry.pid"), "2000", retryMarker],
    healthUrl: `http://127.0.0.1:${retryPort}/health`, cwd: root
  }], readinessTimeoutMs: 350, onEvent: (event) => retryEvents.push(event) });
  try {
    await retry.startWithRetry({ attempts: 3, delayMs: 30 });
    assert.equal(retry.status.ready, true);
    assert.equal(retryEvents.filter((event) => event.type === "started").length, 2);
    assert.ok(retryEvents.some((event) => event.type === "restart_scheduled" && /startup failed/.test(event.reason)));
  } finally { await retry.stop(); }
  assert.equal(await loopbackPortOccupied(`http://127.0.0.1:${retryPort}/health`), false);

  // The CLI readiness probe rejects a wrong service, including a healthy HTTP 200.
  const wrongPort = await freePort();
  const wrong = createServer((_, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"service":"other"}'));
  await new Promise((resolveReady) => wrong.listen(wrongPort, "127.0.0.1", resolveReady));
  assert.deepEqual(await probeService(`http://127.0.0.1:${wrongPort}/health`, "gateway"), {
    ok: false, status: 200, reason: "unexpected_service"
  });
  assert.deepEqual(await probeService(`http://127.0.0.1:${wrongPort}/health`, "core"), {
    ok: false, status: 200, reason: "core_not_ready"
  });
  await assert.rejects(waitForService({ url: `http://127.0.0.1:${wrongPort}/health`, kind: "gateway", timeoutMs: 200, intervalMs: 30 }), /timeout/);
  await new Promise((resolveClosed) => wrong.close(resolveClosed));
  console.log("memhub-process-stack-e2e: ok");
} finally {
  await stack?.stop();
  await rm(root, { recursive: true, force: true });
}
