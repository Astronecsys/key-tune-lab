from __future__ import annotations

import json

from music_lab.instrument.input_surface import (
    available_input_surfaces,
    normalize_input_surface_definition,
)
from music_lab.instrument.mapping_preset import (
    available_mapping_presets,
    normalize_mapping_preset,
)
from music_lab.instrument.timbre_library import TimbreLibrary


def test_builtin_timbres_and_user_timbres_share_one_definition_path(tmp_path) -> None:
    (tmp_path / "glass.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "id": "glass",
                "name": "Glass",
                "description": "test user timbre",
                "partials": [[1, 1], [2.7, 0.2]],
            }
        ),
        encoding="utf-8",
    )
    library = TimbreLibrary(user_directory=tmp_path)

    assert library.get("warm").library_scope == "builtin"
    assert library.get("glass").library_scope == "user"
    assert library.get("glass").partials[1] == (2.7, 0.2)


def test_input_surface_definitions_validate_geometry_before_construction() -> None:
    definition = normalize_input_surface_definition(
        {
            "schema_version": 1,
            "id": "piano_24",
            "name": "24-key experiment",
            "kind": "piano",
            "geometry": {"low_midi": 48, "key_count": 24},
        }
    )

    assert definition["geometry"] == {"low_midi": 48, "key_count": 24}
    assert {surface["id"] for surface in available_input_surfaces()} >= {
        "piano_61",
        "piano_88",
        "hex_61",
    }


def test_mapping_presets_are_data_while_mapping_modes_remain_code() -> None:
    preset = normalize_mapping_preset(
        {
            "schema_version": 1,
            "id": "custom-subset",
            "name": "Custom subset",
            "surface_kinds": ["piano"],
            "mapping": {"mode": "periodic_subset", "subset_degrees": [0, 3, 7]},
        }
    )

    assert preset["mapping"]["mode"] == "periodic_subset"
    assert {item["id"] for item in available_mapping_presets()} >= {
        "piano-continuous",
        "hex-harmonic",
    }
