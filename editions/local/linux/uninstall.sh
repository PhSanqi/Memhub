#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now memhub-bridge.service memhub-local.service memhub-core.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/memhub-bridge.service" "$HOME/.config/systemd/user/memhub-local.service" "$HOME/.config/systemd/user/memhub-core.service"
systemctl --user daemon-reload
if [[ "${1:-}" == "--purge-data" ]]; then rm -rf "${MEMHUB_HOME:-$HOME/.memhub}"; fi
echo "Memhub Local Edition services removed. Data kept unless --purge-data was supplied."
