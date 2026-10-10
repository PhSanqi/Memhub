#!/usr/bin/env bash
set -euo pipefail

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
ARCHITECTURE_ROOT="${ARCHITECTURE_ROOT:-${NORMIFY_ROOT:-$(cd "$MEMHUB_DIR/../.." && pwd)}}"
BASE_PATH="${MEMHUB_BASE_PATH:-}"
if [[ -z "$BASE_PATH" && -f "$HOME/.memmy/memhub/memhub.env" ]]; then
  BASE_PATH="$(sed -n 's/^MEMHUB_BASE_PATH=//p' "$HOME/.memmy/memhub/memhub.env" | tail -n 1)"
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
HTTP_PATH="${MEMHUB_HTTP_PATH:-$DEFAULT_HTTP_PATH}"

if [[ -z "$NODE" ]]; then
  echo "node was not found" >&2
  exit 2
fi
if [[ ! -f "$MEMHUB_DIR/vendor/memory-core/src/server/index.js" ]]; then
  echo "vendored Memory Core is missing" >&2
  exit 2
fi

# This script installs a fresh unit set, not an in-place upgrade. Refuse any
# existing Memhub unit before writing state or replacing a service definition.
# Even a dangling symlink is an occupied unit path.
UNIT_DIR="$HOME/.config/systemd/user"
for unit in memhub-core.service memhub.service memhub-bridge.service memhub-stack.target memhub-local.service memhub-server.service memhub-local-stack.target memhub-server-stack.target; do
  if [[ -e "$UNIT_DIR/$unit" || -L "$UNIT_DIR/$unit" ]]; then
    echo "[memhub] Existing Memhub systemd unit ($unit); refusing fresh install. Use a reviewed upgrade procedure." >&2
    exit 2
  fi
done

mkdir -p "$HOME/.config/systemd/user" "$HOME/.memmy/memhub"
chmod 700 "$HOME/.memmy/memhub"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

sed \
  -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
  -e "s|@NODE@|$(escape_sed "$NODE")|g" \
  -e "s|@ARCHITECTURE_ROOT@|$(escape_sed "$ARCHITECTURE_ROOT")|g" \
  -e "s|@HTTP_PATH@|$(escape_sed "$HTTP_PATH")|g" \
  -e "s|@HEALTH_PATH@|$(escape_sed "$HEALTH_PATH")|g" \
  "$MEMHUB_DIR/deploy/memhub.service.in" \
  > "$HOME/.config/systemd/user/memhub.service"

sed \
  -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
  -e "s|@NODE@|$(escape_sed "$NODE")|g" \
  "$MEMHUB_DIR/deploy/memhub-core.service.in" \
  > "$HOME/.config/systemd/user/memhub-core.service"

cp "$MEMHUB_DIR/deploy/memhub-stack.target.in" "$HOME/.config/systemd/user/memhub-stack.target"

systemctl --user daemon-reload
echo "installed: $HOME/.config/systemd/user/memhub.service"
echo "installed: $HOME/.config/systemd/user/memhub-core.service"
echo "installed: $HOME/.config/systemd/user/memhub-stack.target"
echo "next: systemctl --user enable --now memhub-stack.target"
