#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="$HOME/.config/systemd/user"
systemctl --user disable --now memhub-stack.target memhub.service memhub-core.service 2>/dev/null || true
rm -f "$UNIT_DIR/memhub-stack.target" "$UNIT_DIR/memhub.service" "$UNIT_DIR/memhub-core.service"
systemctl --user daemon-reload
if [[ "${1:-}" == "--purge-data" ]]; then
  rm -rf "${MEMHUB_HOME:-$HOME/.memhub}"
fi
echo "Memhub services removed. Data kept unless --purge-data was supplied."
