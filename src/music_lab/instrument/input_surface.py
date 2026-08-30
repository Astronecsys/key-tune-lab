from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from threading import RLock

from .definition_library import load_open_definitions

INPUT_SURFACE_DEFINITION_SCHEMA_VERSION = 1
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class InputNode:
    id: str
    index: int
    label: str
    role: str
    midi_note: int | None
    coordinate: tuple[int, int]

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["coordinate"] = list(self.coordinate)
        return payload


@dataclass(frozen=True)
class InputSurface:
    id: str
    name: str
    kind: str
    description: str
    nodes: tuple[InputNode, ...]
    geometry: dict
    library_scope: str = "runtime"

    def to_dict(self, *, include_nodes: bool = False) -> dict:
        payload = {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "node_count": len(self.nodes),
            "geometry": dict(self.geometry),
            "library_scope": self.library_scope,
        }
        if include_nodes:
            payload["nodes"] = [node.to_dict() for node in self.nodes]
        return payload

    def node(self, node_id: str) -> InputNode | None:
        return next((node for node in self.nodes if node.id == node_id), None)

    def node_for_midi(self, midi_note: int) -> InputNode | None:
        return next(
            (node for node in self.nodes if node.midi_note == midi_note),
            None,
        )

    @property
    def default_anchor_id(self) -> str:
        midi_anchor = self.node_for_midi(69)
        if midi_anchor is not None:
            return midi_anchor.id
        origin = next(
            (node for node in self.nodes if node.coordinate == (0, 0)),
            None,
        )
        return (origin or self.nodes[len(self.nodes) // 2]).id


def piano_surface(
    *, id: str, name: str, low_midi: int, key_count: int
) -> InputSurface:
    if not 1 <= key_count <= 128 or not 0 <= low_midi <= 127:
        raise ValueError("invalid piano surface range")
    high_midi = low_midi + key_count - 1
    if high_midi > 127:
        raise ValueError("piano surface exceeds MIDI 1.0 key range")
    black_classes = {1, 3, 6, 8, 10}
    nodes = tuple(
        InputNode(
            id=f"{id}:K{midi_note}",
            index=index,
            label=f"K{midi_note}",
            role=("black" if midi_note % 12 in black_classes else "white"),
            midi_note=midi_note,
            coordinate=(index, 0),
        )
        for index, midi_note in enumerate(range(low_midi, high_midi + 1))
    )
    return InputSurface(
        id=id,
        name=name,
        kind="piano",
        description=f"{key_count} 键线性钢琴表面 · MIDI {low_midi}–{high_midi}",
        nodes=nodes,
        geometry={"low_midi": low_midi, "high_midi": high_midi},
    )


def hex_surface(
    *,
    radius: int = 4,
    id: str = "hex_61",
    name: str = "61 格蜂窝表面",
    description: str = "二维轴向坐标蜂窝；可使用等分步长或纯律生成基映射。",
) -> InputSurface:
    nodes: list[InputNode] = []
    for q in range(-radius, radius + 1):
        r_min = max(-radius, -q - radius)
        r_max = min(radius, -q + radius)
        for r in range(r_min, r_max + 1):
            nodes.append(
                InputNode(
                    id=f"hex:q{q}:r{r}",
                    index=0,
                    label=f"{q},{r}",
                    role="hex",
                    midi_note=None,
                    coordinate=(q, r),
                )
            )
    nodes.sort(key=lambda node: (node.coordinate[1], node.coordinate[0]))
    nodes = [
        InputNode(
            id=node.id,
            index=index,
            label=node.label,
            role=node.role,
            midi_note=node.midi_note,
            coordinate=node.coordinate,
        )
        for index, node in enumerate(nodes)
    ]
    return InputSurface(
        id=id,
        name=name,
        kind="hex",
        description=description,
        nodes=tuple(nodes),
        geometry={"radius": radius, "orientation": "pointy"},
    )


def normalize_input_surface_definition(document: dict) -> dict:
    if int(document.get("schema_version", 0)) != INPUT_SURFACE_DEFINITION_SCHEMA_VERSION:
        raise ValueError("unsupported input surface definition schema")
    surface_id = str(document.get("id", "")).strip()
    if not _ID_PATTERN.fullmatch(surface_id):
        raise ValueError("invalid input surface id")
    name = str(document.get("name", "")).strip()
    kind = str(document.get("kind", "")).strip()
    if not name or kind not in {"piano", "hex"}:
        raise ValueError("input surface requires a name and supported kind")
    geometry = dict(document.get("geometry") or {})
    if kind == "piano":
        low_midi = int(geometry["low_midi"])
        key_count = int(geometry["key_count"])
        piano_surface(id=surface_id, name=name, low_midi=low_midi, key_count=key_count)
        geometry = {"low_midi": low_midi, "key_count": key_count}
    else:
        radius = int(geometry.get("radius", 4))
        if not 1 <= radius <= 12:
            raise ValueError("hex radius must be between 1 and 12")
        geometry = {"radius": radius}
    return {
        "schema_version": INPUT_SURFACE_DEFINITION_SCHEMA_VERSION,
        "id": surface_id,
        "name": name,
        "kind": kind,
        "description": str(document.get("description", "")).strip(),
        "geometry": geometry,
    }


def default_user_input_surface_directory() -> Path:
    configured = os.environ.get("KEY_TUNE_INPUT_SURFACE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.cwd() / "configs" / "input_surfaces").resolve()


def _surface_from_definition(definition: dict, scope: str) -> InputSurface:
    if definition["kind"] == "piano":
        surface = piano_surface(
            id=definition["id"],
            name=definition["name"],
            low_midi=definition["geometry"]["low_midi"],
            key_count=definition["geometry"]["key_count"],
        )
        surface = replace(surface, description=definition["description"] or surface.description)
    else:
        surface = hex_surface(
            id=definition["id"],
            name=definition["name"],
            description=definition["description"] or "二维轴向坐标蜂窝。",
            radius=definition["geometry"]["radius"],
        )
    return replace(surface, library_scope=scope)


_SURFACE_LOCK = RLock()
SURFACES: dict[str, InputSurface] = {}


def reload_input_surface_library() -> None:
    entries = load_open_definitions(
        preset_folder="input_surfaces",
        user_directory=default_user_input_surface_directory(),
        normalize=normalize_input_surface_definition,
    )
    surfaces = {
        surface_id:_surface_from_definition(entry.definition, entry.scope)
        for surface_id, entry in entries.items()
    }
    with _SURFACE_LOCK:
        SURFACES.clear()
        SURFACES.update(surfaces)


reload_input_surface_library()


def get_input_surface(surface_id: str) -> InputSurface:
    try:
        return SURFACES[surface_id]
    except KeyError as error:
        raise ValueError(f"unknown input surface {surface_id!r}") from error


def available_input_surfaces() -> list[dict]:
    return [surface.to_dict() for surface in SURFACES.values()]
