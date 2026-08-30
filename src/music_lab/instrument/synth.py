from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass

import numpy as np

from .audio_analysis import AudioAnalysisTap
from .timbre_library import Timbre, get_timbre


@dataclass
class Voice:
    channel: int
    midi_note: int
    frequency_hz: float
    velocity: float
    phases: np.ndarray
    age_samples: int = 0
    release_samples_elapsed: int = 0
    release_start_gain: float = 1.0
    release_samples_total: int = 1
    released: bool = False


class PolySynth:
    def __init__(
        self,
        enabled: bool = True,
        sample_rate_hz: int = 48000,
        block_size: int = 960,
    ) -> None:
        self.enabled = enabled
        self.sample_rate_hz = sample_rate_hz
        self.block_size = block_size
        self.timbre = get_timbre("warm")
        self.master_volume = 0.55
        self._voices: dict[int, Voice] = {}
        self._next_voice_id = 1
        self._channel_pitch_bends: dict[int, int] = {}
        self.pitch_bend_range_semitones = 2.0
        self._lock = threading.RLock()
        self._stream = None
        self._stream_context = None
        self._backend: str | None = None
        self._writer_thread: threading.Thread | None = None
        self._writer_stop = threading.Event()
        self._error: str | None = None
        self.attack_samples = round(0.005 * sample_rate_hz)
        self.release_samples = round(0.12 * sample_rate_hz)
        self.output_device_name: str | None = None
        self.output_latency_seconds: float | None = None
        self.analysis_tap = AudioAnalysisTap(sample_rate_hz)
        self._callback_status_count = 0
        self._underrun_count = 0
        self._last_callback_status: str | None = None
        self._polyphony_gain = 1.0
        self._last_callback_monotonic: float | None = None
        self._callback_max_gap_ms = 0.0
        self._late_callback_count = 0
        self._callback_frames: int | None = None
        self._limited_sample_count = 0
        self._peak_before_limiter = 0.0

    @staticmethod
    def _preferred_output_device(sd) -> int | None:  # noqa: ANN001
        """Prefer the default WASAPI output on Windows instead of high-latency MME."""
        for host_api in sd.query_hostapis():
            if "WASAPI" in host_api["name"] and host_api["default_output_device"] >= 0:
                return int(host_api["default_output_device"])
        default_output = sd.default.device[1]
        return int(default_output) if default_output is not None else None

    def start(self) -> None:
        if not self.enabled:
            return
        try:
            self._error = None
            if os.name == "nt":
                import soundcard as sc

                speaker = sc.default_speaker()
                if speaker is None:
                    raise RuntimeError("no default Windows output device")
                self._stream_context = speaker.player(
                    samplerate=self.sample_rate_hz,
                    channels=2,
                    blocksize=self.block_size,
                )
                self._stream = self._stream_context.__enter__()
                self._backend = "wasapi_soundcard"
                self.output_device_name = speaker.name
                self.output_latency_seconds = (
                    float(self._stream.buffersize) / self.sample_rate_hz
                )
            else:
                import sounddevice as sd

                device = self._preferred_output_device(sd)
                self._stream = sd.OutputStream(
                    device=device,
                    samplerate=self.sample_rate_hz,
                    blocksize=self.block_size,
                    channels=2,
                    dtype="float32",
                    latency="low",
                )
                self._stream.start()
                device_info = sd.query_devices(device, "output")
                self._backend = "portaudio_blocking_writer"
                self.output_device_name = str(device_info["name"])
                self.output_latency_seconds = float(self._stream.latency)
            self._last_callback_monotonic = None
            with self._lock:
                self._last_callback_monotonic = None
                self._callback_max_gap_ms = 0.0
                self._late_callback_count = 0
            self._writer_stop.clear()
            self._writer_thread = threading.Thread(
                target=self._writer_loop,
                name="music-lab-audio-writer",
                daemon=True,
            )
            self._writer_thread.start()
        except Exception as error:  # hardware availability is environment-specific
            self._error = str(error)
            self._stop_output_backend()
            self._backend = None

    def stop(self) -> None:
        self._writer_stop.set()
        writer_thread = self._writer_thread
        if writer_thread is not None and writer_thread is not threading.current_thread():
            writer_thread.join(timeout=0.5)
        self._writer_thread = None
        with self._lock:
            self._voices.clear()
            self._channel_pitch_bends.clear()
            self._last_callback_monotonic = None
        self._stop_output_backend()
        self._backend = None

    def _writer_loop(self) -> None:
        stream = self._stream
        if stream is None:
            return
        outdata = np.empty((self.block_size, 2), dtype=np.float32)
        try:
            while not self._writer_stop.is_set():
                self._callback(outdata, self.block_size, None, None)
                if self._write_stream_block(stream, outdata):
                    with self._lock:
                        self._callback_status_count += 1
                        self._underrun_count += 1
                        self._last_callback_status = "blocking write underflow"
        except Exception as error:  # hardware availability is environment-specific
            with self._lock:
                self._error = str(error)

    def _write_stream_block(self, stream, outdata: np.ndarray) -> bool:  # noqa: ANN001
        if self._backend == "wasapi_soundcard":
            stream.play(outdata)
            return False
        return bool(stream.write(outdata))

    def _stop_output_backend(self) -> None:
        stream = self._stream
        stream_context = self._stream_context
        self._stream = None
        self._stream_context = None
        if stream_context is not None:
            stream_context.__exit__(None, None, None)
        elif stream is not None:
            stream.stop()
            stream.close()

    def set_timbre(self, timbre_id: str) -> None:
        with self._lock:
            self.timbre = get_timbre(timbre_id)
            self._voices.clear()
            self._channel_pitch_bends.clear()

    def set_master_volume(self, value: float) -> None:
        if not 0 <= value <= 1:
            raise ValueError("volume must be between 0 and 1")
        with self._lock:
            self.master_volume = value

    def set_custom_timbre(self, partials: list[tuple[float, float]]) -> None:
        if not partials or len(partials) > 32:
            raise ValueError("partial count must be between 1 and 32")
        cleaned = tuple((float(multiple), float(amplitude)) for multiple, amplitude in partials)
        if any(multiple <= 0 or amplitude < 0 for multiple, amplitude in cleaned):
            raise ValueError("partial multiples must be positive and amplitudes non-negative")
        with self._lock:
            self.timbre = Timbre(
                id="custom",
                name="自定义部分音",
                description="由当前部分音编辑器定义。",
                partials=cleaned,
                library_scope="runtime",
            )
            self._voices.clear()
            self._channel_pitch_bends.clear()

    def note_on(self, channel: int, midi_note: int, frequency_hz: float, velocity: int) -> int:
        with self._lock:
            voice_id = self._next_voice_id
            self._next_voice_id += 1
            previous_voices = [
                voice
                for voice in self._voices.values()
                if voice.channel == channel and voice.midi_note == midi_note
            ]
            previous_voice = previous_voices[-1] if previous_voices else None
            for voice in previous_voices:
                if not voice.released:
                    continue
                progress = max(
                    0.0,
                    min(1.0, voice.release_samples_elapsed / voice.release_samples_total),
                )
                release_curve = progress * progress * (3 - 2 * progress)
                voice.release_start_gain *= 1 - release_curve
                voice.release_samples_elapsed = 0
                voice.release_samples_total = self.attack_samples
            self._voices[voice_id] = Voice(
                channel=channel,
                midi_note=midi_note,
                frequency_hz=frequency_hz,
                velocity=max(0.05, min(1.0, velocity / 127)),
                phases=(
                    previous_voice.phases.copy()
                    if previous_voice is not None
                    else np.zeros(len(self.timbre.partials), dtype=np.float64)
                ),
                release_samples_total=self.release_samples,
            )
            return voice_id

    def _attack_gain(self, age_samples: int) -> float:
        progress = max(0.0, min(1.0, age_samples / self.attack_samples))
        return progress * progress * (3 - 2 * progress)

    def note_off(self, voice_id: int) -> None:
        with self._lock:
            voice = self._voices.get(voice_id)
            if voice is not None and not voice.released:
                voice.release_start_gain = self._attack_gain(voice.age_samples)
                voice.released = True
                voice.release_samples_elapsed = 0
                voice.release_samples_total = self.release_samples

    def discard_voice(self, voice_id: int) -> None:
        """Immediately remove a voice when the runtime's safety cap is reached."""
        with self._lock:
            self._voices.pop(voice_id, None)

    def set_pitch_bend(self, channel: int, value: int) -> None:
        """Set a MIDI pitch wheel value (-8192..8191) for one synth channel."""
        with self._lock:
            self._channel_pitch_bends[channel] = max(-8192, min(8191, int(value)))

    def reset_pitch_bend(self, channel: int) -> None:
        with self._lock:
            self._channel_pitch_bends.pop(channel, None)

    def pitch_bend_factor(self, channel: int) -> float:
        with self._lock:
            value = self._channel_pitch_bends.get(channel, 0)
        semitones = self.pitch_bend_range_semitones * value / 8192
        return 2 ** (semitones / 12)

    def all_notes_off(self) -> None:
        with self._lock:
            for voice in self._voices.values():
                voice.released = True
                voice.release_start_gain = self._attack_gain(voice.age_samples)
                voice.release_samples_elapsed = 0
                voice.release_samples_total = self.release_samples

    def notes_off_for_channels(self, channels: set[int]) -> None:
        with self._lock:
            for voice in self._voices.values():
                if voice.channel in channels:
                    voice.released = True
                    voice.release_start_gain = self._attack_gain(voice.age_samples)
                    voice.release_samples_elapsed = 0
                    voice.release_samples_total = self.release_samples
            for channel in channels:
                self._channel_pitch_bends.pop(channel, None)

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "running": (
                self._stream is not None
                and self._writer_thread is not None
                and self._writer_thread.is_alive()
            ),
            "backend": self._backend,
            "error": self._error,
            "sample_rate_hz": self.sample_rate_hz,
            "block_size": self.block_size,
            "callback_frames": self._callback_frames,
            "master_volume": self.master_volume,
            "output_device_name": self.output_device_name,
            "output_latency_ms": (
                self.output_latency_seconds * 1000
                if self.output_latency_seconds is not None
                else None
            ),
            "active_voice_count": len(self._voices),
            "polyphony_gain": self._polyphony_gain,
            "callback_status_count": self._callback_status_count,
            "underrun_count": self._underrun_count,
            "last_callback_status": self._last_callback_status,
            "callback_max_gap_ms": self._callback_max_gap_ms,
            "late_callback_count": self._late_callback_count,
            "limited_sample_count": self._limited_sample_count,
            "peak_before_limiter": self._peak_before_limiter,
            "timbre": self.timbre.summary(),
        }

    def analysis_snapshot(self) -> dict:
        return self.analysis_tap.analysis_snapshot()

    def phase_snapshot(self, frame_count: int = 4096) -> np.ndarray:
        return self.analysis_tap.phase_snapshot(frame_count)

    def start_diagnostic_capture(self, duration_seconds: float) -> int:
        return self.analysis_tap.start_diagnostic_capture(duration_seconds)

    def diagnostic_capture(self) -> tuple[np.ndarray, bool]:
        return self.analysis_tap.diagnostic_capture()

    @property
    def _monitor(self) -> np.ndarray:
        """供旧诊断脚本读取；新代码请通过 AudioAnalysisTap 使用。"""
        return self.analysis_tap.monitor

    @property
    def _monitor_position(self) -> int:
        return self.analysis_tap.monitor_position

    @_monitor_position.setter
    def _monitor_position(self, value: int) -> None:
        self.analysis_tap.monitor_position = int(value) % len(self.analysis_tap.monitor)

    def _callback(self, outdata, frames, time_info, status) -> None:  # noqa: ANN001
        del time_info
        callback_monotonic = time.perf_counter()
        output_left = np.zeros(frames, dtype=np.float64)
        output_right = np.zeros(frames, dtype=np.float64)
        voice_groups: dict[tuple[int, int], np.ndarray] = {}
        sample_indices = np.arange(frames, dtype=np.float64)
        finished: list[int] = []
        with self._lock:
            self._callback_frames = frames
            if self._last_callback_monotonic is not None:
                callback_gap = callback_monotonic - self._last_callback_monotonic
                self._callback_max_gap_ms = max(
                    self._callback_max_gap_ms,
                    callback_gap * 1000,
                )
                expected_gap = frames / self.sample_rate_hz
                buffer_margin = (self.output_latency_seconds or 0.01) * 1.25
                if callback_gap > max(expected_gap * 2.25, buffer_margin):
                    self._late_callback_count += 1
            self._last_callback_monotonic = callback_monotonic
            if status:
                self._callback_status_count += 1
                self._last_callback_status = str(status)
                if bool(getattr(status, "output_underflow", False)):
                    self._underrun_count += 1
            timbre = self.timbre
            nyquist_limit = self.sample_rate_hz * 0.49
            for voice_id, voice in self._voices.items():
                if voice.released:
                    release_progress = np.clip(
                        (voice.release_samples_elapsed + sample_indices)
                        / voice.release_samples_total,
                        0.0,
                        1.0,
                    )
                    release_curve = release_progress**2 * (3 - 2 * release_progress)
                    envelope = voice.release_start_gain * (1 - release_curve)
                    voice.release_samples_elapsed += frames
                    if voice.release_samples_elapsed >= voice.release_samples_total:
                        finished.append(voice_id)
                else:
                    attack_progress = np.clip(
                        (voice.age_samples + sample_indices) / self.attack_samples,
                        0.0,
                        1.0,
                    )
                    envelope = attack_progress**2 * (3 - 2 * attack_progress)
                    voice.age_samples += frames

                voice_signal = np.zeros(frames, dtype=np.float64)
                bend_value = self._channel_pitch_bends.get(voice.channel, 0)
                bend_semitones = self.pitch_bend_range_semitones * bend_value / 8192
                bent_frequency = voice.frequency_hz * 2 ** (bend_semitones / 12)
                audible_amplitudes = 0.0
                for partial_index, (multiple, amplitude) in enumerate(timbre.partials):
                    angular_step = (
                        2 * np.pi * bent_frequency * multiple / self.sample_rate_hz
                    )
                    phases = voice.phases[partial_index] + angular_step * sample_indices
                    if bent_frequency * multiple < nyquist_limit:
                        voice_signal += amplitude * np.sin(phases)
                        audible_amplitudes += amplitude
                    voice.phases[partial_index] = (phases[-1] + angular_step) % (2 * np.pi)
                pan = ((voice.midi_note * 7) % 17) / 16
                left_gain = np.cos(pan * np.pi / 2)
                right_gain = np.sin(pan * np.pi / 2)
                scaled_envelope = voice.velocity * envelope
                scaled = scaled_envelope * voice_signal / max(1.0, audible_amplitudes)
                output_left += scaled * left_gain
                output_right += scaled * right_gain
                group_key = (voice.channel, voice.midi_note)
                if group_key in voice_groups:
                    voice_groups[group_key] += scaled_envelope
                else:
                    voice_groups[group_key] = scaled_envelope.copy()

            for voice_id in finished:
                self._voices.pop(voice_id, None)

        stereo = np.column_stack((output_left, output_right))
        voice_power = sum(
            (group_envelope**2 for group_envelope in voice_groups.values()),
            start=np.zeros(frames, dtype=np.float64),
        )
        polyphony_gain = 1 / np.sqrt(np.maximum(1.0, voice_power))
        stereo *= polyphony_gain[:, np.newaxis]
        stereo *= self.master_volume
        peak_before_limiter = float(np.max(np.abs(stereo))) if stereo.size else 0.0
        limited_samples = int(np.count_nonzero(np.abs(stereo) > 0.98))
        stereo = np.clip(stereo, -0.98, 0.98).astype(np.float32)
        outdata[:] = stereo
        with self._lock:
            self._polyphony_gain = float(np.min(polyphony_gain))
            self._peak_before_limiter = peak_before_limiter
            self._limited_sample_count += limited_samples
        self.analysis_tap.write(stereo)
