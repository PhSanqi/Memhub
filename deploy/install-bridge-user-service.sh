#!/usr/bin/env bash
set -euo pipefail

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
BASE_PATH="${MEMHUB_BASE_PATH:-}"
if [[ -z "$BASE_PATH" && -f "$HOME/.memmy/memhub/memhub.env" ]]; then
  BASE_PATH="$(sed -n 's/^MEMHUB_BASE_PATH=//p' "$HOME/.memmy/memhub/memhub.env" | tail -n 1)"
fi
BASE_PATH="${BASE_PATH:-/memhub}"
if [[ "$BASE_PATH" == "/" ]]; then
  HEALTH_PATH="/health"
else
  BASE_PATH="/${BASE_PATH#/}"
  BASE_PATH="${BASE_PATH%/}"
  HEALTH_PATH="$BASE_PATH/health"
fi

if [[ -z "$NODE" ]]; then
  echo "node was not found" >&2
  exit 2
fi
if [[ ! -f "$HOME/.config/systemd/user/memhub-stack.target" ]]; then
  echo "memhub-stack.target is missing; run deploy/install-user-service.sh first" >&2
  exit 2
fi

mkdir -p "$HOME/.config/systemd/user" "$HOME/.memhub"
chmod 700 "$HOME/.memhub"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

sed \
  -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
  -e "s|@NODE@|$(escape_sed "$NODE")|g" \
  -e "s|@HEALTH_PATH@|$(escape_sed "$HEALTH_PATH")|g" \
  "$MEMHUB_DIR/deploy/memhub-bridge.service.in" \
  > "$HOME/.config/systemd/user/memhub-bridge.service"

systemctl --user daemon-reload
echo "installed: $HOME/.config/systemd/user/memhub-bridge.service"
echo "configure bridge credentials before enabling it"
echo "then: systemctl --user enable --now memhub-bridge.service"
echo "future memhub-stack.target starts/stops will include the enabled Bridge"
