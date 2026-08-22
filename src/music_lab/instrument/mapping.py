from __future__ import annotations

from dataclasses import asdict, dataclass, replace

from .input_surface import InputNode, InputSurface
from .tuning import KeyPitch, Tuning
from .tuning_space import parse_pitch_expression


MAPPING_MODES = (
    {
        "id": "continuous",
        "name": "连续音级",
        "description": "相邻输入节点前进固定数量的律制音级。",
    },
    {
        "id": "reverse",
        "name": "反向连续",
        "description": "相邻输入节点沿律制反方向移动。",
    },
    {
        "id": "white_only",
        "name": "仅钢琴白键",
        "description": "黑键不映射，白键沿律制连续排列。",
    },
    {
        "id": "periodic_subset",
        "name": "周期音级子集",
        "description": "在一组钢琴键上重复选定的律制音级索引。",
    },
    {
        "id": "grid_linear",
        "name": "蜂窝等分基向量",
        "description": "蜂窝 q/r 两轴分别移动指定数量的律制音级。",
    },
    {
        "id": "harmonic_lattice",
        "name": "蜂窝纯律生成格",
        "description": "蜂窝 q/r 两轴分别乘以精确的生成比例。",
    },
)
MAPPING_MODE_IDS = frozenset(mode["id"] for mode in MAPPING_MODES)


@dataclass(frozen=True)
class MappingDefinition:
    surface_id: str
    mode: str
    anchor_node_id: str
    reference_frequency_hz: float = 440.0
    reference_degree: int = 0
    degree_step: int = 1
    subset_degrees: tuple[int, ...] = ()
    q_step: int = 24
    r_step: int = 13
    q_ratio_expression: str = "3/2"
    r_ratio_expression: str = "5/4"

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["subset_degrees"] = list(self.subset_degrees)
        return payload

    def with_surface(self, surface: InputSurface) -> MappingDefinition:
        default_mode = "grid_linear" if surface.kind == "hex" else "continuous"
        return replace(
            self,
            surface_id=surface.id,
            mode=default_mode,
            anchor_node_id=surface.default_anchor_id,
        )


def available_mapping_modes() -> list[dict]:
    return [dict(mode) for mode in MAPPING_MODES]


def compile_node_pitch(
    mapping: MappingDefinition,
    surface: InputSurface,
    tuning: Tuning,
    node: InputNode,
) -> KeyPitch | None:
    anchor = surface.node(mapping.anchor_node_id)
    if anchor is None:
        raise ValueError("mapping anchor is not present on the input surface")
    physical_note = node.midi_note if node.midi_note is not None else node.index

    if mapping.mode == "white_only":
        if node.role != "white":
            return None
        ordered = [candidate for candidate in surface.nodes if candidate.role == "white"]
        relative = (
            _node_rank(ordered, node.id) - _node_rank(ordered, anchor.id)
        ) * mapping.degree_step
    elif mapping.mode in {"continuous", "reverse"}:
        direction = -1 if mapping.mode == "reverse" else 1
        relative = (
            node.index - anchor.index
        ) * mapping.degree_step * direction
    elif mapping.mode == "periodic_subset":
        subset = mapping.subset_degrees or nearest_subset(
            tuning.divisions, 12
        )
        delta = node.index - anchor.index
        equave, slot = divmod(delta, len(subset))
        relative = equave * tuning.divisions + subset[slot]
    elif mapping.mode == "grid_linear":
        q = node.coordinate[0] - anchor.coordinate[0]
        r = node.coordinate[1] - anchor.coordinate[1]
        relative = q * mapping.q_step + r * mapping.r_step
    elif mapping.mode == "harmonic_lattice":
        q = node.coordinate[0] - anchor.coordinate[0]
        r = node.coordinate[1] - anchor.coordinate[1]
        q_ratio, q_exact = parse_pitch_expression(mapping.q_ratio_expression)
        r_ratio, r_exact = parse_pitch_expression(mapping.r_ratio_expression)
        ratio = (q_ratio**q) * (r_ratio**r)
        exact_ratio = (
            (q_exact**q) * (r_exact**r)
            if q_exact is not None and r_exact is not None
            else None
        )
        return tuning.map_ratio(
            physical_note,
            ratio,
            pitch_label=(
                f"T·({mapping.q_ratio_expression})^{q}"
                f"·({mapping.r_ratio_expression})^{r}"
            ),
            exact_ratio=exact_ratio,
        )
    else:
        raise ValueError(f"unknown mapping mode {mapping.mode!r}")
    return tuning.map_relative(physical_note, relative)


def validate_mapping(
    mapping: MappingDefinition,
    surface: InputSurface,
    tuning: Tuning,
) -> None:
    if mapping.mode not in MAPPING_MODE_IDS:
        raise ValueError("unknown mapping mode")
    if mapping.surface_id != surface.id:
        raise ValueError("mapping and input surface do not match")
    if surface.node(mapping.anchor_node_id) is None:
        raise ValueError("mapping anchor is not present on the input surface")
    if not 1 <= abs(mapping.degree_step) <= 256:
        raise ValueError("degree step must be between 1 and 256")
    if not mapping.reference_frequency_hz > 0:
        raise ValueError("T frequency must be positive")
    if not 0 <= mapping.reference_degree < tuning.divisions:
        raise ValueError("T degree is outside the tuning space")
    if mapping.mode == "periodic_subset":
        if not mapping.subset_degrees:
            raise ValueError("periodic subset cannot be empty")
        if mapping.subset_degrees[0] != 0:
            raise ValueError("periodic subset must begin with degree 0")
        if any(
            degree < 0 or degree >= tuning.divisions
            for degree in mapping.subset_degrees
        ):
            raise ValueError("periodic subset degree is outside the tuning space")
        if tuple(sorted(set(mapping.subset_degrees))) != mapping.subset_degrees:
            raise ValueError("periodic subset degrees must be unique and sorted")
    if mapping.mode in {"grid_linear", "harmonic_lattice"} and surface.kind != "hex":
        raise ValueError("grid mappings require a hex input surface")
    if mapping.mode == "harmonic_lattice":
        parse_pitch_expression(mapping.q_ratio_expression)
        parse_pitch_expression(mapping.r_ratio_expression)


def nearest_subset(divisions: int, slot_count: int) -> tuple[int, ...]:
    if slot_count < 1 or divisions < slot_count:
        raise ValueError("subset requires at least as many tuning degrees as slots")
    return tuple(round(slot * divisions / slot_count) for slot in range(slot_count))


def _node_rank(nodes: list[InputNode], node_id: str) -> int:
    for index, node in enumerate(nodes):
        if node.id == node_id:
            return index
    raise ValueError("input node is not part of the selected mapping sequence")
