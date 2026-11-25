"""Offline smoke test: synthesize fixed Japanese text and convert it to MP3."""
import pathlib
import tempfile

from cast import synthesize, encode_mp3

with tempfile.TemporaryDirectory(prefix="asobu-tts-test-") as tmp:
    wav = pathlib.Path(tmp) / "test.wav"
    mp3 = pathlib.Path(tmp) / "test.mp3"
    duration = synthesize("音声通知のテストです。", wav)
    if not 0 < duration <= 35:
        raise RuntimeError("Unexpected speech duration")
    total = encode_mp3(wav, mp3, duration)
    if total < 5 or mp3.stat().st_size < 1000:
        raise RuntimeError("MP3 smoke test failed")
    print("Local Japanese WAV/MP3 synthesis OK")
