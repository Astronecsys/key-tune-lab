from __future__ import annotations

from dataclasses import asdict, dataclass


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

    def to_dict(self, *, include_nodes: bool = False) -> dict:
        payload = {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "node_count": len(self.nodes),
            "geometry": dict(self.geometry),
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


def hex_surface(*, radius: int = 4) -> InputSurface:
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
        id="hex_61",
        name="61 格蜂窝表面",
        kind="hex",
        description="二维轴向坐标蜂窝；可使用等分步长或纯律生成基映射。",
        nodes=tuple(nodes),
        geometry={"radius": radius, "orientation": "pointy"},
    )


SURFACES = {
    surface.id: surface
    for surface in (
        piano_surface(id="piano_61", name="当前 61 键", low_midi=36, key_count=61),
        piano_surface(id="piano_66", name="66 键钢琴", low_midi=30, key_count=66),
        piano_surface(id="piano_88", name="88 键钢琴", low_midi=21, key_count=88),
        hex_surface(),
    )
}


def get_input_surface(surface_id: str) -> InputSurface:
    try:
        return SURFACES[surface_id]
    except KeyError as error:
        raise ValueError(f"unknown input surface {surface_id!r}") from error


def available_input_surfaces() -> list[dict]:
    return [surface.to_dict() for surface in SURFACES.values()]
