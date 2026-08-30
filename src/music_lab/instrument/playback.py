from __future__ import annotations

import threading
import time
from collections.abc import Callable

PlaybackRunner = Callable[[threading.Event], None]


class PlaybackService:
    """只管理播放会话生命周期；音高编译与发声仍由运行时领域层完成。"""

    def __init__(
        self,
        *,
        lock: threading.RLock,
        publish: Callable[[dict], None],
        force_cleanup: Callable[[str | None], None],
    ) -> None:
        self._lock = lock
        self._publish = publish
        self._force_cleanup = force_cleanup
        self._thread: threading.Thread | None = None
        self._stop_event: threading.Event | None = None
        self._kind: str | None = None
        self._started_monotonic = 0.0

    @property
    def kind(self) -> str | None:
        with self._lock:
            return self._kind

    def start(self, kind: str, runner: PlaybackRunner) -> None:
        self.stop()
        stop_event = threading.Event()
        thread = threading.Thread(
            target=self._run,
            args=(kind, stop_event, runner),
            name=f"key-tune-{kind}-playback",
            daemon=True,
        )
        with self._lock:
            self._kind = kind
            self._started_monotonic = time.monotonic()
            self._stop_event = stop_event
            self._thread = thread
        self._publish({"type": "playback", "kind": kind, "playing": True})
        thread.start()

    def _run(
        self,
        kind: str,
        stop_event: threading.Event,
        runner: PlaybackRunner,
    ) -> None:
        try:
            runner(stop_event)
        finally:
            with self._lock:
                is_current = self._stop_event is stop_event
                if is_current:
                    self._kind = None
                    self._thread = None
                    self._stop_event = None
            if is_current:
                self._publish({"type": "playback", "kind": kind, "playing": False})

    def stop(self) -> None:
        with self._lock:
            thread = self._thread
            stop_event = self._stop_event
            kind = self._kind
        if stop_event is not None:
            stop_event.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=0.5)
        self._force_cleanup(kind)
        with self._lock:
            was_current = self._stop_event is stop_event and stop_event is not None
            if was_current:
                self._kind = None
                self._thread = None
                self._stop_event = None
        if was_current:
            self._publish({"type": "playback", "playing": False})

    def payload(self) -> dict:
        with self._lock:
            kind = self._kind
            started = self._started_monotonic
        return {
            "kind": kind,
            "playing": kind is not None,
            "elapsed_seconds": (
                max(0.0, time.monotonic() - started) if kind is not None else 0.0
            ),
        }
