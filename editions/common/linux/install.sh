#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUNDLED_NODE="$REPO_ROOT/runtime/node"
NODE="${NODE:-$([[ -x "$BUNDLED_NODE" ]] && printf '%s' "$BUNDLED_NODE" || command -v node || true)}"
NPM="${NPM:-$(command -v npm || true)}"
# Shared resolver: install home = explicit --home > MEMHUB_HOME > existing
# ~/.memmy/memhub > legacy ~/.memhub > default. MEMHUB_STATE_ROOT names the
# gateway control root (written below as <home>/server) and never affects it.
[[ -n "$NODE" ]] || { echo "Node.js 20+ is required" >&2; exit 2; }
STATE_ROOT="$("$NODE" "$REPO_ROOT/src/state-root.mjs" --home)"
CONTROL_ROOT="$STATE_ROOT/server"
MEMORY_DIR="$STATE_ROOT/memory"
CONFIG_PATH="$STATE_ROOT/memory-config.yaml"
ENV_PATH="$STATE_ROOT/memhub.env"
UNIT_DIR="$HOME/.config/systemd/user"
USERNAME="${MEMHUB_USERNAME:-owner}"
EMAIL="${MEMHUB_EMAIL:-}"
PUBLIC_HOST="${MEMHUB_PUBLIC_HOST:-}"

if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
  echo "[memhub] Existing state root; fresh installer refuses to overwrite it. Use the reviewed upgrade path." >&2
  exit 2
fi
# Current units plus legacy names are occupancy checks only. Legacy units are
# never installed by this script.
for unit in memhub-core.service memhub.service memhub-stack.target memhub-local.service memhub-server.service memhub-bridge.service memhub-local-stack.target memhub-server-stack.target; do
  if [[ -e "$UNIT_DIR/$unit" || -L "$UNIT_DIR/$unit" ]]; then
    echo "[memhub] Existing Memhub systemd unit ($unit); refusing fresh install." >&2
    exit 2
  fi
done

[[ -n "$NODE" ]] || { echo "Node.js 20+ is required" >&2; exit 2; }
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  [[ -n "$NPM" ]] || { echo "npm is required because bundled dependencies are missing" >&2; exit 2; }
  (cd "$REPO_ROOT" && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --workspaces=false)
fi
if [[ ! -f "$REPO_ROOT/vendor/memory-core/src/server/index.js" || ! -f "$REPO_ROOT/dist/mcp.js" ]]; then
  [[ -n "$NPM" ]] || { echo "npm is required because build output is missing" >&2; exit 2; }
  (cd "$REPO_ROOT" && npm run build)
fi

mkdir -p "$(dirname "$STATE_ROOT")"
mkdir -m 700 "$STATE_ROOT"
mkdir -p "$CONTROL_ROOT" "$MEMORY_DIR" "$UNIT_DIR"
chmod 700 "$STATE_ROOT" "$CONTROL_ROOT" "$MEMORY_DIR"

MEMORY_TOKEN="$("$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
"$NODE" - "$CONFIG_PATH" "$MEMORY_DIR/memory.sqlite" "$MEMORY_TOKEN" <<'NODE'
const fs = require('node:fs');
const [path, db, token] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  memmyMemory: {
    version: 1,
    userId: 'local-user',
    roleRouting: { summary: 'follow', evolution: 'follow' },
    storage: { mode: 'local', backend: 'sqlite', sqlitePath: db, endpoint: 'http://127.0.0.1:18960', token },
    algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
    agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
  },
  providers: {},
  modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
  modelPresets: {},
  app: {}
}, null, 2) + '\n', { mode: 0o600 });
NODE
chmod 600 "$CONFIG_PATH"

TMP="$STATE_ROOT/account.tmp.json"
"$NODE" "$REPO_ROOT/dist/mcp.js" account list --state-root "$CONTROL_ROOT" > "$TMP"
ACCOUNT_ID="$("$NODE" - "$TMP" "$USERNAME" <<'NODE'
const fs = require('node:fs');
const [path, username] = process.argv.slice(2);
const account = JSON.parse(fs.readFileSync(path, 'utf8')).find((item) => item.username === username);
if (account) process.stdout.write(account.account_id);
NODE
)"
if [[ -z "$ACCOUNT_ID" ]]; then
  if [[ -n "$EMAIL" ]]; then
    "$NODE" "$REPO_ROOT/dist/mcp.js" account add "$USERNAME" "$EMAIL" --state-root "$CONTROL_ROOT" > "$TMP"
  else
    "$NODE" "$REPO_ROOT/dist/mcp.js" account add "$USERNAME" --state-root "$CONTROL_ROOT" > "$TMP"
  fi
  ACCOUNT_ID="$("$NODE" - "$TMP" <<'NODE'
const fs = require('node:fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).account_id);
NODE
)"
fi
rm -f "$TMP"

cat > "$ENV_PATH" <<EOF_ENV
MEMHUB_ACCOUNT_ID=$ACCOUNT_ID
MEMHUB_OWNER_ACCOUNT_ID=$ACCOUNT_ID
MEMHUB_OWNER_USER_ID=local-user
MEMHUB_MEMORY_TOKEN=$MEMORY_TOKEN
MEMHUB_MEMORY_URL=http://127.0.0.1:18960
MEMHUB_STATE_ROOT=$CONTROL_ROOT
EOF_ENV
if [[ -n "$PUBLIC_HOST" ]]; then printf 'MEMHUB_PUBLIC_HOST=%s\n' "$PUBLIC_HOST" >> "$ENV_PATH"; fi
chmod 600 "$ENV_PATH"

# One generator for both installer entrypoints: no inline unit heredocs here.
NODE="$NODE" bash "$REPO_ROOT/deploy/install-user-service.sh" \
  --render-only "$UNIT_DIR" \
  --home "$STATE_ROOT" \
  --core-config "$CONFIG_PATH" \
  --core-db "$MEMORY_DIR/memory.sqlite" \
  --http-path /mcp

systemctl --user daemon-reload
systemctl --user disable memhub-core.service memhub.service >/dev/null 2>&1 || true
systemctl --user enable --now memhub-stack.target

echo "[memhub] installed"
echo "[memhub] local MCP: http://127.0.0.1:3001/mcp"
echo "[memhub] account: $USERNAME"
if [[ -n "$PUBLIC_HOST" ]]; then
  echo "[memhub] remote host enabled: $PUBLIC_HOST"
else
  echo "[memhub] remote host disabled; loopback MCP only"
fi
