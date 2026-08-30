from __future__ import annotations

import math

from ..chord_basis import (
    infer_common_fundamental,
    select_composite_basis,
    select_simplest_basis,
)
from ..tuning import format_prime_vector, nearest_harmonic_ratio, ratio_from_prime_vector
from .runtime_proxy import RuntimeServiceProxy


class ChordAnalysisService(RuntimeServiceProxy):
    """Build tuning-relative and chord-relative analysis read models."""

    def _chord_payload(self) -> dict:
        active = sorted(self.active_notes.values(), key=lambda item: item["frequency_hz"])
        reference_midi = (
            self.mapping_anchor if self.mapping_anchor is not None else self.tuning.reference_midi
        )
        reference_pitch = self.tuning.map_relative(reference_midi, 0)
        reference = {
            "midi_note": reference_midi,
            "key_label": reference_pitch.key_label,
            "pitch_label": reference_pitch.pitch_label,
            "traditional_alias": reference_pitch.traditional_alias,
            "frequency_hz": self.tuning.reference_frequency_hz,
        }
        basis = self._resolve_chord_basis(active)
        basis_payload = self._chord_basis_payload(basis)
        if not active:
            return {
                "size": 0,
                "name": "等待和弦输入",
                "basis_mode": self.chord_basis_mode,
                "basis": basis_payload,
                "reference": reference,
                "tones": [],
            }
        tones = []
        for pitch in active:
            tones.append(
                {
                    "midi_note": pitch["midi_note"],
                    "key_label": pitch["key_label"],
                    "pitch_label": pitch["pitch_label"],
                    "traditional_alias": pitch["traditional_alias"],
                    "degree": pitch["degree"],
                    "equave": pitch["equave"],
                    "frequency_hz": pitch["frequency_hz"],
                    "velocity": pitch["velocity"],
                    "source": pitch["source"],
                    "channel": pitch["channel"],
                    "is_basis": bool(basis and basis.get("voice_id") == pitch.get("voice_id")),
                    "tuning_relation": self._tuning_relation_payload(pitch),
                    "chord_relation": (
                        self._chord_relation_payload(
                            pitch,
                            basis,
                        )
                        if basis
                        else None
                    ),
                }
            )
        return {
            "size": len(active),
            "name": self._conventional_chord_name(active),
            "basis_mode": self.chord_basis_mode,
            "basis": basis_payload,
            "reference": reference,
            "tones": tones,
        }

    def _resolve_chord_basis(self, active: list[dict]) -> dict | None:
        if self.chord_basis_mode == "lowest":
            if not active:
                return None
            return dict(active[0]) | {
                "origin": "lowest",
                "sounding": True,
            }
        if self.chord_basis_mode == "selected":
            if self.chord_basis_midi_note is None:
                return None
            sounding = next(
                (pitch for pitch in active if pitch["midi_note"] == self.chord_basis_midi_note),
                None,
            )
            if sounding is not None:
                return dict(sounding) | {
                    "origin": "selected",
                    "sounding": True,
                }
            pitch = self._map_physical_key(self.chord_basis_midi_note) or self.tuning.map_key(
                self.chord_basis_midi_note
            )
            return pitch.to_dict() | {
                "origin": "selected",
                "sounding": False,
            }
        if self.chord_basis_mode in {
            "auto_simple",
            "auto_fundamental",
            "auto_composite",
        }:
            return self._resolve_auto_chord_basis(active)
        ratio = self.chord_virtual_ratio_from_reference
        return {
            "midi_note": None,
            "key_label": None,
            "pitch_label": f"V[T×{ratio:.8g}]",
            "traditional_alias": None,
            "degree": None,
            "equave": None,
            "frequency_hz": self.tuning.reference_frequency_hz * ratio,
            "origin": "virtual",
            "sounding": False,
        }

    def _reset_auto_chord_basis(self) -> None:
        self._auto_basis_current = None
        self._auto_basis_pending = None
        self._auto_basis_pending_since = 0.0
        self._auto_basis_candidate_signature = None
        self._auto_basis_candidate_cache = None

    def _resolve_auto_chord_basis(self, active: list[dict]) -> dict | None:
        signature = (
            self.chord_basis_mode,
            self.tuning.id,
            self.tuning.reference_frequency_hz,
            self.tuning.equave_ratio,
            self.tuning.divisions,
            self.synth.timbre.id,
            tuple(self.synth.timbre.partials),
            tuple((pitch["midi_note"], round(pitch["frequency_hz"], 8)) for pitch in active),
        )
        if signature == self._auto_basis_candidate_signature:
            candidate = self._auto_basis_candidate_cache
        else:
            if self.chord_basis_mode == "auto_simple":
                candidate = select_simplest_basis(active, self.tuning)
            elif self.chord_basis_mode == "auto_fundamental":
                candidate = infer_common_fundamental(
                    active,
                    self.tuning.reference_frequency_hz,
                    self.synth.timbre.partials,
                )
            else:
                candidate = select_composite_basis(
                    active,
                    self.tuning,
                    self.tuning.reference_frequency_hz,
                    self.synth.timbre.partials,
                )
            self._auto_basis_candidate_signature = signature
            self._auto_basis_candidate_cache = candidate
        if candidate is None:
            return self._materialize_auto_basis(self._auto_basis_current, active)
        if self._auto_basis_current is None:
            self._auto_basis_current = candidate
            return candidate
        if candidate.get("_auto_key") == self._auto_basis_current.get("_auto_key"):
            self._auto_basis_current = candidate
            self._auto_basis_pending = None
            return candidate

        now = self._monotonic()
        if self._auto_basis_pending is None or candidate.get(
            "_auto_key"
        ) != self._auto_basis_pending.get("_auto_key"):
            self._auto_basis_pending = candidate
            self._auto_basis_pending_since = now
        else:
            self._auto_basis_pending = candidate
            if now - self._auto_basis_pending_since >= 0.12:
                self._auto_basis_current = candidate
                self._auto_basis_pending = None
                return candidate
        return self._materialize_auto_basis(self._auto_basis_current, active)

    def _materialize_auto_basis(
        self,
        basis: dict | None,
        active: list[dict],
    ) -> dict | None:
        if basis is None:
            return None
        midi_note = basis.get("midi_note")
        if midi_note is not None:
            sounding = next(
                (pitch for pitch in active if pitch["midi_note"] == midi_note),
                None,
            )
            if sounding is not None:
                return dict(sounding) | {
                    "origin": basis["origin"],
                    "sounding": True,
                    "_auto_key": basis.get("_auto_key"),
                    "_relation_frequencies": basis.get("_relation_frequencies"),
                    "_relation_multipliers": basis.get("_relation_multipliers"),
                    "auto": basis.get("auto"),
                }
        return dict(basis) | {"sounding": False}

    def _chord_basis_payload(self, basis: dict | None) -> dict | None:
        if basis is None:
            return None
        payload = {
            "mode": self.chord_basis_mode,
            "origin": basis["origin"],
            "sounding": basis["sounding"],
            "midi_note": basis.get("midi_note"),
            "input_node_id": basis.get("input_node_id"),
            "key_label": basis.get("key_label"),
            "pitch_label": basis["pitch_label"],
            "traditional_alias": basis.get("traditional_alias"),
            "frequency_hz": basis["frequency_hz"],
            "ratio_from_reference": (basis["frequency_hz"] / self.tuning.reference_frequency_hz),
            "identity_relation": self._identity_chord_relation(),
        }
        if basis.get("auto") is not None:
            payload["auto"] = basis["auto"]
        return payload

    def _identity_chord_relation(self) -> dict:
        if self.tuning.algebraic_basis:
            label = f"{self.tuning.algebraic_basis}^(0/{self.tuning.divisions})"
            return {
                "reference": "B",
                "ratio": 1.0,
                "ratio_label": label,
                "relationship_kind": "exact algebraic relation",
                "prime_vector": {},
                "prime_vector_label": label,
            }
        vector = {str(prime): 0 for prime in (2, 3, 5, 7, 11)}
        return {
            "reference": "B",
            "ratio": 1.0,
            "ratio_label": "1/1",
            "relationship_kind": "exact harmonic ratio",
            "prime_vector": vector,
            "prime_vector_label": "1",
        }

    def _tuning_relation_payload(self, pitch: dict) -> dict:
        ratio = pitch["frequency_hz"] / self.tuning.reference_frequency_hz
        is_algebraic = pitch["relationship_kind"] == "exact algebraic relation"
        if is_algebraic:
            vector: dict[str, int] = {}
            ratio_label = pitch["ratio_label"]
            relationship_kind = pitch["relationship_kind"]
        else:
            normalized = ratio
            octaves = 0
            while normalized < 1:
                normalized *= 2
                octaves -= 1
            while normalized >= 2:
                normalized /= 2
                octaves += 1
            _, vector, error = nearest_harmonic_ratio(normalized)
            vector = dict(vector)
            vector["2"] = vector.get("2", 0) + octaves
            approximation = ratio_from_prime_vector(vector)
            relationship_kind = (
                "exact harmonic ratio" if abs(error) < 1e-9 else "nearest 11-limit relation"
            )
            prefix = "" if relationship_kind == "exact harmonic ratio" else "≈ "
            ratio_label = f"{prefix}{approximation.numerator}/{approximation.denominator}"
        return {
            "reference": "T",
            "ratio": ratio,
            "ratio_label": ratio_label,
            "relationship_kind": relationship_kind,
            "prime_vector": vector,
            "prime_vector_label": (
                pitch["prime_vector_label"] if is_algebraic else format_prime_vector(vector)
            ),
        }

    def _chord_relation_payload(
        self,
        pitch: dict,
        basis: dict,
    ) -> dict:
        fundamental_relation = self._fundamental_relation_payload(pitch, basis)
        if fundamental_relation is not None:
            return fundamental_relation
        basis_frequency = basis["frequency_hz"]
        ratio = pitch["frequency_hz"] / basis_frequency
        if self.tuning.algebraic_basis:
            exponent = math.log(ratio, self.tuning.equave_ratio)
            lattice_steps = exponent * self.tuning.divisions
            nearest_step = round(lattice_steps)
            exponent_label = (
                f"{nearest_step}/{self.tuning.divisions}"
                if math.isclose(lattice_steps, nearest_step, abs_tol=1e-9)
                else f"{exponent:.8g}"
            )
            label = f"{self.tuning.algebraic_basis}^({exponent_label})"
            return {
                "reference": "B",
                "ratio": ratio,
                "ratio_label": label,
                "relationship_kind": "exact algebraic relation",
                "prime_vector": {},
                "prime_vector_label": label,
            }

        normalized = ratio
        octaves = 0
        while normalized < 1:
            normalized *= 2
            octaves -= 1
        while normalized >= 2:
            normalized /= 2
            octaves += 1
        _, vector, error = nearest_harmonic_ratio(normalized)
        vector = dict(vector)
        vector["2"] = vector.get("2", 0) + octaves
        approximation = ratio_from_prime_vector(vector)
        relationship_kind = (
            "exact harmonic ratio" if abs(error) < 1e-9 else "nearest 11-limit relation"
        )
        prefix = "" if relationship_kind == "exact harmonic ratio" else "≈ "
        return {
            "reference": "B",
            "ratio": ratio,
            "ratio_label": (f"{prefix}{approximation.numerator}/{approximation.denominator}"),
            "relationship_kind": relationship_kind,
            "prime_vector": vector,
            "prime_vector_label": format_prime_vector(vector),
        }

    def _fundamental_relation_payload(
        self,
        pitch: dict,
        basis: dict,
    ) -> dict | None:
        auto = basis.get("auto")
        frequencies = basis.get("_relation_frequencies")
        multipliers = basis.get("_relation_multipliers")
        if auto is None or not frequencies or not multipliers:
            return None
        relation_index = min(
            range(len(frequencies)),
            key=lambda index: abs(math.log(pitch["frequency_hz"] / frequencies[index])),
        )
        multiplier = multipliers[relation_index]
        ratio = pitch["frequency_hz"] / basis["frequency_hz"]
        exact = math.isclose(ratio, multiplier, rel_tol=1e-9)
        prefix = "" if exact else "≈ "
        if str(auto["model"]).endswith("integer_partials") and float(multiplier).is_integer():
            partial = int(round(multiplier))
            remaining = partial
            vector = {str(prime): 0 for prime in (2, 3, 5, 7, 11)}
            for prime in (2, 3, 5, 7, 11):
                while remaining % prime == 0:
                    remaining //= prime
                    vector[str(prime)] += 1
            if remaining == 1:
                return {
                    "reference": "B",
                    "ratio": ratio,
                    "ratio_label": f"{prefix}{partial}/1",
                    "relationship_kind": (
                        "exact harmonic ratio" if exact else "nearest harmonic-partial relation"
                    ),
                    "prime_vector": vector,
                    "prime_vector_label": format_prime_vector(vector),
                }
        label = f"{prefix}P×{multiplier:.8g}"
        return {
            "reference": "B",
            "ratio": ratio,
            "ratio_label": label,
            "relationship_kind": (
                "exact timbre-partial relation" if exact else "nearest timbre-partial relation"
            ),
            "prime_vector": {},
            "prime_vector_label": label,
        }

    def _conventional_chord_name(self, active: list[dict]) -> str:
        if len(active) == 1:
            pitch_name = active[0]["traditional_alias"] or active[0]["pitch_label"]
            return f"单音 · {pitch_name}"
        if self.tuning.id != "12edo":
            return f"{len(active)} 音频率集合 · {self.tuning.name}"
        root_step = active[0]["equave"] * 12 + active[0]["degree"]
        intervals = tuple(
            sorted({(note["equave"] * 12 + note["degree"] - root_step) % 12 for note in active})
        )
        qualities = {
            (0, 4, 7): "大三和弦",
            (0, 3, 7): "小三和弦",
            (0, 3, 6): "减三和弦",
            (0, 4, 8): "增三和弦",
            (0, 5, 7): "挂四和弦",
            (0, 2, 7): "挂二和弦",
            (0, 4, 7, 10): "属七和弦",
            (0, 4, 7, 11): "大七和弦",
            (0, 3, 7, 10): "小七和弦",
        }
        quality = qualities.get(intervals)
        root_alias = active[0]["traditional_alias"]
        return f"{root_alias} {quality}" if quality else f"{len(active)} 音集合 · 间隔 {intervals}"
