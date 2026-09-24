import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/check-memhub-tunnel', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'memhub-tunnel-watchdog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
url=""; output=""
while (( $# )); do
  case "$1" in
    -o) output="$2"; shift 2;;
    *) url="$1"; shift;;
  esac
done
if [[ "$url" == */metrics ]]; then
  if [[ "$MOCK_HA" == missing ]]; then exit 7; fi
  if [[ "$MOCK_HA" == invalid ]]; then printf 'some_other_metric 4\\n'; exit 0; fi
  if [[ -f "$MOCK_RESTART_LOG" && "$MOCK_STILL_BAD" != 1 ]]; then printf 'cloudflared_tunnel_ha_connections 4\\n';
  else printf 'cloudflared_tunnel_ha_connections %s\\n' "$MOCK_HA"; fi
elif [[ "$url" == *127.0.0.1:3001* ]]; then
  printf '%s' "$MOCK_LOCAL_HTTP"
else
  if [[ "$MOCK_PUBLIC_MODE" == partial && ! -f "$MOCK_RESTART_LOG" ]]; then
    [[ -z "$output" ]] || head -c 1000 /dev/zero > "$output"
  elif [[ "$MOCK_PUBLIC_MODE" == timedout && ! -f "$MOCK_RESTART_LOG" ]]; then
    [[ -z "$output" ]] || head -c 65000 /dev/zero > "$output"
    printf '200'; exit 28
  else
    [[ -z "$output" ]] || head -c 65000 /dev/zero > "$output"
  fi
  printf '200'
fi
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_RESTART_LOG"
`, { mode: 0o755 });
  const restartLog = path.join(dir, 'restarts');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    MEMHUB_TUNNEL_WATCHDOG_STATE_DIR: dir,
    MEMHUB_TUNNEL_WATCHDOG_PUBLIC_URL: 'https://memhub.example.test/',
    MEMHUB_TUNNEL_WATCHDOG_SERVICE: 'sanqi-plugin-cloudflared.service',
    MEMHUB_TUNNEL_WATCHDOG_RECOVERY_ATTEMPTS: '1',
    MEMHUB_TUNNEL_WATCHDOG_RECOVERY_DELAY: '0',
    MOCK_RESTART_LOG: restartLog,
    MOCK_HA: '4',
    MOCK_LOCAL_HTTP: '200',
    MOCK_PUBLIC_MODE: 'good',
    MOCK_STILL_BAD: '0',
  };
  return {
    run(overrides={}) {
      const result = spawnSync('bash', [script], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 });
      return { status: result.status, output: result.stdout + result.stderr };
    },
    restarts() { return existsSync(restartLog) ? readFileSync(restartLog, 'utf8').trim().split('\n') : []; },
  };
}

test('healthy connector and complete public Landing cause no restart', t => {
  const f=fixture(t);
  assert.equal(f.run().status,0);
  assert.deepEqual(f.restarts(),[]);
});

test('three partial HA observations restart only dedicated Memhub connector', t => {
  const f=fixture(t);
  for(let i=0;i<2;i++) { assert.equal(f.run({MOCK_HA:'2'}).status,0); assert.deepEqual(f.restarts(),[]); }
  const result=f.run({MOCK_HA:'2'});
  assert.equal(result.status,0,result.output);
  assert.match(result.output,/recovered; dedicated HA=4\/4/);
  assert.deepEqual(f.restarts(),['--user restart sanqi-plugin-cloudflared.service']);
});

test('200 with truncated Landing body triggers recovery only after three observations', t => {
  const f=fixture(t);
  for(let i=0;i<2;i++) { assert.equal(f.run({MOCK_PUBLIC_MODE:'partial'}).status,0); assert.deepEqual(f.restarts(),[]); }
  const result=f.run({MOCK_PUBLIC_MODE:'partial'});
  assert.equal(result.status,0,result.output);
  assert.match(result.output,/public-body-incomplete/);
  assert.deepEqual(f.restarts(),['--user restart sanqi-plugin-cloudflared.service']);
});

test('200 partial body with failed curl exit is not treated as complete', t => {
  const f=fixture(t);
  for(let i=0;i<2;i++) { assert.equal(f.run({MOCK_PUBLIC_MODE:'timedout'}).status,0); assert.deepEqual(f.restarts(),[]); }
  const result=f.run({MOCK_PUBLIC_MODE:'timedout'});
  assert.equal(result.status,0,result.output);
  assert.match(result.output,/public-body-incomplete/);
  assert.deepEqual(f.restarts(),['--user restart sanqi-plugin-cloudflared.service']);
});

test('missing or malformed HA metrics never restart the connector', t => {
  const f=fixture(t);
  for(let i=0;i<4;i++) assert.match(f.run({MOCK_HA:i%2?'invalid':'missing',MOCK_PUBLIC_MODE:'partial'}).output,/metrics unavailable or invalid/);
  assert.deepEqual(f.restarts(),[]);
});

test('unhealthy local Memhub suppresses connector restart', t => {
  const f=fixture(t);
  for(let i=0;i<4;i++) assert.match(f.run({MOCK_LOCAL_HTTP:'503',MOCK_HA:'0',MOCK_PUBLIC_MODE:'partial'}).output,/restart suppressed/);
  assert.deepEqual(f.restarts(),[]);
});

test('failed recovery respects cooldown and does not restart again', t => {
  const f=fixture(t);
  for(let i=0;i<3;i++) f.run({MOCK_HA:'0',MOCK_STILL_BAD:'1'});
  assert.deepEqual(f.restarts(),['--user restart sanqi-plugin-cloudflared.service']);
  for(let i=0;i<3;i++) assert.equal(f.run({MOCK_HA:'0',MOCK_STILL_BAD:'1'}).status,0);
  assert.deepEqual(f.restarts(),['--user restart sanqi-plugin-cloudflared.service']);
});
