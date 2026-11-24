"""Single local Cast operation; messages never leave the LAN for speech synthesis."""
import contextlib
import http.server
import json
import os
import pathlib
import re
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

MEDIA_APP = "CC1AD845"
MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media"

def wait_receiver(cast, timeout=18):
    # Force the default media receiver only after the playback guard permits it.
    if cast.app_id != MEDIA_APP:
        cast.start_app(MEDIA_APP, timeout=timeout)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cast.app_id == MEDIA_APP and cast.status and MEDIA_NAMESPACE in (cast.status.namespaces or []):
            return
        time.sleep(.1)
    raise NoticeError("receiver_no_start")

def media_outcome(status, token):
    if not status or token not in (status.content_id or ""):
        return ""
    if status.player_state == "IDLE":
        if status.idle_reason == "FINISHED":
            return "finished"
        if status.idle_reason in ("ERROR", "CANCELLED", "INTERRUPTED"):
            return "failed"
    if status.player_state == "PLAYING":
        return "playing"
    return ""

def byte_range(header, length):
    """Return an inclusive single-byte range, or None for an invalid range."""
    if not header:
        return 0, length - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not match or length <= 0:
        return None
    first, last = match.groups()
    if not first:
        if not last or int(last) <= 0:
            return None
        return max(0, length - int(last)), length - 1
    start = int(first)
    end = min(int(last), length - 1) if last else length - 1
    return (start, end) if start < length and end >= start else None

def audio_handler(token, payload, diagnostics):
    lock = threading.Lock()
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args):
            pass
        def do_HEAD(self):
            self.serve(False)
        def do_GET(self):
            self.serve(True)
        def do_OPTIONS(self):
            if self.path != token:
                self.send_error(404)
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Range")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        def serve(self, body):
            self.close_connection = True
            if self.path != token:
                self.send_error(404)
                return
            header = self.headers.get("Range")
            with lock:
                diagnostics["httpGets" if body else "httpHeads"] += 1
                if header:
                    diagnostics["httpRanges"] += 1
            selected = byte_range(header, len(payload))
            if selected is None:
                with lock:
                    diagnostics["httpErrors"] += 1
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(payload)}")
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                return
            start, end = selected
            data = payload[start:end + 1]
            try:
                self.send_response(206 if header else 200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
                if header:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                if body:
                    self.wfile.write(data)
                    self.wfile.flush()
                    with lock:
                        diagnostics["httpBytesSent"] += len(data)
            except OSError:
                with lock:
                    diagnostics["httpErrors"] += 1
    return Handler

def run(request, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else {}
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
        diagnostics["initialApp"] = "default" if cast.app_id == MEDIA_APP else "idle" if cast.is_idle else "other"
        original = cast.status.volume_level if cast.status else None
        with tempfile.TemporaryDirectory(prefix="asobu-voice-") as tmp:
            wav = pathlib.Path(tmp) / "notice.wav"
            duration = synthesize(text, wav)
            if duration <= 0 or duration > 35:
                raise NoticeError("tts_duration")
            token = "/" + uuid.uuid4().hex + ".wav"
            payload = wav.read_bytes()
            diagnostics.update(httpGets=0, httpHeads=0, httpRanges=0, httpBytesSent=0,
                               httpErrors=0, audioBytes=len(payload), audioSeconds=round(duration, 1))
            Handler = audio_handler(token, payload, diagnostics)
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
                wait_receiver(cast)
                diagnostics["receiverReady"] = True
                cast.set_volume(max(.05, min(.8, float(request["volume"]) / 100.0)))
                changed = True
                # Observe status transitions even for clips shorter than the polling interval.
                started = threading.Event()
                finished = threading.Event()
                failed = threading.Event()
                class Listener:
                    def new_media_status(self, status):
                        matching = token in (status.content_id or "")
                        event = {"state": status.player_state or "UNKNOWN", "idleReason": status.idle_reason or "", "matching": matching}
                        events = diagnostics.setdefault("mediaEvents", [])
                        if len(events) < 20 and (not events or events[-1] != event):
                            events.append(event)
                        outcome = media_outcome(status, token)
                        if outcome == "playing":
                            started.set()
                        elif outcome == "finished":
                            finished.set()
                        elif outcome == "failed":
                            failed.set()
                    def load_media_failed(self, item, code):
                        diagnostics["loadFailed"] = int(code)
                        failed.set()
                listener = Listener()
                mc.register_status_listener(listener)
                def acknowledged(ok, response):
                    diagnostics["loadAcknowledged"] = bool(ok)
                    if not ok:
                        failed.set()
                try:
                    # A WAV notification is finite media, not a live stream.
                    mc.play_media("http://" + ip + ":8765" + token, "audio/wav",
                                  stream_type="BUFFERED", media_info={"duration": duration},
                                  callback_function=acknowledged)
                    deadline = time.monotonic() + 28
                    next_poll = 0
                    while time.monotonic() < deadline:
                        listener.new_media_status(mc.status)
                        if finished.is_set():
                            return {"result": "sent", "device": name}
                        if failed.is_set():
                            raise NoticeError("receiver_no_start")
                        if started.is_set():
                            break
                        if time.monotonic() >= next_poll:
                            with contextlib.suppress(Exception):
                                mc.update_status()
                            next_poll = time.monotonic() + 3
                        time.sleep(.15)
                    if not started.is_set():
                        raise NoticeError("receiver_no_start")
                    diagnostics["playbackStarted"] = True
                    deadline = time.monotonic() + duration + 12
                    while time.monotonic() < deadline:
                        listener.new_media_status(mc.status)
                        if finished.is_set():
                            return {"result": "sent", "device": name}
                        if failed.is_set():
                            raise NoticeError("receiver_no_finish")
                        # Some receivers clear content_id on completion. Only
                        # accept this after matching playback actually started.
                        if mc.status.player_state == "IDLE" and mc.status.idle_reason == "FINISHED":
                            return {"result": "sent", "device": name}
                        time.sleep(.15)
                    raise NoticeError("receiver_no_finish")
                finally:
                    # disconnect() below releases media listeners.
                    diagnostics["finalState"] = mc.status.player_state or "UNKNOWN"
                    diagnostics["idleReason"] = mc.status.idle_reason or ""
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
    diagnostics = {}
    try:
        outcome = run(json.loads(sys.stdin.buffer.read().decode("utf-8")), diagnostics)
        result(**outcome, diagnostics=diagnostics)
    except Exception as exc:
        # Do not print the message text or authentication data.
        result(result="error", reason=getattr(exc, "reason", "cast_error"), error=str(exc)[:180], diagnostics=diagnostics)
        sys.exit(1)
