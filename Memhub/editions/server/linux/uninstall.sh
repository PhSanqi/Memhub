#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now memhub-server.service memhub-memory.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/memhub-server.service" "$HOME/.config/systemd/user/memhub-memory.service"
systemctl --user daemon-reload
if [[ "${1:-}" == "--purge-data" ]]; then rm -rf "${MEMHUB_HOME:-$HOME/.memhub}"; fi
echo "Memhub Server Edition services removed. Data kept unless --purge-data was supplied."
