import importlib.util
import http.client
import http.server
import threading
import tempfile
import wave
import pathlib
import unittest
from types import SimpleNamespace as NS

spec = importlib.util.spec_from_file_location("cast_local", pathlib.Path(__file__).resolve().parents[1] / "google-home" / "cast.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PlaybackGuardTests(unittest.TestCase):
    def fake(self, app="CC1AD845", idle=False, state="UNKNOWN", muted=False):
        return NS(status=NS(volume_muted=muted, namespaces=[]),
                  media_controller=NS(status=NS(player_state=state)),
                  is_idle=idle, app_id=app)

    def test_default_receiver_waiting_is_not_playback(self):
        self.assertIsNone(module.playback_block_reason(self.fake()))

    def test_idle_other_app_is_allowed(self):
        self.assertIsNone(module.playback_block_reason(self.fake(app="ambient", state="IDLE")))

    def test_automatic_protects_playing_and_unknown_other_app(self):
        for state in ("PLAYING", "BUFFERING", "PAUSED", "LOADING"):
            self.assertEqual(module.playback_block_reason(self.fake(state=state)), "media_busy")
        self.assertEqual(module.playback_block_reason(self.fake(app="unknown")), "other_app")

    def test_confirmed_manual_bypasses_busy_but_respects_mute(self):
        self.assertIsNone(module.playback_block_reason(self.fake(app="unknown", state="PLAYING"), True))
        self.assertEqual(module.playback_block_reason(self.fake(muted=True), True), "muted")

    def test_missing_status_is_safe(self):
        self.assertEqual(module.playback_block_reason(NS(status=None), True), "status_unavailable")

class ReceiverStartTests(unittest.TestCase):
    def test_receiver_is_started_if_other_app_active(self):
        device = NS(app_id="other", status=NS(namespaces=[]))
        calls = []
        def start_app(app, timeout):
            calls.append(app)
            device.app_id = app
            device.status.namespaces = [module.MEDIA_NAMESPACE]
        device.start_app = start_app
        module.wait_receiver(device, timeout=1)
        self.assertEqual(calls, [module.MEDIA_APP])

    def test_ready_receiver_does_not_relaunch(self):
        device = NS(app_id=module.MEDIA_APP, status=NS(namespaces=[module.MEDIA_NAMESPACE]))
        module.wait_receiver(device, timeout=1)

    def test_media_outcome_requires_matching_content(self):
        status = NS(content_id="http://local/old.wav", player_state="IDLE", idle_reason="FINISHED")
        self.assertEqual(module.media_outcome(status, "/new.wav"), "")
        status.content_id = "http://local/new.wav"
        self.assertEqual(module.media_outcome(status, "/new.wav"), "finished")
        status.idle_reason = "ERROR"
        self.assertEqual(module.media_outcome(status, "/new.wav"), "failed")
        status.player_state = "PLAYING"
        self.assertEqual(module.media_outcome(status, "/new.wav"), "playing")
        status.player_state = "BUFFERING"
        self.assertEqual(module.media_outcome(status, "/new.wav"), "")

class AudioHttpTests(unittest.TestCase):
    def setUp(self):
        self.payload = bytes(range(100))
        self.diag = dict(httpGets=0, httpHeads=0, httpRanges=0, httpBytesSent=0, httpErrors=0)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), module.audio_handler("/sample.wav", self.payload, self.diag))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method="GET", path="/sample.wav", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_full_and_range_requests(self):
        status, headers, data = self.request()
        self.assertEqual((status, data), (200, self.payload))
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        status, headers, data = self.request(headers={"Range": "bytes=10-19"})
        self.assertEqual((status, data), (206, self.payload[10:20]))
        self.assertEqual(headers["Content-Range"], "bytes 10-19/100")
        self.assertEqual(self.request(headers={"Range": "bytes=-10"})[2], self.payload[-10:])
        self.assertEqual(self.request(headers={"Range": "bytes=90-"})[2], self.payload[90:])
        self.assertEqual(self.request(headers={"Range": "bytes=100-"})[0], 416)
        self.assertEqual(self.request("HEAD")[2], b"")
        self.assertEqual(self.request(path="/wrong.wav")[0], 404)

class Mp3EncodingTests(unittest.TestCase):
    def test_local_encoding_and_padding(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "source.wav"
            target = pathlib.Path(tmp) / "notice.mp3"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(22050)
                audio.writeframes(bytes(44100))
            duration = module.encode_mp3(source, target, 1.0)
            self.assertGreaterEqual(duration, 5.0)
            self.assertGreater(target.stat().st_size, 1000)
            self.assertNotEqual(target.read_bytes()[:4], b"RIFF")

if __name__ == "__main__":
    unittest.main()
