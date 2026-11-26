#!/usr/bin/env python3
"""Root-owned read-only collector. Export only bounded enum/number telemetry."""
import datetime as dt
import json
import os
import pathlib
import subprocess
import tempfile
import time

OUT = pathlib.Path('/run/asobu-monitor/status.json')
JST = dt.timezone(dt.timedelta(hours=9))
EVENTS = {
    'Starting Wi-Fi recovery': 'start',
    'Wi-Fi recovery successful': 'success',
    'Wi-Fi recovery failed': 'failure',
    'Hardware radio block detected': 'blocked',
    'Network connection recovered': 'recovered',
}
def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=8, check=False)
def collect():
    now = dt.datetime.now(JST)
    day = now.date().isoformat()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    row = dict(observedAt=int(time.time()*1000), watchdog='unknown', wifi='unknown',
               recoveryDay='', attempts=0, successes=0, failures=0, events=[])
    try:
        s = run(['/usr/bin/systemctl','is-active','home-wifi-watchdog.timer'])
        state = s.stdout.strip()
        if state == 'active':
            row['watchdog'] = 'active'
        elif state in ('inactive','failed','unknown'):
            row['watchdog'] = 'inactive'
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        link = run(['/usr/sbin/iw','dev','wlp11s0','link'])
        addr = run(['/usr/sbin/ip','-4','-o','addr','show','dev','wlp11s0','scope','global'])
        if link.returncode == 0 and addr.returncode == 0:
            row['wifi'] = 'connected' if link.stdout.startswith('Connected to ') and ' inet ' in addr.stdout else 'disconnected'
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        journal = run(['/usr/bin/journalctl','--system','-u','home-wifi-watchdog.service',
                       '--since=@'+str(int(start.timestamp())), '--output=json','--no-pager','-q'])
        if journal.returncode == 0 and journal.stdout.strip():
            events = []
            for line in journal.stdout.splitlines():
                try:
                    data = json.loads(line)
                    kind = EVENTS.get(data.get('MESSAGE',''))
                    if kind:
                        at = int(data['__REALTIME_TIMESTAMP'])//1000
                        if start.timestamp()*1000 <= at <= time.time()*1000+30000:
                            events.append(dict(at=at,kind=kind))
                except (ValueError, KeyError, TypeError):
                    continue
            row.update(recoveryDay=day,
                       attempts=min(1440,sum(e['kind']=='start' for e in events)),
                       successes=min(1440,sum(e['kind']=='success' for e in events)),
                       failures=min(1440,sum(e['kind'] in ('failure','blocked') for e in events)),
                       events=sorted(events,key=lambda e:e['at'],reverse=True)[:5])
    except (OSError, subprocess.SubprocessError):
        pass
    return row
def main():
    data = collect()
    with tempfile.NamedTemporaryFile(mode='w',dir=OUT.parent,delete=False) as f:
        temp = f.name
        json.dump(data,f,ensure_ascii=True,separators=(',',':'))
        os.fchmod(f.fileno(),0o644)
    os.replace(temp,OUT)
if __name__ == '__main__':
    main()
