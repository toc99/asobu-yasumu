#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $(id -u) == 0 ]]; then echo 'Do not run the bridge as root.' >&2; exit 1; fi
test -f google-home/.env.local
test -x google-home/.venv/bin/python
install -d -m 700 google-home/.local
export GH_STATE_DIR="$PWD/google-home/.local"
export GH_PYTHON="$PWD/google-home/.venv/bin/python"
export PYTHONUTF8=1
exec flock -n -E 75 "$GH_STATE_DIR/bridge.lock" node --env-file=google-home/.env.local google-home/bridge.mjs
