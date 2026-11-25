#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $(id -u) == 0 ]]; then echo 'Run setup as the dedicated regular Linux user, not root.' >&2; exit 1; fi
node -e 'if (+process.versions.node.split(".")[0] !== 22) { console.error("Node.js 22 LTS is required"); process.exit(1) }'
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
command -v open_jtalk >/dev/null
command -v flock >/dev/null
npm install --no-audit --no-fund
python3 -m venv google-home/.venv
google-home/.venv/bin/python -m pip install -r google-home/requirements.txt
install -d -m 700 google-home/.local
if [[ ! -f google-home/.env.local ]]; then
  install -m 600 google-home/.env.example google-home/.env.local
fi
chmod 600 google-home/.env.local
google-home/.venv/bin/python tests/google-home-playback.py
google-home/.venv/bin/python google-home/test-tts.py
echo 'Setup complete. Configure google-home/.env.local; never commit credentials.'
