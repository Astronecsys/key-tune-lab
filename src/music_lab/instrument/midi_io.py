from __future__ import annotations

import threading
from collections.abc import Callable

MidiEventHandler = Callable[[dict], None]
MidiStatusHandler = Callable[[dict], None]


def decode_midi_message(message: list[int] | tuple[int, ...]) -> dict | None:
    if not message:
        return None
    status = message[0]
    message_type = status & 0xF0
    channel = status & 0x0F
    if message_type == 0x90 and len(message) >= 3:
        note, velocity = message[1], message[2]
        if velocity == 0:
            return {"type": "note_off", "channel": channel, "note": note, "velocity": 0}
        return {"type": "note_on", "channel": channel, "note": note, "velocity": velocity}
    if message_type == 0x80 and len(message) >= 3:
        return {
            "type": "note_off",
            "channel": channel,
            "note": message[1],
            "velocity": message[2],
        }
    if message_type == 0xB0 and len(message) >= 3:
        return {
            "type": "control_change",
            "channel": channel,
            "controller": message[1],
            "value": message[2],
        }
    if message_type == 0xE0 and len(message) >= 3:
        value = ((message[2] & 0x7F) << 7) | (message[1] & 0x7F)
        return {
            "type": "pitch_bend",
            "channel": channel,
            "value": value - 8192,
        }
    return None


class MidiInput:
    def __init__(
        self,
        port_hint: str,
        handler: MidiEventHandler,
        *,
        midi_in_factory: Callable[[], object] | None = None,
        poll_interval_seconds: float = 1.0,
        status_handler: MidiStatusHandler | None = None,
    ) -> None:
        self.port_hint = port_hint
        self.handler = handler
        self._midi_in_factory = midi_in_factory
        self._poll_interval_seconds = max(0.01, poll_interval_seconds)
        self._status_handler = status_handler
        self._last_status_signature: tuple | None = None
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._monitor_thread: threading.Thread | None = None
        self._input = None
        self.port_names: list[str] = []
        self.selected_port: str | None = None
        self.error: str | None = None

    def start(self) -> None:
        with self._lock:
            if self._monitor_thread is not None and self._monitor_thread.is_alive():
                return
            self._stop_event.clear()
        self._refresh_connection()
        monitor = threading.Thread(
            target=self._monitor,
            name="music-lab-midi-hotplug",
            daemon=True,
        )
        with self._lock:
            self._monitor_thread = monitor
        monitor.start()

    def stop(self) -> None:
        self._stop_event.set()
        with self._lock:
            monitor = self._monitor_thread
        if monitor is not None and monitor is not threading.current_thread():
            monitor.join(timeout=max(1.0, self._poll_interval_seconds * 2))
        with self._lock:
            self._monitor_thread = None
            self._disconnect_locked()

    def status(self) -> dict:
        with self._lock:
            return {
                "connected": self._input is not None,
                "selected_port": self.selected_port,
                "available_ports": list(self.port_names),
                "error": self.error,
            }

    def _new_input(self):  # noqa: ANN202
        if self._midi_in_factory is not None:
            return self._midi_in_factory()
        import rtmidi

        return rtmidi.MidiIn()

    def _monitor(self) -> None:
        while not self._stop_event.wait(self._poll_interval_seconds):
            self._refresh_connection()

    def _refresh_connection(self) -> None:
        midi_input = None
        try:
            midi_input = self._new_input()
            port_names = list(midi_input.get_ports())
            with self._lock:
                self.port_names = port_names
                if self._input is not None and self.selected_port in port_names:
                    return
                if self._input is not None:
                    self._disconnect_locked()
            matching_index = next(
                (
                    index
                    for index, name in enumerate(port_names)
                    if self.port_hint.lower() in name.lower()
                ),
                None,
            )
            if matching_index is None:
                with self._lock:
                    self.selected_port = None
                    self.error = f"找不到包含 {self.port_hint!r} 的 MIDI 输入端口"
                return
            midi_input.open_port(matching_index)
            midi_input.ignore_types(sysex=False, timing=True, active_sense=True)
            midi_input.set_callback(self._callback)
            with self._lock:
                if self._stop_event.is_set():
                    midi_input.cancel_callback()
                    midi_input.close_port()
                    return
                self._input = midi_input
                self.selected_port = port_names[matching_index]
                self.error = None
        except Exception as error:  # hardware availability is environment-specific
            with self._lock:
                self.error = str(error)
                self._disconnect_locked()
            if midi_input is not None:
                try:
                    midi_input.cancel_callback()
                except Exception:
                    pass
                try:
                    midi_input.close_port()
                except Exception:
                    pass
        finally:
            self._notify_status_change()

    def _disconnect_locked(self) -> None:
        if self._input is not None:
            try:
                self._input.cancel_callback()
            except Exception:
                pass
            try:
                self._input.close_port()
            except Exception:
                pass
            self._input = None
        self.selected_port = None

    def _notify_status_change(self) -> None:
        status = self.status()
        signature = (
            status["connected"],
            status["selected_port"],
            tuple(status["available_ports"]),
            status["error"],
        )
        with self._lock:
            if signature == self._last_status_signature:
                return
            self._last_status_signature = signature
        if self._status_handler is not None:
            try:
                self._status_handler(status)
            except Exception:
                pass

    def _callback(self, event, data=None) -> None:  # noqa: ANN001
        del data
        message, delta_time = event
        decoded = decode_midi_message(message)
        if decoded is not None:
            decoded["delta_time"] = delta_time
            self.handler(decoded)
