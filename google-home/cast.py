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
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", str(script),
         "-InputFile", str(source), "-OutputFile", str(target)],
        capture_output=True, timeout=30, check=False)
    if run.returncode != 0 or not target.exists():
        raise NoticeError("tts_failed")
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
        raise NoticeError("speaker_not_unique")
    return devices[0], browser

class NoticeError(RuntimeError):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason

def playback_block_reason(cast, manual=False):
    """Do not equate an open receiver/ambient app with actual audio playback."""
    status = cast.status
    if status is None:
        return "status_unavailable"
    if status.volume_muted:
        return "muted"
    # A manual command is explicitly confirmed by the parent in the UI.
    # It can interrupt another session, but never unmutes a device.
    if manual:
        return None
    mc = cast.media_controller
    if not cast.is_idle and "urn:x-cast:com.google.cast.media" in (status.namespaces or []):
        received = threading.Event()
        try:
            mc.update_status(callback_function=lambda *args: received.set())
            received.wait(2)
        except Exception:
            pass
    if mc.status.player_state in ("PLAYING", "BUFFERING", "PAUSED", "LOADING"):
        return "media_busy"
    # A non-media app may be a Nest Hub ambient/idle screen. Only protect
    # an unknown receiver for automatic messages if it is not demonstrably idle.
    if not cast.is_idle and cast.app_id not in (None, "CC1AD845", "E8C28D3C"):
        if mc.status.player_state != "IDLE":
            return "other_app"
    return None

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
        mc = cast.media_controller
        reason = playback_block_reason(cast, request.get("manual") is True)
        if reason:
            return {"result": "skipped", "device": name, "reason": reason}
        original = cast.status.volume_level if cast.status else None
        with tempfile.TemporaryDirectory(prefix="asobu-voice-") as tmp:
            wav = pathlib.Path(tmp) / "notice.wav"
            duration = synthesize(text, wav)
            if duration <= 0 or duration > 35:
                raise NoticeError("tts_duration")
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
                    raise NoticeError("receiver_no_start")
                deadline = time.monotonic() + duration + 8
                while time.monotonic() < deadline:
                    if mc.status.player_state == "IDLE":
                        return {"result": "sent", "device": name}
                    time.sleep(.2)
                raise NoticeError("receiver_no_finish")
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
        result(**run(json.loads(sys.stdin.buffer.read().decode("utf-8"))))
    except Exception as exc:
        # Do not print the message text or authentication data.
        result(result="error", reason=getattr(exc, "reason", "cast_error"), error=str(exc)[:180])
        sys.exit(1)
