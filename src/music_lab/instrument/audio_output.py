from __future__ import annotations

import os
import threading
from collections.abc import Callable

import numpy as np

RenderCallback = Callable[[np.ndarray, int, object, object], None]
UnderflowCallback = Callable[[str], None]


class AudioOutputAdapter:
    """Platform audio device adapter, isolated from voice synthesis and analysis."""

    def __init__(self, *, enabled: bool, sample_rate_hz: int, block_size: int) -> None:
        self.enabled = enabled
        self.sample_rate_hz = sample_rate_hz
        self.block_size = block_size
        self.stream = None
        self.stream_context = None
        self.backend: str | None = None
        self.writer_thread: threading.Thread | None = None
        self.writer_stop = threading.Event()
        self.error: str | None = None
        self.device_name: str | None = None
        self.latency_seconds: float | None = None
        self._render: RenderCallback | None = None
        self._underflow: UnderflowCallback | None = None

    @staticmethod
    def preferred_output_device(sd) -> int | None:  # noqa: ANN001
        for host_api in sd.query_hostapis():
            if "WASAPI" in host_api["name"] and host_api["default_output_device"] >= 0:
                return int(host_api["default_output_device"])
        default_output = sd.default.device[1]
        return int(default_output) if default_output is not None else None

    @property
    def running(self) -> bool:
        return (
            self.stream is not None
            and self.writer_thread is not None
            and self.writer_thread.is_alive()
        )

    def start(
        self,
        render: RenderCallback,
        underflow: UnderflowCallback,
    ) -> None:
        if not self.enabled:
            return
        self._render = render
        self._underflow = underflow
        try:
            self.error = None
            if os.name == "nt":
                import soundcard as sc

                speaker = sc.default_speaker()
                if speaker is None:
                    raise RuntimeError("no default Windows output device")
                self.stream_context = speaker.player(
                    samplerate=self.sample_rate_hz,
                    channels=2,
                    blocksize=self.block_size,
                )
                self.stream = self.stream_context.__enter__()
                self.backend = "wasapi_soundcard"
                self.device_name = speaker.name
                self.latency_seconds = float(self.stream.buffersize) / self.sample_rate_hz
            else:
                import sounddevice as sd

                device = self.preferred_output_device(sd)
                self.stream = sd.OutputStream(
                    device=device,
                    samplerate=self.sample_rate_hz,
                    blocksize=self.block_size,
                    channels=2,
                    dtype="float32",
                    latency="low",
                )
                self.stream.start()
                device_info = sd.query_devices(device, "output")
                self.backend = "portaudio_blocking_writer"
                self.device_name = str(device_info["name"])
                self.latency_seconds = float(self.stream.latency)
            self.writer_stop.clear()
            self.writer_thread = threading.Thread(
                target=self.writer_loop,
                name="music-lab-audio-writer",
                daemon=True,
            )
            self.writer_thread.start()
        except Exception as error:  # hardware availability is environment-specific
            self.error = str(error)
            self.stop_backend()
            self.backend = None

    def stop(self) -> None:
        self.writer_stop.set()
        writer_thread = self.writer_thread
        if writer_thread is not None and writer_thread is not threading.current_thread():
            writer_thread.join(timeout=0.5)
        self.writer_thread = None
        self.stop_backend()
        self.backend = None

    def writer_loop(self) -> None:
        stream = self.stream
        render = self._render
        if stream is None or render is None:
            return
        outdata = np.empty((self.block_size, 2), dtype=np.float32)
        try:
            while not self.writer_stop.is_set():
                render(outdata, self.block_size, None, None)
                if self.write_stream_block(stream, outdata) and self._underflow is not None:
                    self._underflow("blocking write underflow")
        except Exception as error:  # hardware availability is environment-specific
            self.error = str(error)

    def write_stream_block(self, stream, outdata: np.ndarray) -> bool:  # noqa: ANN001
        if self.backend == "wasapi_soundcard":
            stream.play(outdata)
            return False
        return bool(stream.write(outdata))

    def stop_backend(self) -> None:
        stream = self.stream
        stream_context = self.stream_context
        self.stream = None
        self.stream_context = None
        if stream_context is not None:
            stream_context.__exit__(None, None, None)
        elif stream is not None:
            stream.stop()
            stream.close()
