#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STATE_ROOT="${MEMHUB_HOME:-$HOME/.memhub}"
SERVER_STATE="$STATE_ROOT/server"
MEMORY_DIR="$STATE_ROOT/memory"
CONFIG_PATH="$STATE_ROOT/memory-config.yaml"
ENV_PATH="$STATE_ROOT/local.env"
BUNDLED_NODE="$REPO_ROOT/runtime/node/bin/node"
BUNDLED_NPM_CLI="$REPO_ROOT/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
if [[ -z "${NODE:-}" ]]; then
  if [[ -x "$BUNDLED_NODE" ]]; then NODE="$BUNDLED_NODE"; else NODE="$(command -v node || true)"; fi
fi
NPM="${NPM:-$(command -v npm || true)}"

[[ -n "$NODE" ]] || { echo "Node.js 20+ is required" >&2; exit 2; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 20 )) || { echo "Node.js 20+ is required" >&2; exit 2; }

run_npm() {
  if [[ "$NODE" == "$BUNDLED_NODE" && -f "$BUNDLED_NPM_CLI" ]]; then
    "$NODE" "$BUNDLED_NPM_CLI" "$@"
  elif [[ -n "$NPM" ]]; then
    "$NPM" "$@"
  else
    echo "npm is required when dependencies or build output are missing" >&2
    return 2
  fi
}

ensure_build() {
  if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
    echo "[memhub] dependencies missing; installing from lockfile"
    (cd "$REPO_ROOT" && ONNXRUNTIME_NODE_INSTALL_CUDA=skip run_npm ci --workspaces=false)
  fi
  if [[ ! -f "$REPO_ROOT/vendor/memory-core/src/server/index.js" || ! -f "$REPO_ROOT/dist/mcp.js" || ! -f "$REPO_ROOT/dist/bridge.js" ]]; then
    echo "[memhub] build output missing; building Memhub"
    (cd "$REPO_ROOT" && run_npm run build)
  fi
}

ensure_build
mkdir -p "$STATE_ROOT" "$SERVER_STATE" "$MEMORY_DIR" "$HOME/.config/systemd/user"
chmod 700 "$STATE_ROOT" "$SERVER_STATE" "$MEMORY_DIR"

MEMORY_TOKEN="$("$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
"$NODE" - "$CONFIG_PATH" "$MEMORY_DIR/memory.sqlite" "$MEMORY_TOKEN" <<'NODE'
const fs = require('node:fs');
const [path, db, token] = process.argv.slice(2);
const config = {
  memmyMemory: {
    version: 1,
    userId: 'local-user',
    roleRouting: { summary: 'follow', evolution: 'follow' },
    storage: {
      mode: 'local', backend: 'sqlite', sqlitePath: db,
      endpoint: 'http://127.0.0.1:18960', token
    },
    algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
    agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
  },
  providers: {},
  modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
  modelPresets: {},
  app: {}
};
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
NODE
chmod 600 "$CONFIG_PATH"

ACCOUNTS_JSON="$STATE_ROOT/accounts.json.tmp"
"$NODE" "$REPO_ROOT/dist/mcp.js" account list --state-root "$SERVER_STATE" > "$ACCOUNTS_JSON"
ACCOUNT_ID="$("$NODE" - "$ACCOUNTS_JSON" <<'NODE'
const fs=require('node:fs'); const a=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const found=a.find(x=>x.username==='local'); if(found) process.stdout.write(found.account_id);
NODE
)"
if [[ -z "$ACCOUNT_ID" ]]; then
  "$NODE" "$REPO_ROOT/dist/mcp.js" account add local --state-root "$SERVER_STATE" > "$ACCOUNTS_JSON"
  ACCOUNT_ID="$("$NODE" - "$ACCOUNTS_JSON" <<'NODE'
const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); process.stdout.write(x.account_id);
NODE
)"
fi
rm -f "$ACCOUNTS_JSON"

cat > "$ENV_PATH" <<EOF_ENV
MEMHUB_ACCOUNT_ID=$ACCOUNT_ID
MEMHUB_OWNER_ACCOUNT_ID=$ACCOUNT_ID
MEMHUB_OWNER_USER_ID=local-user
MEMHUB_MEMORY_TOKEN=$MEMORY_TOKEN
MEMHUB_MEMORY_URL=http://127.0.0.1:18960
MEMHUB_STATE_ROOT=$SERVER_STATE
MEMHUB_BINDINGS=$STATE_ROOT/conversation-project-bindings.json
EOF_ENV
chmod 600 "$ENV_PATH"

BRIDGE_JSON="$STATE_ROOT/bridge.json"
if [[ ! -f "$BRIDGE_JSON" ]] || ! "$NODE" -e 'const fs=require("node:fs");const p=process.argv[1];try{const x=JSON.parse(fs.readFileSync(p,"utf8"));process.exit(x.device_token?0:1)}catch{process.exit(1)}' "$BRIDGE_JSON"; then
  DEVICE_TMP="$STATE_ROOT/device.tmp.json"
  "$NODE" "$REPO_ROOT/dist/mcp.js" device add "$ACCOUNT_ID" "local-$(hostname)" --state-root "$SERVER_STATE" > "$DEVICE_TMP"
  DEVICE_TOKEN="$("$NODE" - "$DEVICE_TMP" <<'NODE'
const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); process.stdout.write(x.token);
NODE
)"
  MEMHUB_BRIDGE_HOME="$STATE_ROOT" MEMHUB_DEVICE_TOKEN="$DEVICE_TOKEN" \
    "$NODE" "$REPO_ROOT/dist/bridge.js" configure \
      --mcp-endpoint http://127.0.0.1:3001/memhub/mcp \
      --endpoint http://127.0.0.1:3001/memhub/capture >/dev/null
  rm -f "$DEVICE_TMP"
fi
chmod 600 "$BRIDGE_JSON"

cat > "$HOME/.config/systemd/user/memhub-core.service" <<EOF_UNIT
[Unit]
Description=Memhub Local Memory Core
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=$NODE $REPO_ROOT/vendor/memory-core/src/server/index.js --config $CONFIG_PATH --host 127.0.0.1 --port 18960 --db $MEMORY_DIR/memory.sqlite
Restart=on-failure
RestartSec=3s
UMask=0077

[Install]
WantedBy=default.target
EOF_UNIT

cat > "$HOME/.config/systemd/user/memhub-local.service" <<EOF_UNIT
[Unit]
Description=Memhub Local Gateway
After=memhub-core.service
Requires=memhub-core.service

[Service]
Type=simple
EnvironmentFile=$ENV_PATH
ExecStart=$NODE $REPO_ROOT/dist/mcp.js --http 3001 --http-path /memhub/mcp --capture-path /memhub/capture --state-root $SERVER_STATE --memory-url http://127.0.0.1:18960
Restart=on-failure
RestartSec=3s
UMask=0077

[Install]
WantedBy=default.target
EOF_UNIT

cat > "$HOME/.config/systemd/user/memhub-bridge.service" <<EOF_UNIT
[Unit]
Description=Memhub Local Bridge
After=memhub-local.service
Requires=memhub-local.service

[Service]
Type=simple
Environment=MEMHUB_BRIDGE_HOME=$STATE_ROOT
ExecStart=$NODE $REPO_ROOT/dist/bridge.js serve --port 17861
Restart=on-failure
RestartSec=3s
UMask=0077

[Install]
WantedBy=default.target
EOF_UNIT

systemctl --user daemon-reload
systemctl --user enable memhub-core.service memhub-local.service memhub-bridge.service >/dev/null
systemctl --user restart memhub-core.service memhub-local.service memhub-bridge.service

echo "[memhub] Local Edition installed"
echo "[memhub] MCP for plugins: http://127.0.0.1:17861/mcp"
echo "[memhub] Capture for plugins: http://127.0.0.1:17861/capture"
echo "[memhub] State: $STATE_ROOT"
