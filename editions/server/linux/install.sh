#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STATE_ROOT="${MEMHUB_HOME:-$HOME/.memhub}"
SERVER_STATE="$STATE_ROOT/server"
MEMORY_DIR="$STATE_ROOT/memory"
CONFIG_PATH="$STATE_ROOT/memory-config.yaml"
ENV_PATH="$STATE_ROOT/server.env"
NODE="${NODE:-$(command -v node || true)}"
NPM="${NPM:-$(command -v npm || true)}"
USERNAME="${MEMHUB_USERNAME:-owner}"
EMAIL="${MEMHUB_EMAIL:-}"
PUBLIC_HOST="${MEMHUB_PUBLIC_HOST:-}"

[[ -n "$NODE" ]] || { echo "Node.js 20+ is required" >&2; exit 2; }
[[ -n "$NPM" ]] || { echo "npm is required" >&2; exit 2; }

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "[memhub] dependencies missing; installing from lockfile"
  (cd "$REPO_ROOT" && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --workspaces=false)
fi
if [[ ! -f "$REPO_ROOT/vendor/memory-core/src/server/index.js" || ! -f "$REPO_ROOT/dist/mcp.js" ]]; then
  echo "[memhub] build output missing; building Memhub"
  (cd "$REPO_ROOT" && npm run build)
fi

mkdir -p "$STATE_ROOT" "$SERVER_STATE" "$MEMORY_DIR" "$HOME/.config/systemd/user"
chmod 700 "$STATE_ROOT" "$SERVER_STATE" "$MEMORY_DIR"
MEMORY_TOKEN="$("$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
"$NODE" - "$CONFIG_PATH" "$MEMORY_DIR/memory.sqlite" "$MEMORY_TOKEN" <<'NODE'
const fs=require('node:fs'); const [path,db,token]=process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  memmyMemory:{version:1,userId:'local-user',roleRouting:{summary:'follow',evolution:'follow'},storage:{mode:'local',backend:'sqlite',sqlitePath:db,endpoint:'http://127.0.0.1:18960',token},algorithm:{enableMemoryAdd:true,enableMemorySearch:true,enableQueryRewrite:false},agentAccess:{autoScanKnownAgents:false,watchFileChanges:false,autoInjectSkill:false}},
  providers:{},modelAssignments:{default:null,memorySummary:null,memoryEvolution:null,embedding:null,asr:null,imageGeneration:null},modelPresets:{},app:{}
},null,2)+'\n',{mode:0o600});
NODE
chmod 600 "$CONFIG_PATH"

TMP="$STATE_ROOT/account.tmp.json"
"$NODE" "$REPO_ROOT/dist/mcp.js" account list --state-root "$SERVER_STATE" > "$TMP"
ACCOUNT_ID="$("$NODE" - "$TMP" "$USERNAME" <<'NODE'
const fs=require('node:fs'); const [p,u]=process.argv.slice(2); const a=JSON.parse(fs.readFileSync(p,'utf8')); const f=a.find(x=>x.username===u); if(f) process.stdout.write(f.account_id);
NODE
)"
if [[ -z "$ACCOUNT_ID" ]]; then
  if [[ -n "$EMAIL" ]]; then
    "$NODE" "$REPO_ROOT/dist/mcp.js" account add "$USERNAME" "$EMAIL" --state-root "$SERVER_STATE" > "$TMP"
  else
    "$NODE" "$REPO_ROOT/dist/mcp.js" account add "$USERNAME" --state-root "$SERVER_STATE" > "$TMP"
  fi
  ACCOUNT_ID="$("$NODE" - "$TMP" <<'NODE'
const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); process.stdout.write(x.account_id);
NODE
)"
fi
rm -f "$TMP"

cat > "$ENV_PATH" <<EOF_ENV
MEMHUB_OWNER_ACCOUNT_ID=$ACCOUNT_ID
MEMHUB_OWNER_USER_ID=local-user
MEMHUB_MEMORY_TOKEN=$MEMORY_TOKEN
MEMHUB_MEMORY_URL=http://127.0.0.1:18960
MEMHUB_STATE_ROOT=$SERVER_STATE
MEMHUB_BINDINGS=$STATE_ROOT/conversation-project-bindings.json
MEMHUB_NORMIFY_ROOT=$REPO_ROOT/..
MEMHUB_ARCHITECTURE_CORE=embedded
EOF_ENV
if [[ -n "$PUBLIC_HOST" ]]; then printf 'MEMHUB_PUBLIC_HOST=%s\n' "$PUBLIC_HOST" >> "$ENV_PATH"; fi
chmod 600 "$ENV_PATH"

cat > "$HOME/.config/systemd/user/memhub-core.service" <<EOF_UNIT
[Unit]
Description=Memhub Embedded Memory Core
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

EXTRA_HOST_ARGS=""
if [[ -n "$PUBLIC_HOST" ]]; then EXTRA_HOST_ARGS="--public-host $PUBLIC_HOST"; fi
cat > "$HOME/.config/systemd/user/memhub-server.service" <<EOF_UNIT
[Unit]
Description=Memhub Server Gateway
After=memhub-core.service network-online.target
Requires=memhub-core.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_PATH
ExecStart=$NODE $REPO_ROOT/dist/mcp.js --http 3001 --http-path /memhub/mcp --capture-path /memhub/capture --state-root $SERVER_STATE --memory-url http://127.0.0.1:18960 --normify-root $REPO_ROOT/.. $EXTRA_HOST_ARGS
Restart=on-failure
RestartSec=3s
UMask=0077

[Install]
WantedBy=default.target
EOF_UNIT

systemctl --user daemon-reload
systemctl --user enable --now memhub-core.service memhub-server.service

echo "[memhub] Server Edition installed on loopback"
echo "[memhub] Origin MCP:     http://127.0.0.1:3001/memhub/mcp"
echo "[memhub] Origin capture: http://127.0.0.1:3001/memhub/capture"
echo "[memhub] Account: $USERNAME"
if [[ -z "$PUBLIC_HOST" ]]; then
  echo "[memhub] Set MEMHUB_PUBLIC_HOST in $ENV_PATH before publishing through Cloudflare Access."
else
  echo "[memhub] Public host validation enabled for $PUBLIC_HOST"
fi
