from __future__ import annotations

import argparse
import threading
import time
import urllib.error
import urllib.request
import webbrowser


def browser_url(host: str, port: int) -> str:
    display_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    if ":" in display_host and not display_host.startswith("["):
        display_host = f"[{display_host}]"
    return f"http://{display_host}:{port}/"


def panel_is_ready(url: str, *, timeout: float = 0.5) -> bool:
    health_url = f"{url.rstrip('/')}/api/state"
    try:
        with urllib.request.urlopen(health_url, timeout=timeout) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def _open_when_ready(url: str) -> None:
    for _ in range(120):
        if panel_is_ready(url):
            webbrowser.open(url)
            return
        time.sleep(0.1)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="music-panel",
        description="Start the KEY//TUNE LAB live web panel.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--midi-port",
        default="Digital Keyboard",
        help="Substring used to choose a MIDI input port.",
    )
    parser.add_argument(
        "--no-audio",
        action="store_true",
        help="Disable synthesis while keeping the panel and MIDI visualization.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open the panel in the default browser after startup.",
    )
    return parser


def main() -> None:
    args = _parser().parse_args()
    url = browser_url(args.host, args.port)
    if panel_is_ready(url):
        print(f"KEY//TUNE LAB is already running: {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return
    if not args.no_browser:
        threading.Thread(
            target=_open_when_ready,
            args=(url,),
            name="music-panel-browser",
            daemon=True,
        ).start()
    print(f"KEY//TUNE LAB: {url}")
    print("Press Ctrl+C to stop the panel.")

    from .instrument.app import run_instrument_app

    run_instrument_app(
        host=args.host,
        port=args.port,
        midi_port_hint=args.midi_port,
        audio_enabled=not args.no_audio,
    )


if __name__ == "__main__":
    main()
