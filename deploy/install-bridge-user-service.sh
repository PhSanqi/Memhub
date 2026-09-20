#!/usr/bin/env bash
set -euo pipefail

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"

if [[ -z "$NODE" ]]; then
  echo "node was not found" >&2
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
  "$MEMHUB_DIR/deploy/memhub-bridge.service.in" \
  > "$HOME/.config/systemd/user/memhub-bridge.service"

systemctl --user daemon-reload
echo "installed: $HOME/.config/systemd/user/memhub-bridge.service"
echo "configure bridge credentials before enabling it"
echo "then: systemctl --user enable --now memhub-bridge.service"
