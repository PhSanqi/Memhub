#!/usr/bin/env bash
set -euo pipefail

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_URL="${MEMHUB_TUNNEL_WATCHDOG_PUBLIC_URL:-${MEMHUB_PUBLIC_HOST:+https://${MEMHUB_PUBLIC_HOST}/}}"
METRICS_URL="${MEMHUB_TUNNEL_WATCHDOG_METRICS_URL:-http://127.0.0.1:20241/metrics}"
TUNNEL_SERVICE="${MEMHUB_TUNNEL_WATCHDOG_SERVICE:-cloudflared.service}"
UNIT_DIR="$HOME/.config/systemd/user"

[[ -n "$PUBLIC_URL" ]] || {
  echo "Set MEMHUB_TUNNEL_WATCHDOG_PUBLIC_URL or MEMHUB_PUBLIC_HOST before installing the watchdog." >&2
  exit 2
}

mkdir -p "$UNIT_DIR"
escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
sed \
  -e "s|@MEMHUB_DIR@|$(escape_sed "$MEMHUB_DIR")|g" \
  -e "s|@PUBLIC_URL@|$(escape_sed "$PUBLIC_URL")|g" \
  -e "s|@METRICS_URL@|$(escape_sed "$METRICS_URL")|g" \
  -e "s|@TUNNEL_SERVICE@|$(escape_sed "$TUNNEL_SERVICE")|g" \
  "$MEMHUB_DIR/deploy/memhub-tunnel-watchdog.service.in" \
  > "$UNIT_DIR/memhub-tunnel-watchdog.service"
cp "$MEMHUB_DIR/deploy/memhub-tunnel-watchdog.timer" "$UNIT_DIR/memhub-tunnel-watchdog.timer"

systemctl --user daemon-reload
echo "installed: $UNIT_DIR/memhub-tunnel-watchdog.service"
echo "installed: $UNIT_DIR/memhub-tunnel-watchdog.timer"
echo "next: systemctl --user enable --now memhub-tunnel-watchdog.timer"
