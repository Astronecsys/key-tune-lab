from __future__ import annotations

import math
from copy import deepcopy
from dataclasses import replace

from ..input_surface import get_input_surface, piano_surface
from ..mapping import MappingDefinition, nearest_subset, validate_mapping
from ..tuning import Tuning, get_tuning
from ..tuning_library import (
    draft_definition,
    reload_tuning_library,
    save_user_tuning_definition,
    tuning_from_definition,
)
from .runtime_proxy import RuntimeServiceProxy


class ConfigurationService(RuntimeServiceProxy):
    """Apply tuning, timbre, surface, mapping, volume and chord-B commands."""

    def set_tuning(self, tuning_id: str) -> None:
        tuning = get_tuning(tuning_id)
        mapping = self._adapt_mapping_to_tuning(
            tuning,
            self.mapping_definition,
        )
        tuning = self._realize_tuning_reference(tuning, mapping)
        with self._lock:
            self.synth.all_notes_off()
            self.active_notes.clear()
            self._active_note_queues.clear()
            self._open_performance_notes.clear()
            self.tuning = tuning
            self.mapping_definition = mapping
            self._sync_legacy_mapping_fields()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "tuning"})

    def _adapt_mapping_to_tuning(
        self,
        tuning: Tuning,
        mapping: MappingDefinition,
    ) -> MappingDefinition:
        """Keep an input mapping valid when its independent pitch space changes."""
        reference_degree = max(
            0,
            min(mapping.reference_degree, tuning.divisions - 1),
        )
        mapping = replace(mapping, reference_degree=reference_degree)
        if mapping.mode == "periodic_subset":
            if tuning.divisions >= 12:
                mapping = replace(
                    mapping,
                    subset_degrees=nearest_subset(tuning.divisions, 12),
                )
            else:
                mapping = replace(
                    mapping,
                    mode="continuous",
                    subset_degrees=(),
                )
        if (
            self.input_surface.kind == "hex"
            and tuning.space.construction["kind"] == "generator_lattice"
        ):
            mapping = replace(mapping, mode="harmonic_lattice")
        validate_mapping(mapping, self.input_surface, tuning)
        return mapping

    def _realize_tuning_reference(
        self,
        tuning: Tuning,
        mapping: MappingDefinition,
    ) -> Tuning:
        anchor = self.input_surface.node(mapping.anchor_node_id)
        assert anchor is not None
        return tuning.with_reference(
            frequency_hz=mapping.reference_frequency_hz,
            midi_note=(anchor.midi_note if anchor.midi_note is not None else tuning.reference_midi),
            degree=mapping.reference_degree,
        )

    def set_timbre(self, timbre_id: str) -> None:
        with self._lock:
            self.synth.set_timbre(timbre_id)
            self.active_notes.clear()
            self._active_note_queues.clear()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "timbre"})

    def set_custom_timbre(self, partials: list[tuple[float, float]]) -> None:
        with self._lock:
            self.synth.set_custom_timbre(partials)
            self.active_notes.clear()
            self._active_note_queues.clear()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "timbre"})

    def set_custom_tuning(
        self,
        divisions: int,
        equave_ratio: float,
        reference_midi: int,
        reference_frequency_hz: float,
    ) -> None:
        if not 1 <= divisions <= 128:
            raise ValueError("divisions must be between 1 and 128")
        if not 1.01 <= equave_ratio <= 8:
            raise ValueError("equave ratio must be between 1.01 and 8")
        if not 0 <= reference_midi <= 127 or reference_frequency_hz <= 0:
            raise ValueError("invalid reference key or frequency")
        self.set_custom_tuning_space(
            {
                "kind": "equal_division",
                "divisions": divisions,
                "equave_expression": f"{equave_ratio:g}",
                "reference_frequency_hz": reference_frequency_hz,
                "reference_midi": reference_midi,
            }
        )

    def set_custom_tuning_space(self, payload: dict) -> None:
        current_anchor = self.input_surface.node(self.mapping_definition.anchor_node_id)
        definition = draft_definition(
            payload,
            default_frequency_hz=self.mapping_definition.reference_frequency_hz,
            default_midi_note=(
                current_anchor.midi_note
                if current_anchor is not None and current_anchor.midi_note is not None
                else self.tuning.reference_midi
            ),
            default_reference_degree=self.mapping_definition.reference_degree,
        )
        tuning = tuning_from_definition(definition)
        space = tuning.space
        assert space is not None
        reference_frequency_hz = tuning.reference_frequency_hz
        reference_degree = tuning.reference_degree
        requested_reference_midi = tuning.reference_midi
        requested_anchor = (
            self.input_surface.node_for_midi(int(requested_reference_midi))
            if requested_reference_midi is not None
            else None
        )
        mapping = replace(
            self.mapping_definition,
            reference_frequency_hz=reference_frequency_hz,
            reference_degree=reference_degree,
            anchor_node_id=(
                requested_anchor.id
                if requested_anchor is not None
                else self.mapping_definition.anchor_node_id
            ),
        )
        mapping = self._adapt_mapping_to_tuning(tuning, mapping)
        tuning = self._realize_tuning_reference(tuning, mapping)
        with self._lock:
            self.synth.all_notes_off()
            self.active_notes.clear()
            self._active_note_queues.clear()
            self.tuning = tuning
            self.mapping_definition = mapping
            self._sync_legacy_mapping_fields()
            self._open_performance_notes.clear()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "tuning"})

    def save_current_tuning(self, payload: dict) -> Tuning:
        if self.tuning.definition is None:
            raise ValueError("the current tuning has no reusable definition")
        tuning_id = str(payload.get("id", "")).strip()
        name = str(payload.get("name", "")).strip()
        if not tuning_id or not name:
            raise ValueError("tuning id and name are required")
        anchor = self.input_surface.node(self.mapping_definition.anchor_node_id)
        definition = deepcopy(self.tuning.definition)
        definition.update(
            {
                "id": tuning_id,
                "name": name,
                "description": str(payload.get("description", self.tuning.description)).strip(),
                "reference": {
                    "midi_note": (
                        anchor.midi_note
                        if anchor is not None and anchor.midi_note is not None
                        else self.tuning.reference_midi
                    ),
                    "frequency_hz": self.mapping_definition.reference_frequency_hz,
                    "degree": self.mapping_definition.reference_degree,
                },
            }
        )
        tags = [tag for tag in definition.get("tags", []) if tag not in {"builtin", "user-draft"}]
        if "user" not in tags:
            tags.append("user")
        definition["tags"] = tags
        saved = save_user_tuning_definition(
            definition,
            overwrite=bool(payload.get("overwrite", False)),
        )
        self.set_tuning(saved.id)
        return saved

    def reload_tuning_presets(self) -> None:
        reload_tuning_library()
        self._publish({"type": "configuration", "field": "tuning_library"})

    def set_mapping(self, payload: dict) -> None:
        surface = self.input_surface
        if payload.get("surface_id"):
            surface = get_input_surface(str(payload["surface_id"]))
        elif "low" in payload or "high" in payload:
            low = int(payload.get("low", self.keyboard_low))
            high = int(payload.get("high", self.keyboard_high))
            surface = piano_surface(
                id="piano_custom",
                name=f"自定义 {high - low + 1} 键",
                low_midi=low,
                key_count=high - low + 1,
            )

        mode = str(payload.get("mode", self.mapping_definition.mode))
        anchor_node_id = payload.get("anchor_node_id")
        if not anchor_node_id:
            anchor_value = payload.get("anchor")
            if anchor_value not in {None, ""}:
                anchor_node = surface.node_for_midi(int(anchor_value))
                if anchor_node is None:
                    raise ValueError("T anchor key is outside the selected surface")
                anchor_node_id = anchor_node.id
            elif surface.id != self.input_surface.id:
                previous_anchor = self.input_surface.node(self.mapping_definition.anchor_node_id)
                carried_anchor = (
                    surface.node_for_midi(previous_anchor.midi_note)
                    if previous_anchor is not None and previous_anchor.midi_note is not None
                    else None
                )
                anchor_node_id = (
                    carried_anchor.id if carried_anchor is not None else surface.default_anchor_id
                )
            else:
                anchor_node_id = self.mapping_definition.anchor_node_id
        subset_value = payload.get("subset_degrees", self.mapping_definition.subset_degrees)
        if isinstance(subset_value, str):
            subset = tuple(int(value.strip()) for value in subset_value.split(",") if value.strip())
        else:
            subset = tuple(int(value) for value in subset_value)
        if mode == "periodic_subset" and not subset:
            subset = nearest_subset(self.tuning.divisions, min(12, self.tuning.divisions))
        mapping = MappingDefinition(
            surface_id=surface.id,
            mode=mode,
            anchor_node_id=str(anchor_node_id),
            reference_frequency_hz=float(
                payload.get(
                    "reference_frequency_hz",
                    self.mapping_definition.reference_frequency_hz,
                )
            ),
            reference_degree=int(
                payload.get(
                    "reference_degree",
                    self.mapping_definition.reference_degree,
                )
            ),
            degree_step=int(payload.get("degree_step", self.mapping_definition.degree_step)),
            subset_degrees=subset,
            q_step=int(payload.get("q_step", self.mapping_definition.q_step)),
            r_step=int(payload.get("r_step", self.mapping_definition.r_step)),
            q_ratio_expression=str(
                payload.get(
                    "q_ratio_expression",
                    self.mapping_definition.q_ratio_expression,
                )
            ),
            r_ratio_expression=str(
                payload.get(
                    "r_ratio_expression",
                    self.mapping_definition.r_ratio_expression,
                )
            ),
        )
        validate_mapping(mapping, surface, self.tuning)
        anchor_node = surface.node(mapping.anchor_node_id)
        assert anchor_node is not None
        tuning = self.tuning.with_reference(
            frequency_hz=mapping.reference_frequency_hz,
            midi_note=(
                anchor_node.midi_note
                if anchor_node.midi_note is not None
                else self.tuning.reference_midi
            ),
            degree=mapping.reference_degree,
        )
        with self._lock:
            self.synth.all_notes_off()
            self.active_notes.clear()
            self._active_note_queues.clear()
            self.input_surface = surface
            self.mapping_definition = mapping
            self.tuning = tuning
            self._sync_legacy_mapping_fields()
        self._publish({"type": "configuration", "field": "mapping"})

    def set_input_surface(self, surface_id: str) -> None:
        surface = get_input_surface(surface_id)
        mapping = self.mapping_definition.with_surface(surface)
        if (
            mapping.mode == "grid_linear"
            and self.tuning.space.construction["kind"] == "generator_lattice"
        ):
            mapping = replace(mapping, mode="harmonic_lattice")
        self.set_mapping(mapping.to_dict())

    def _sync_legacy_mapping_fields(self) -> None:
        midi_notes = [
            node.midi_note for node in self.input_surface.nodes if node.midi_note is not None
        ]
        self.keyboard_low = min(midi_notes, default=0)
        self.keyboard_high = max(midi_notes, default=len(self.input_surface.nodes) - 1)
        self.mapping_mode = self.mapping_definition.mode
        self.mapping_degree_step = self.mapping_definition.degree_step
        anchor = self.input_surface.node(self.mapping_definition.anchor_node_id)
        self.mapping_anchor = anchor.midi_note if anchor is not None else None

    def set_volume(self, value: float) -> None:
        self.synth.set_master_volume(value)
        self._publish({"type": "configuration", "field": "volume"})

    def set_chord_basis(self, payload: dict) -> None:
        mode = str(payload.get("mode", self.chord_basis_mode))
        if mode not in {
            "lowest",
            "selected",
            "virtual",
            "auto_simple",
            "auto_fundamental",
            "auto_composite",
        }:
            raise ValueError("unknown chord basis mode")
        with self._lock:
            if mode != self.chord_basis_mode:
                self._reset_auto_chord_basis()
            if mode == "selected":
                midi_value = payload.get("midi_note")
                if midi_value not in {None, ""}:
                    midi_note = int(midi_value)
                    if not 0 <= midi_note <= 127:
                        raise ValueError("selected basis MIDI note must be between 0 and 127")
                    self.chord_basis_midi_note = midi_note
                elif self.chord_basis_midi_note is None and self.active_notes:
                    self.chord_basis_midi_note = min(
                        self.active_notes.values(),
                        key=lambda item: item["frequency_hz"],
                    )["midi_note"]
            elif mode == "virtual":
                ratio = float(
                    payload.get(
                        "ratio_from_reference",
                        self.chord_virtual_ratio_from_reference,
                    )
                )
                if not math.isfinite(ratio) or not 1e-6 <= ratio <= 1e6:
                    raise ValueError("virtual basis f/T ratio must be between 1e-6 and 1e6")
                self.chord_virtual_ratio_from_reference = ratio
            self.chord_basis_mode = mode
        self._publish({"type": "configuration", "field": "chord_basis"})
