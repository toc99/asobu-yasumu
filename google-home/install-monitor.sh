#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ $(id -u) == 0 ]]; then echo 'Run as the normal bridge user.' >&2; exit 1; fi
test -f /usr/local/sbin/home-wifi-watchdog.sh || echo 'Existing Wi-Fi watchdog not found; recovery metrics may be unavailable.'
sudo install -d -m 755 /usr/local/libexec
sudo install -m 755 -o root -g root collect-monitor.py /usr/local/libexec/asobu-collect-monitor.py
sudo install -m 644 -o root -g root asobu-monitor.service asobu-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now asobu-monitor.timer
sudo systemctl start asobu-monitor.service
echo 'Collector installed. No network or watchdog settings were changed.'
