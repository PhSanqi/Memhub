#!/usr/bin/env bash
set -euo pipefail

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
NORMIFY_ROOT="${NORMIFY_ROOT:-$(cd "$MEMHUB_DIR/../.." && pwd)}"

if [[ -z "$NODE" ]]; then
  echo "node was not found" >&2
  exit 2
fi
if [[ ! -f "$MEMHUB_DIR/vendor/memory-core/src/server/index.js" ]]; then
  echo "vendored Memory Core is missing" >&2
  exit 2
fi
if [[ ! -f "$MEMHUB_DIR/vendor/normify/lib/generic.js" ]]; then
  echo "vendored architecture core is missing" >&2
  exit 2
fi

mkdir -p "$HOME/.config/systemd/user" "$HOME/.memmy/memhub"
chmod 700 "$HOME/.memmy/memhub"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

sed \
  -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
  -e "s|@NODE@|$(escape_sed "$NODE")|g" \
  -e "s|@NORMIFY_ROOT@|$(escape_sed "$NORMIFY_ROOT")|g" \
  "$MEMHUB_DIR/deploy/memhub.service.in" \
  > "$HOME/.config/systemd/user/memhub.service"

sed \
  -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
  -e "s|@NODE@|$(escape_sed "$NODE")|g" \
  "$MEMHUB_DIR/deploy/memhub-core.service.in" \
  > "$HOME/.config/systemd/user/memhub-core.service"

systemctl --user daemon-reload
echo "installed: $HOME/.config/systemd/user/memhub.service"
echo "installed: $HOME/.config/systemd/user/memhub-core.service"
echo "next: systemctl --user enable --now memhub-core.service memhub.service"
