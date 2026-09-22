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
Memhub Complete installer (bundled Node.js runtime)

Usage:
  install-complete.sh [--edition local|server] [--version latest|vX.Y.Z]
                      [--install-dir PATH] [--state-root PATH]
                      [--public-host HOST] [--username NAME] [--email EMAIL]
                      [--prepare-only]
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

case "$EDITION" in local|server) ;; *) echo "--edition must be local or server" >&2; exit 2 ;; esac

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
PACKAGE_ROOT=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  CANDIDATE="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  [[ -x "$CANDIDATE/runtime/node/bin/node" ]] && PACKAGE_ROOT="$CANDIDATE"
fi

if [[ -n "$PACKAGE_ROOT" ]]; then
  NODE="$PACKAGE_ROOT/runtime/node/bin/node"
  if [[ "$PREPARE_ONLY" == "1" ]]; then
    (cd "$PACKAGE_ROOT" && "$NODE" scripts/complete-runtime-smoke.cjs)
    echo "[memhub] complete package verified: $PACKAGE_ROOT"
    exit 0
  fi
  export NODE
  [[ -n "$STATE_ROOT" ]] && export MEMHUB_HOME="$STATE_ROOT"
  if [[ "$EDITION" == "server" ]]; then
    export MEMHUB_USERNAME="$USERNAME"
    [[ -n "$EMAIL" ]] && export MEMHUB_EMAIL="$EMAIL" || unset MEMHUB_EMAIL || true
    [[ -n "$PUBLIC_HOST" ]] && export MEMHUB_PUBLIC_HOST="$PUBLIC_HOST" || unset MEMHUB_PUBLIC_HOST || true
  fi
  echo "[memhub] using bundled runtime: $($NODE --version)"
  bash "$PACKAGE_ROOT/editions/$EDITION/linux/install.sh"
  exit 0
fi

for command in curl tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

if [[ "$VERSION" == "latest" ]]; then
  EFFECTIVE_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  TAG="${EFFECTIVE_URL%/}"; TAG="${TAG##*/}"
else
  TAG="$VERSION"; [[ "$TAG" == v* ]] || TAG="v$TAG"
fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not resolve a stable Memhub release tag: $TAG" >&2; exit 2; }

ASSET="memhub-${TAG}-linux-x64-complete.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/memhub-complete.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
echo "[memhub] complete release: $TAG"
echo "[memhub] downloading: $ASSET"
curl -fL --retry 3 --retry-delay 1 "$BASE_URL/$ASSET" -o "$TMP/$ASSET"
curl -fL --retry 3 --retry-delay 1 "$BASE_URL/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"
EXPECTED_LINE="$(grep -E "^[0-9a-fA-F]{64}  ${ASSET//./\\.}$" "$TMP/SHA256SUMS.txt" || true)"
[[ -n "$EXPECTED_LINE" ]] || { echo "Checksum entry missing for $ASSET" >&2; exit 1; }
EXPECTED="${EXPECTED_LINE%% *}"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')";
elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')";
else echo "sha256sum or shasum is required" >&2; exit 2; fi
[[ "${ACTUAL,,}" == "${EXPECTED,,}" ]] || { echo "SHA-256 verification failed for $ASSET" >&2; exit 1; }

mkdir -p "$INSTALL_BASE" "$TMP/extract"
tar -xzf "$TMP/$ASSET" -C "$TMP/extract"
ROOT_NAME="${ASSET%.tar.gz}"
SOURCE="$TMP/extract/$ROOT_NAME"
[[ -x "$SOURCE/runtime/node/bin/node" ]] || { echo "Complete archive is missing bundled Node.js" >&2; exit 1; }
TARGET="$INSTALL_BASE/${TAG}-complete"
rm -rf "$TARGET"
mv "$SOURCE" "$TARGET"

ARGS=(--edition "$EDITION" --install-dir "$INSTALL_BASE")
[[ -n "$STATE_ROOT" ]] && ARGS+=(--state-root "$STATE_ROOT")
[[ -n "$PUBLIC_HOST" ]] && ARGS+=(--public-host "$PUBLIC_HOST")
[[ -n "$USERNAME" ]] && ARGS+=(--username "$USERNAME")
[[ -n "$EMAIL" ]] && ARGS+=(--email "$EMAIL")
[[ "$PREPARE_ONLY" == "1" ]] && ARGS+=(--prepare-only)
exec bash "$TARGET/install-complete.sh" "${ARGS[@]}"
