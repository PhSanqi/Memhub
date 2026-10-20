#!/usr/bin/env bash
set -euo pipefail

# Single systemd unit generator for Memhub.
#
# `editions/common/linux/install.sh` calls this script with --render-only after
# it has created the state root, and standalone operators run it directly.
# Unit text is therefore produced by one code path (deploy/*.in plus the sed
# substitutions below); systemd is only touched in install mode.

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node || true)}"
RENDER_DIR=""
STATE_ROOT_ARG=""
CORE_CONFIG_ARG=""
CORE_DB_ARG=""
HTTP_PATH_ARG=""

usage() {
  cat <<'EOF'
Usage: install-user-service.sh [--render-only DIR] [--home PATH]
                               [--core-config PATH] [--core-db PATH]
                               [--http-path PATH] [--architecture-root PATH]
                               [--base-path PATH]

Without --render-only, renders and installs user units, then runs
`systemctl --user daemon-reload`. With --render-only DIR, writes the same
unit text into DIR and never touches state or systemd.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --render-only) RENDER_DIR="${2:-}"; shift 2 ;;
    --home|--state-root) STATE_ROOT_ARG="${2:-}"; shift 2 ;;
    --core-config) CORE_CONFIG_ARG="${2:-}"; shift 2 ;;
    --core-db) CORE_DB_ARG="${2:-}"; shift 2 ;;
    --http-path) HTTP_PATH_ARG="${2:-}"; shift 2 ;;
    --architecture-root) ARCHITECTURE_ROOT="${2:-}"; shift 2 ;;
    --base-path) MEMHUB_BASE_PATH="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[memhub] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$NODE" ]]; then
  echo "node was not found" >&2
  exit 2
fi
if [[ ! -f "$MEMHUB_DIR/vendor/memory-core/src/server/index.js" ]]; then
  echo "vendored Memory Core is missing" >&2
  exit 2
fi

# The shared module is the only source of home/control-root precedence.
if [[ -n "$STATE_ROOT_ARG" ]]; then
  export MEMHUB_HOME="$STATE_ROOT_ARG"
  unset MEMHUB_STATE_ROOT
fi
STATE_ROOT="$("$NODE" "$MEMHUB_DIR/src/state-root.mjs" --home)"
# The gateway control root follows the same rule as the module: MEMHUB_STATE_ROOT
# wins (edition installs point it at <home>/server), otherwise an existing
# <home>/server/accounts.json keeps that layout, otherwise the flat home.
CONTROL_ROOT="$("$NODE" "$MEMHUB_DIR/src/state-root.mjs" --control-root)"

ARCHITECTURE_ROOT="${ARCHITECTURE_ROOT:-${NORMIFY_ROOT:-$(cd "$MEMHUB_DIR/../.." && pwd)}}"
BASE_PATH="${MEMHUB_BASE_PATH:-}"
if [[ -z "$BASE_PATH" && -f "$STATE_ROOT/memhub.env" ]]; then
  BASE_PATH="$(sed -n 's/^MEMHUB_BASE_PATH=//p' "$STATE_ROOT/memhub.env" | tail -n 1)"
fi
BASE_PATH="${BASE_PATH:-/memhub}"
if [[ "$BASE_PATH" == "/" ]]; then
  DEFAULT_HTTP_PATH="/mcp"
  HEALTH_PATH="/health"
else
  BASE_PATH="/${BASE_PATH#/}"
  BASE_PATH="${BASE_PATH%/}"
  DEFAULT_HTTP_PATH="$BASE_PATH/mcp"
  HEALTH_PATH="$BASE_PATH/health"
fi
HTTP_PATH="${HTTP_PATH_ARG:-${MEMHUB_HTTP_PATH:-$DEFAULT_HTTP_PATH}}"

# Core paths: preserve an existing legacy Memmy install in place, otherwise
# use the canonical state-root layout. install.sh passes explicit paths.
if [[ -n "$CORE_CONFIG_ARG" ]]; then
  CORE_CONFIG="$CORE_CONFIG_ARG"
elif [[ -f "$HOME/.memmy/config.yaml" ]]; then
  CORE_CONFIG="$HOME/.memmy/config.yaml"
elif [[ -f "$STATE_ROOT/memory-config.yaml" ]]; then
  CORE_CONFIG="$STATE_ROOT/memory-config.yaml"
else
  CORE_CONFIG="$STATE_ROOT/core/config.yaml"
fi
if [[ -n "$CORE_DB_ARG" ]]; then
  CORE_DB="$CORE_DB_ARG"
elif [[ -f "$HOME/.memmy/memory-service/memory.sqlite" ]]; then
  CORE_DB="$HOME/.memmy/memory-service/memory.sqlite"
elif [[ -f "$STATE_ROOT/memory/memory.sqlite" ]]; then
  CORE_DB="$STATE_ROOT/memory/memory.sqlite"
else
  CORE_DB="$STATE_ROOT/core/memory.sqlite"
fi
CORE_HOME="$(dirname "$CORE_CONFIG")"

UNIT_DIR="$HOME/.config/systemd/user"

# This script installs a fresh unit set, not an in-place upgrade. Refuse any
# existing Memhub unit before writing state or replacing a service definition.
# Even a dangling symlink is an occupied unit path.
if [[ -z "$RENDER_DIR" ]]; then
  for unit in memhub-core.service memhub.service memhub-bridge.service memhub-stack.target memhub-local.service memhub-server.service memhub-local-stack.target memhub-server-stack.target; do
    if [[ -e "$UNIT_DIR/$unit" || -L "$UNIT_DIR/$unit" ]]; then
      echo "[memhub] Existing Memhub systemd unit ($unit); refusing fresh install. Use a reviewed upgrade procedure." >&2
      exit 2
    fi
  done
fi

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

render_unit() {
  local template="$1" output="$2"
  sed \
    -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
    -e "s|@NODE@|$(escape_sed "$NODE")|g" \
    -e "s|@ARCHITECTURE_ROOT@|$(escape_sed "$ARCHITECTURE_ROOT")|g" \
    -e "s|@HTTP_PATH@|$(escape_sed "$HTTP_PATH")|g" \
    -e "s|@HEALTH_PATH@|$(escape_sed "$HEALTH_PATH")|g" \
    -e "s|@STATE_ROOT@|$(escape_sed "$STATE_ROOT")|g" \
    -e "s|@CONTROL_ROOT@|$(escape_sed "$CONTROL_ROOT")|g" \
    -e "s|@CORE_HOME@|$(escape_sed "$CORE_HOME")|g" \
    -e "s|@CORE_CONFIG@|$(escape_sed "$CORE_CONFIG")|g" \
    -e "s|@CORE_DB@|$(escape_sed "$CORE_DB")|g" \
    "$template" > "$output"
}

if [[ -n "$RENDER_DIR" ]]; then
  mkdir -p "$RENDER_DIR"
  render_unit "$MEMHUB_DIR/deploy/memhub.service.in" "$RENDER_DIR/memhub.service"
  render_unit "$MEMHUB_DIR/deploy/memhub-core.service.in" "$RENDER_DIR/memhub-core.service"
  cp "$MEMHUB_DIR/deploy/memhub-stack.target.in" "$RENDER_DIR/memhub-stack.target"
  exit 0
fi

mkdir -p "$UNIT_DIR" "$STATE_ROOT"
chmod 700 "$STATE_ROOT"

render_unit "$MEMHUB_DIR/deploy/memhub.service.in" "$UNIT_DIR/memhub.service"
render_unit "$MEMHUB_DIR/deploy/memhub-core.service.in" "$UNIT_DIR/memhub-core.service"
cp "$MEMHUB_DIR/deploy/memhub-stack.target.in" "$UNIT_DIR/memhub-stack.target"

systemctl --user daemon-reload
echo "installed: $UNIT_DIR/memhub.service"
echo "installed: $UNIT_DIR/memhub-core.service"
echo "installed: $UNIT_DIR/memhub-stack.target"
echo "next: systemctl --user enable --now memhub-stack.target"
