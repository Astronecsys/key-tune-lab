from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from threading import RLock

from .definition_library import load_open_definitions

TIMBRE_DEFINITION_SCHEMA_VERSION = 1
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class Timbre:
    id: str
    name: str
    description: str
    partials: tuple[tuple[float, float], ...]
    library_scope: str = "runtime"

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "partials": [
                {"multiple": multiple, "amplitude": amplitude}
                for multiple, amplitude in self.partials
            ],
            "library_scope": self.library_scope,
        }


def normalize_timbre_definition(document: dict) -> dict:
    if int(document.get("schema_version", 0)) != TIMBRE_DEFINITION_SCHEMA_VERSION:
        raise ValueError("unsupported timbre definition schema")
    timbre_id = str(document.get("id", "")).strip()
    if not _ID_PATTERN.fullmatch(timbre_id):
        raise ValueError("invalid timbre id")
    name = str(document.get("name", "")).strip()
    if not name:
        raise ValueError("timbre name cannot be empty")
    raw_partials = document.get("partials")
    if not isinstance(raw_partials, list) or not 1 <= len(raw_partials) <= 32:
        raise ValueError("partial count must be between 1 and 32")
    partials = []
    for item in raw_partials:
        if isinstance(item, dict):
            multiple = float(item["multiple"])
            amplitude = float(item["amplitude"])
        else:
            multiple, amplitude = (float(value) for value in item)
        if not math.isfinite(multiple) or multiple <= 0:
            raise ValueError("partial multiples must be positive finite numbers")
        if not math.isfinite(amplitude) or amplitude < 0:
            raise ValueError("partial amplitudes must be non-negative finite numbers")
        partials.append([multiple, amplitude])
    return {
        "schema_version": TIMBRE_DEFINITION_SCHEMA_VERSION,
        "id": timbre_id,
        "name": name,
        "description": str(document.get("description", "")).strip(),
        "partials": partials,
    }


def default_user_timbre_directory() -> Path:
    configured = os.environ.get("KEY_TUNE_TIMBRE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.cwd() / "configs" / "timbres").resolve()


class TimbreLibrary:
    def __init__(self, user_directory: Path | None = None) -> None:
        self.user_directory = user_directory or default_user_timbre_directory()
        self._lock = RLock()
        self._timbres: dict[str, Timbre] = {}
        self.reload()

    def reload(self) -> None:
        entries = load_open_definitions(
            preset_folder="timbres",
            user_directory=self.user_directory,
            normalize=normalize_timbre_definition,
        )
        timbres = {
            timbre_id:Timbre(
                id=timbre_id,
                name=entry.definition["name"],
                description=entry.definition["description"],
                partials=tuple(tuple(item) for item in entry.definition["partials"]),
                library_scope=entry.scope,
            )
            for timbre_id, entry in entries.items()
        }
        with self._lock:
            self._timbres = timbres

    def get(self, timbre_id: str) -> Timbre:
        with self._lock:
            timbre = self._timbres.get(timbre_id)
        if timbre is None:
            raise ValueError(f"unknown timbre {timbre_id!r}")
        return timbre

    def summaries(self) -> list[dict]:
        with self._lock:
            return [timbre.summary() for timbre in self._timbres.values()]


_DEFAULT_LIBRARY: TimbreLibrary | None = None
_DEFAULT_LIBRARY_LOCK = RLock()


def timbre_library() -> TimbreLibrary:
    global _DEFAULT_LIBRARY
    with _DEFAULT_LIBRARY_LOCK:
        if _DEFAULT_LIBRARY is None:
            _DEFAULT_LIBRARY = TimbreLibrary()
        return _DEFAULT_LIBRARY


def get_timbre(timbre_id: str) -> Timbre:
    return timbre_library().get(timbre_id)


def available_timbres() -> list[dict]:
    return timbre_library().summaries()
