#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $(id -u) == 0 ]]; then echo 'Run as the bridge user (sudo is invoked only for service registration).' >&2; exit 1; fi
user=$(id -un)
root=$PWD
node_bin=$(command -v node)
# Avoid interpolation/escaping problems in the generated systemd unit.
[[ $user =~ ^[a-zA-Z0-9_-]+$ && $root =~ ^/[a-zA-Z0-9_./-]+$ && $node_bin =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Use a simple absolute repository path and username.' >&2; exit 1; }
test -f google-home/.env.local
test -x google-home/.venv/bin/python
chmod 600 google-home/.env.local
if systemctl is-active --quiet asobu-google-home.service; then
  echo 'Stop the existing service before changing its configuration.' >&2
  exit 1
fi
sudo tee /etc/systemd/system/asobu-google-home.service >/dev/null <<EOF
[Unit]
Description=Asobu Yasumu local Google Home bridge
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$user
WorkingDirectory=$root
Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $root/google-home/run.sh
Restart=on-failure
RestartSec=30s
RestartPreventExitStatus=75
KillMode=control-group
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
echo 'Registered (not started). Stop the old Windows bridge first, then run:'
echo 'sudo systemctl enable --now asobu-google-home.service'
