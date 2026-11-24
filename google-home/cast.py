"""Single local Cast operation; messages never leave the LAN for speech synthesis."""
import contextlib
import http.server
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave

def result(**kwargs):
    print(json.dumps(kwargs, ensure_ascii=True), flush=True)

def synthesize(text, target):
    if os.name != "nt":
        raise RuntimeError("Windows Japanese SAPI voice is required for this version")
    # Text is passed through a UTF-8 file, never as a shell command.
    source = target.with_suffix(".txt")
    source.write_text(text, encoding="utf-8-sig")
    script = pathlib.Path(__file__).with_name("speak.ps1")
    run = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(script),
         "-InputFile", str(source), "-OutputFile", str(target)],
        capture_output=True, timeout=30, check=False)
    if run.returncode != 0 or not target.exists():
        raise RuntimeError("Japanese speech synthesis failed; install a Japanese desktop voice")
    with wave.open(str(target), "rb") as w:
        return w.getnframes() / w.getframerate()

def discover(request):
    import pychromecast
    name = request["speaker"]
    known = [request["host"]] if request.get("host") else None
    devices, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[name], known_hosts=known, discovery_timeout=8)
    if len(devices) != 1:
        browser.stop_discovery()
        for d in devices:
            with contextlib.suppress(Exception):
                d.disconnect()
        raise RuntimeError("Exactly one matching Google Home is required")
    return devices[0], browser

def run(request):
    cast, browser = discover(request)
    try:
        cast.wait(timeout=12)
        name = cast.name or request["speaker"]
        if request.get("op") == "probe":
            return {"result": "ready", "device": name}
        if request.get("op") != "speak":
            raise RuntimeError("Unknown operation")
        text = str(request.get("text", "")).strip()
        if not text or len(text) > 160:
            raise RuntimeError("Invalid message length")
        # Do not interrupt a different Cast app, music, or a muted speaker.
        mc = cast.media_controller
        if cast.status and (cast.status.volume_muted or
            (not cast.is_idle and cast.app_id != "CC1AD845") or
            (not cast.is_idle and mc.status.player_state not in ("IDLE", "UNKNOWN"))):
            return {"result": "skipped", "device": name}
        original = cast.status.volume_level if cast.status else None
        with tempfile.TemporaryDirectory(prefix="asobu-voice-") as tmp:
            wav = pathlib.Path(tmp) / "notice.wav"
            duration = synthesize(text, wav)
            if duration <= 0 or duration > 35:
                raise RuntimeError("Invalid speech duration")
            token = "/" + uuid.uuid4().hex + ".wav"
            payload = wav.read_bytes()
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def do_HEAD(self):
                    self.serve(False)
                def do_GET(self):
                    self.serve(True)
                def serve(self, body):
                    if self.path != token:
                        self.send_error(404)
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if body:
                        self.wfile.write(payload)
            ip = request.get("lanIp")
            if not ip:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.connect((cast.cast_info.host, 8009))
                    ip = sock.getsockname()[0]
            # Fixed LAN port for a single Windows private-network firewall rule.
            server = http.server.ThreadingHTTPServer((ip, 8765), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            changed = False
            try:
                cast.set_volume(max(.05, min(.8, float(request["volume"]) / 100.0)))
                changed = True
                mc.play_media("http://" + ip + ":8765" + token, "audio/wav")
                mc.block_until_active(timeout=15)
                # Confirm that the Cast receiver actually started this media.
                deadline = time.monotonic() + 12
                started = False
                while time.monotonic() < deadline:
                    if mc.status.player_state in ("PLAYING", "BUFFERING") and mc.status.content_id and token in mc.status.content_id:
                        started = True
                        break
                    time.sleep(.15)
                if not started:
                    raise RuntimeError("Receiver did not start the audio")
                deadline = time.monotonic() + duration + 8
                while time.monotonic() < deadline:
                    if mc.status.player_state == "IDLE":
                        return {"result": "sent", "device": name}
                    time.sleep(.2)
                raise RuntimeError("Receiver did not finish audio")
            finally:
                server.shutdown()
                server.server_close()
                if changed and original is not None:
                    with contextlib.suppress(Exception):
                        cast.set_volume(original)
    finally:
        with contextlib.suppress(Exception):
            cast.disconnect()
        with contextlib.suppress(Exception):
            browser.stop_discovery()

if __name__ == "__main__":
    try:
        result(**run(json.load(sys.stdin)))
    except Exception as exc:
        # Do not print the message text or authentication data.
        result(result="error", error=str(exc)[:180])
        sys.exit(1)
