"""List local Cast devices, without Firebase credentials or playback."""
import contextlib
import pychromecast

devices, browser = pychromecast.get_chromecasts(timeout=10)
try:
    for device in sorted(devices, key=lambda d: (d.cast_info.friendly_name, str(d.cast_info.host))):
        print(f"{device.cast_info.friendly_name}\t{device.cast_info.host}")
    if not devices:
        print("No Cast devices discovered.")
finally:
    for device in devices:
        with contextlib.suppress(Exception):
            device.disconnect()
    browser.stop_discovery()
