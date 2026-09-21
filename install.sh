#!/usr/bin/env bash
set -euo pipefail

REPO="PhSanqi/Memhub"
EDITION="${MEMHUB_EDITION:-local}"
VERSION="${MEMHUB_VERSION:-latest}"
INSTALL_BASE="${MEMHUB_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/memhub}"
STATE_ROOT="${MEMHUB_HOME:-}"
PUBLIC_HOST="${MEMHUB_PUBLIC_HOST:-}"
USERNAME="${MEMHUB_USERNAME:-owner}"
EMAIL="${MEMHUB_EMAIL:-}"
PREPARE_ONLY="${MEMHUB_PREPARE_ONLY:-0}"

usage() {
  cat <<'EOF'
Memhub bootstrap installer

Usage:
  install.sh [--edition local|server] [--version latest|vX.Y.Z]
             [--install-dir PATH] [--state-root PATH]
             [--public-host HOST] [--username NAME] [--email EMAIL]
             [--prepare-only]

Examples:
  curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | bash
  curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | \
    bash -s -- --edition server --public-host memory.example.com
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --edition) EDITION="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_BASE="${2:-}"; shift 2 ;;
    --state-root) STATE_ROOT="${2:-}"; shift 2 ;;
    --public-host) PUBLIC_HOST="${2:-}"; shift 2 ;;
    --username) USERNAME="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --prepare-only) PREPARE_ONLY="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$EDITION" in
  local|server) ;;
  *) echo "--edition must be local or server" >&2; exit 2 ;;
esac

for command in curl tar node npm; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  echo "Node.js 20+ is required (found: $(node --version 2>/dev/null || echo unknown))" >&2
  exit 2
fi

if [[ "$VERSION" == "latest" ]]; then
  EFFECTIVE_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  TAG="${EFFECTIVE_URL%/}"
  TAG="${TAG##*/}"
else
  TAG="$VERSION"
  [[ "$TAG" == v* ]] || TAG="v$TAG"
fi

[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not resolve a stable Memhub release tag: $TAG" >&2; exit 2; }

ASSET="memhub-${TAG}-linux-${EDITION}.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/memhub-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "[memhub] release: $TAG"
echo "[memhub] edition: Linux $EDITION"
echo "[memhub] downloading: $ASSET"
curl -fL --retry 3 --retry-delay 1 "$BASE_URL/$ASSET" -o "$TMP/$ASSET"
curl -fL --retry 3 --retry-delay 1 "$BASE_URL/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"

EXPECTED_LINE="$(grep -E "^[0-9a-fA-F]{64}  ${ASSET//./\\.}$" "$TMP/SHA256SUMS.txt" || true)"
[[ -n "$EXPECTED_LINE" ]] || { echo "Checksum entry missing for $ASSET" >&2; exit 1; }
EXPECTED="${EXPECTED_LINE%% *}"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required to verify the release" >&2
  exit 2
fi
[[ "${ACTUAL,,}" == "${EXPECTED,,}" ]] || { echo "SHA-256 verification failed for $ASSET" >&2; exit 1; }
echo "[memhub] SHA-256 verified"

mkdir -p "$INSTALL_BASE" "$TMP/extract"
tar -xzf "$TMP/$ASSET" -C "$TMP/extract"
ROOT_NAME="${ASSET%.tar.gz}"
SOURCE="$TMP/extract/$ROOT_NAME"
[[ -d "$SOURCE" ]] || { echo "Unexpected release archive layout" >&2; exit 1; }

TARGET="$INSTALL_BASE/${TAG}-${EDITION}"
rm -rf "$TARGET"
mv "$SOURCE" "$TARGET"

if [[ -n "$STATE_ROOT" ]]; then export MEMHUB_HOME="$STATE_ROOT"; fi
if [[ "$EDITION" == "server" ]]; then
  export MEMHUB_USERNAME="$USERNAME"
  [[ -n "$EMAIL" ]] && export MEMHUB_EMAIL="$EMAIL" || unset MEMHUB_EMAIL || true
  [[ -n "$PUBLIC_HOST" ]] && export MEMHUB_PUBLIC_HOST="$PUBLIC_HOST" || unset MEMHUB_PUBLIC_HOST || true
fi

INSTALLER="$TARGET/editions/$EDITION/linux/install.sh"
if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo "[memhub] package prepared and verified: $TARGET"
  exit 0
fi
echo "[memhub] installing from: $TARGET"
bash "$INSTALLER"

echo "[memhub] installation complete"
echo "[memhub] app files: $TARGET"
if [[ "$EDITION" == "local" ]]; then
  echo "[memhub] MCP: http://127.0.0.1:17861/mcp"
else
  echo "[memhub] Origin MCP: http://127.0.0.1:3001/memhub/mcp"
fi
