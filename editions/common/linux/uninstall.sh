#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NODE="${NODE:-$(command -v node || true)}"
UNIT_DIR="$HOME/.config/systemd/user"
systemctl --user disable --now memhub-stack.target memhub.service memhub-core.service 2>/dev/null || true
rm -f "$UNIT_DIR/memhub-stack.target" "$UNIT_DIR/memhub.service" "$UNIT_DIR/memhub-core.service"
systemctl --user daemon-reload
if [[ "${1:-}" == "--purge-data" ]]; then
  STATE_ROOT="${MEMHUB_HOME:-}"
  if [[ -z "$STATE_ROOT" ]]; then
    if [[ -n "$NODE" ]]; then
      STATE_ROOT="$("$NODE" "$REPO_ROOT/src/state-root.mjs" --home)"
    else
      STATE_ROOT="$HOME/.memmy/memhub"
    fi
  fi
  rm -rf "$STATE_ROOT"
fi
echo "Memhub services removed. Data kept unless --purge-data was supplied."
