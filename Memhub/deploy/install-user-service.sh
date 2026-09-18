#!/usr/bin/env bash
set -euo pipefail

MEMHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
NORMIFY_ROOT="${NORMIFY_ROOT:-$(cd "$MEMHUB_DIR/../.." && pwd)}"
NORMIFY_COMMAND="${NORMIFY_COMMAND:-$(command -v normify || true)}"

if [[ -z "$NODE" ]]; then
  echo "node was not found" >&2
  exit 2
fi
if [[ -z "$NORMIFY_COMMAND" ]]; then
  if [[ -f "$NORMIFY_ROOT/Normify/lib/cli.js" ]]; then
    mkdir -p "$HOME/.memmy/memhub/bin"
    NORMIFY_COMMAND="$HOME/.memmy/memhub/bin/normify-memhub"
    printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' \
      "$NODE" "$NORMIFY_ROOT/Normify/lib/cli.js" > "$NORMIFY_COMMAND"
    chmod 700 "$NORMIFY_COMMAND"
  else
    echo "normify was not found; set NORMIFY_COMMAND to an executable wrapper" >&2
    exit 2
  fi
fi
if [[ "$NORMIFY_COMMAND" == *" "* ]]; then
  echo "NORMIFY_COMMAND must be one executable path; create a wrapper when the command needs arguments" >&2
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
  -e "s|@NORMIFY_COMMAND@|$(escape_sed "$NORMIFY_COMMAND")|g" \
  "$MEMHUB_DIR/deploy/memhub.service.in" \
  > "$HOME/.config/systemd/user/memhub.service"

systemctl --user daemon-reload
echo "installed: $HOME/.config/systemd/user/memhub.service"
echo "next: systemctl --user enable --now memhub.service"
