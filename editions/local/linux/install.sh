#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MEMHUB_USERNAME="${MEMHUB_USERNAME:-local}"
exec bash "$SCRIPT_DIR/../../common/linux/install.sh" "$@"
