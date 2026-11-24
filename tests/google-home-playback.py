import importlib.util
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

if __name__ == "__main__":
    unittest.main()
