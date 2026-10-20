#!/usr/bin/env node
import { readLocalBuildIdentity, waitForService } from "../dist/service-readiness.js";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const url = arg("--url");
const kind = arg("--kind");
const timeout = Number(arg("--timeout-ms", "20000"));
if (!url || !["core", "gateway"].includes(kind)) {
  throw new Error("usage: wait-for-service.mjs --url http://127.0.0.1:PORT/health --kind core|gateway [--timeout-ms 20000]");
}
try {
  // The gateway and its embedded Core share one installation. A Core still
  // running an older vendor hash or package version is a stale upgrade.
  const expectedBuild = kind === "core" ? readLocalBuildIdentity() : undefined;
  const probe = await waitForService({
    url,
    kind,
    timeoutMs: timeout,
    ...(expectedBuild ? { expectedBuild } : {})
  });
  console.log(JSON.stringify({
    ok: true,
    kind,
    ready: true,
    ...(probe.degraded.length ? { degraded: probe.degraded } : {})
  }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, kind, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
