from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from io import BytesIO


@dataclass(frozen=True)
class ScoreNote:
    midi_note: int
    start_seconds: float
    duration_seconds: float
    velocity: int
    channel: int = 0
    start_ticks: int | None = None
    duration_ticks: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class PitchBendEvent:
    time_seconds: float
    channel: int
    value: int
    time_ticks: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class TempoEvent:
    time_ticks: int
    time_seconds: float
    microseconds_per_beat: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class TimeSignatureEvent:
    time_ticks: int
    time_seconds: float
    numerator: int
    denominator: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class MidiSequence:
    notes: tuple[ScoreNote, ...]
    pitch_bends: tuple[PitchBendEvent, ...]
    ticks_per_beat: int = 480
    tempo_events: tuple[TempoEvent, ...] = ()
    time_signatures: tuple[TimeSignatureEvent, ...] = ()
    repairs: tuple[str, ...] = ()

    def timing_dict(self) -> dict:
        return {
            "clock": "midi_ticks",
            "ticks_per_beat": self.ticks_per_beat,
            "tempo_events": [event.to_dict() for event in self.tempo_events],
            "time_signatures": [
                event.to_dict() for event in self.time_signatures
            ],
            "repairs": list(self.repairs),
        }


def demo_score() -> list[ScoreNote]:
    notes = (60, 62, 64, 65, 67, 69, 71, 72)
    return [
        ScoreNote(
            midi_note=note,
            start_seconds=index * 0.55,
            duration_seconds=0.46,
            velocity=88,
        )
        for index, note in enumerate(notes)
    ]


def parse_midi_sequence(payload: bytes) -> MidiSequence:
    import mido

    midi_file = mido.MidiFile(file=BytesIO(payload))
    tempo = 500_000
    current_seconds = 0.0
    current_ticks = 0
    active: dict[tuple[int, int], deque[tuple[float, int, int]]] = defaultdict(deque)
    sustained: dict[int, list[tuple[int, float, int, int]]] = defaultdict(list)
    sustain_down: dict[int, bool] = defaultdict(bool)
    notes: list[ScoreNote] = []
    pitch_bends: list[PitchBendEvent] = []
    tempo_events: list[TempoEvent] = [
        TempoEvent(0, 0.0, tempo)
    ]
    time_signatures: list[TimeSignatureEvent] = []
    sustain_event_counts: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for track in midi_file.tracks:
        for message in track:
            if message.type != "control_change" or message.control != 64:
                continue
            bucket = sustain_event_counts[message.channel]
            bucket[0 if message.value >= 64 else 1] += 1
    # A few exporters write repeated pedal-down events but omit almost every
    # pedal-up event. The missing release times cannot be reconstructed safely;
    # honoring that stream would turn short notes into minutes-long notes.
    malformed_sustain_channels = {
        channel
        for channel, (down_count, up_count) in sustain_event_counts.items()
        if down_count >= 4 and down_count > up_count * 2 + 2
    }

    def finish_note(
        midi_note: int,
        channel: int,
        start_seconds: float,
        start_ticks: int,
        velocity: int,
        end_seconds: float,
        end_ticks: int,
    ) -> None:
        notes.append(
            ScoreNote(
                midi_note=midi_note,
                start_seconds=start_seconds,
                duration_seconds=max(0.02, end_seconds - start_seconds),
                velocity=velocity,
                channel=channel,
                start_ticks=start_ticks,
                duration_ticks=max(0, end_ticks - start_ticks),
            )
        )

    def release_sustained(channel: int, end_seconds: float, end_ticks: int) -> None:
        for midi_note, start_seconds, start_ticks, velocity in sustained.pop(channel, []):
            finish_note(
                midi_note,
                channel,
                start_seconds,
                start_ticks,
                velocity,
                end_seconds,
                end_ticks,
            )

    for message in mido.merge_tracks(midi_file.tracks):
        current_ticks += message.time
        current_seconds += mido.tick2second(
            message.time,
            midi_file.ticks_per_beat,
            tempo,
        )
        if message.type == "set_tempo":
            tempo = message.tempo
            event = TempoEvent(current_ticks, current_seconds, tempo)
            if tempo_events[-1].time_ticks == current_ticks:
                tempo_events[-1] = event
            else:
                tempo_events.append(event)
            continue
        if message.type == "time_signature":
            time_signatures.append(
                TimeSignatureEvent(
                    time_ticks=current_ticks,
                    time_seconds=current_seconds,
                    numerator=message.numerator,
                    denominator=message.denominator,
                )
            )
            continue
        if message.type == "pitchwheel":
            pitch_bends.append(
                PitchBendEvent(
                    time_seconds=current_seconds,
                    channel=message.channel,
                    value=message.pitch,
                    time_ticks=current_ticks,
                )
            )
            continue
        if message.type == "control_change":
            channel = message.channel
            if message.control == 64:
                if channel in malformed_sustain_channels:
                    sustain_down[channel] = False
                    release_sustained(channel, current_seconds, current_ticks)
                    continue
                was_down = sustain_down[channel]
                is_down = message.value >= 64
                if was_down and not is_down:
                    release_sustained(channel, current_seconds, current_ticks)
                sustain_down[channel] = is_down
                continue
            if message.control == 121:
                # Reset All Controllers includes resetting the hold pedal. Many
                # exported MIDI files use this instead of a final CC64=0.
                sustain_down[channel] = False
                release_sustained(channel, current_seconds, current_ticks)
                continue
            if message.control == 120:
                # All Sound Off is immediate even if the pedal remains down.
                release_sustained(channel, current_seconds, current_ticks)
                for (active_channel, midi_note), queue in list(active.items()):
                    if active_channel != channel:
                        continue
                    for start_seconds, start_ticks, velocity in queue:
                        finish_note(
                            midi_note,
                            channel,
                            start_seconds,
                            start_ticks,
                            velocity,
                            current_seconds,
                            current_ticks,
                        )
                    active.pop((active_channel, midi_note), None)
                continue
        if message.type == "note_on" and message.velocity > 0:
            active[(message.channel, message.note)].append(
                (current_seconds, current_ticks, message.velocity)
            )
            continue
        if message.type in {"note_off", "note_on"}:
            key = (message.channel, message.note)
            queue = active.get(key)
            if queue:
                started = queue.popleft()
                if not queue:
                    active.pop(key, None)
                start_seconds, start_ticks, velocity = started
                if sustain_down[message.channel]:
                    sustained[message.channel].append(
                        (message.note, start_seconds, start_ticks, velocity)
                    )
                else:
                    finish_note(
                        message.note,
                        message.channel,
                        start_seconds,
                        start_ticks,
                        velocity,
                        current_seconds,
                        current_ticks,
                    )

    for (channel, midi_note), queue in active.items():
        for start_seconds, start_ticks, velocity in queue:
            finish_note(
                midi_note,
                channel,
                start_seconds,
                start_ticks,
                velocity,
                current_seconds,
                current_ticks,
            )
    for channel, pending in sustained.items():
        for midi_note, start_seconds, start_ticks, velocity in pending:
            finish_note(
                midi_note,
                channel,
                start_seconds,
                start_ticks,
                velocity,
                current_seconds,
                current_ticks,
            )

    notes.sort(key=lambda note: (note.start_seconds, note.channel, note.midi_note))
    pitch_bends.sort(key=lambda event: (event.time_seconds, event.channel))
    return MidiSequence(
        notes=tuple(notes),
        pitch_bends=tuple(pitch_bends),
        ticks_per_beat=midi_file.ticks_per_beat,
        tempo_events=tuple(tempo_events),
        time_signatures=tuple(time_signatures),
        repairs=tuple(
            f"ignored_malformed_sustain:channel_{channel}"
            for channel in sorted(malformed_sustain_channels)
        ),
    )


def parse_midi_bytes(payload: bytes) -> list[ScoreNote]:
    return list(parse_midi_sequence(payload).notes)
