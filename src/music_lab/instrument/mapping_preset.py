from __future__ import annotations

import os
import re
from pathlib import Path
from threading import RLock

from .definition_library import load_open_definitions
from .mapping import MAPPING_MODE_IDS

MAPPING_PRESET_SCHEMA_VERSION = 1
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def normalize_mapping_preset(document: dict) -> dict:
    if int(document.get("schema_version", 0)) != MAPPING_PRESET_SCHEMA_VERSION:
        raise ValueError("unsupported mapping preset schema")
    preset_id = str(document.get("id", "")).strip()
    if not _ID_PATTERN.fullmatch(preset_id):
        raise ValueError("invalid mapping preset id")
    name = str(document.get("name", "")).strip()
    mapping = dict(document.get("mapping") or {})
    if not name or mapping.get("mode") not in MAPPING_MODE_IDS:
        raise ValueError("mapping preset requires a name and supported mode")
    surface_kinds = [str(kind) for kind in document.get("surface_kinds", [])]
    if not surface_kinds or any(kind not in {"piano", "hex"} for kind in surface_kinds):
        raise ValueError("mapping preset must declare piano or hex surface kinds")
    return {
        "schema_version": MAPPING_PRESET_SCHEMA_VERSION,
        "id": preset_id,
        "name": name,
        "description": str(document.get("description", "")).strip(),
        "surface_kinds": surface_kinds,
        "mapping": mapping,
    }


def default_user_mapping_directory() -> Path:
    configured = os.environ.get("KEY_TUNE_MAPPING_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.cwd() / "configs" / "mappings").resolve()


class MappingPresetLibrary:
    def __init__(self) -> None:
        self._lock = RLock()
        self._entries = {}
        self.reload()

    def reload(self) -> None:
        entries = load_open_definitions(
            preset_folder="mappings",
            user_directory=default_user_mapping_directory(),
            normalize=normalize_mapping_preset,
        )
        with self._lock:
            self._entries = entries

    def summaries(self) -> list[dict]:
        with self._lock:
            return [
                entry.definition | {"library_scope": entry.scope}
                for entry in self._entries.values()
            ]


_LIBRARY: MappingPresetLibrary | None = None
_LOCK = RLock()


def mapping_preset_library() -> MappingPresetLibrary:
    global _LIBRARY
    with _LOCK:
        if _LIBRARY is None:
            _LIBRARY = MappingPresetLibrary()
        return _LIBRARY


def available_mapping_presets() -> list[dict]:
    return mapping_preset_library().summaries()
