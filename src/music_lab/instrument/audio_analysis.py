from __future__ import annotations

import threading
import time

import numpy as np

from .contracts import INSTRUMENT_SCHEMA_VERSION


class AudioAnalysisTap:
    """只观察最终立体声输出，不参与发声，因此分析负载不会改变音符状态。"""

    def __init__(
        self,
        sample_rate_hz: int,
        *,
        monitor_frames: int = 16384,
        cache_seconds: float = 1 / 15,
    ) -> None:
        self.sample_rate_hz = sample_rate_hz
        self._lock = threading.RLock()
        self.monitor = np.zeros((monitor_frames, 2), dtype=np.float32)
        self.monitor_position = 0
        self._analysis_window = np.hanning(monitor_frames)
        self._analysis_frequencies = np.fft.rfftfreq(
            monitor_frames,
            1 / sample_rate_hz,
        )
        self._analysis_low_indices = np.flatnonzero(
            (self._analysis_frequencies >= 20)
            & (self._analysis_frequencies <= 1200)
        )
        high_edges = np.geomspace(1200, 12000, 129)
        high_bin_edges = np.searchsorted(self._analysis_frequencies, high_edges)
        self._analysis_high_ranges = tuple(
            (int(lower), int(upper))
            for lower, upper in zip(high_bin_edges[:-1], high_bin_edges[1:])
            if upper > lower
        )
        self._diagnostic_buffer: np.ndarray | None = None
        self._diagnostic_position = 0
        self._cache_seconds = cache_seconds
        self._cached_analysis: dict | None = None
        self._cached_at = 0.0

    def write(self, stereo: np.ndarray) -> None:
        frames = len(stereo)
        with self._lock:
            if (
                self._diagnostic_buffer is not None
                and self._diagnostic_position < len(self._diagnostic_buffer)
            ):
                count = min(
                    frames,
                    len(self._diagnostic_buffer) - self._diagnostic_position,
                )
                self._diagnostic_buffer[
                    self._diagnostic_position:self._diagnostic_position + count
                ] = stereo[:count]
                self._diagnostic_position += count

            first = min(frames, len(self.monitor) - self.monitor_position)
            self.monitor[self.monitor_position:self.monitor_position + first] = stereo[:first]
            remaining = frames - first
            if remaining:
                self.monitor[:remaining] = stereo[first:]
            self.monitor_position = (self.monitor_position + frames) % len(self.monitor)

    def _ordered_samples(self) -> np.ndarray:
        with self._lock:
            position = self.monitor_position
            return np.concatenate(
                (self.monitor[position:], self.monitor[:position]), axis=0
            ).astype(np.float64, copy=True)

    def analysis_snapshot(self) -> dict:
        now = time.monotonic()
        with self._lock:
            if (
                self._cached_analysis is not None
                and now - self._cached_at < self._cache_seconds
            ):
                return self._cached_analysis

        samples = self._ordered_samples()
        mono = samples.mean(axis=1)
        rms = float(np.sqrt(np.mean(mono**2)))
        peak = float(np.max(np.abs(samples)))
        magnitudes = np.abs(np.fft.rfft(mono * self._analysis_window))
        selected_frequencies = list(
            self._analysis_frequencies[self._analysis_low_indices]
        )
        selected_magnitudes = list(magnitudes[self._analysis_low_indices])
        for lower_index, upper_index in self._analysis_high_ranges:
            band_magnitudes = magnitudes[lower_index:upper_index]
            peak_index = lower_index + int(np.argmax(band_magnitudes))
            selected_frequencies.append(float(self._analysis_frequencies[peak_index]))
            selected_magnitudes.append(float(magnitudes[peak_index]))
        frequencies = np.asarray(selected_frequencies)
        levels = np.asarray(selected_magnitudes)
        magnitude_max = float(levels.max()) if levels.size else 1.0
        payload = {
            "schema_version": INSTRUMENT_SCHEMA_VERSION,
            "rms": rms,
            "peak": peak,
            "spectrum": [
                {
                    "frequency_hz": float(frequency),
                    "level": float(magnitude / (magnitude_max or 1.0)),
                }
                for frequency, magnitude in zip(frequencies, levels)
            ],
        }
        with self._lock:
            self._cached_analysis = payload
            self._cached_at = now
        return payload

    def phase_snapshot(self, frame_count: int = 4096) -> np.ndarray:
        count = max(2, min(int(frame_count), len(self.monitor)))
        with self._lock:
            end = self.monitor_position
            start = (end - count) % len(self.monitor)
            if start < end:
                stereo = self.monitor[start:end].copy()
            else:
                stereo = np.concatenate(
                    (self.monitor[start:], self.monitor[:end]),
                    axis=0,
                )
        return stereo.mean(axis=1, dtype=np.float32).astype(np.float32, copy=False)

    def start_diagnostic_capture(self, duration_seconds: float) -> int:
        if not 0.1 <= duration_seconds <= 15:
            raise ValueError("capture duration must be between 0.1 and 15 seconds")
        frame_count = round(duration_seconds * self.sample_rate_hz)
        with self._lock:
            self._diagnostic_buffer = np.zeros((frame_count, 2), dtype=np.float32)
            self._diagnostic_position = 0
        return frame_count

    def diagnostic_capture(self) -> tuple[np.ndarray, bool]:
        with self._lock:
            if self._diagnostic_buffer is None:
                return np.empty((0, 2), dtype=np.float32), False
            captured = self._diagnostic_buffer[:self._diagnostic_position].copy()
            complete = self._diagnostic_position >= len(self._diagnostic_buffer)
        return captured, complete
