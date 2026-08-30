from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from threading import RLock

from .tuning import Tuning
from .tuning_space import (
    equal_division_space,
    explicit_degree_space,
    generator_chain_space,
    interval_cycle_space,
    lattice_space,
)

TUNING_DEFINITION_SCHEMA_VERSION = 1
_TUNING_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class TuningLibraryEntry:
    definition: dict
    tuning: Tuning
    scope: str
    source: str

    def summary(self) -> dict:
        return self.tuning.summary() | {
            "library_scope": self.scope,
            "definition": deepcopy(self.definition),
        }


def normalize_tuning_definition(document: dict) -> dict:
    if not isinstance(document, dict):
        raise ValueError("tuning definition must be an object")
    definition = deepcopy(document)
    version = int(definition.get("schema_version", 0))
    if version != TUNING_DEFINITION_SCHEMA_VERSION:
        raise ValueError(
            f"unsupported tuning definition schema {version}; "
            f"expected {TUNING_DEFINITION_SCHEMA_VERSION}"
        )
    tuning_id = str(definition.get("id", "")).strip()
    if not _TUNING_ID_PATTERN.fullmatch(tuning_id):
        raise ValueError(
            "tuning id must use 1-64 lowercase ASCII letters, digits, '.', '_' or '-'"
        )
    name = str(definition.get("name", "")).strip()
    if not name:
        raise ValueError("tuning name cannot be empty")
    description = str(definition.get("description", "")).strip()
    construction = definition.get("construction")
    if not isinstance(construction, dict):
        raise ValueError("tuning construction must be an object")
    kind = str(construction.get("kind", "")).strip()
    if kind not in {
        "equal_division",
        "generator_chain",
        "explicit",
        "ratio_set",
        "interval_cycle",
        "generator_lattice",
    }:
        raise ValueError(f"unsupported tuning construction {kind!r}")
    equave_expression = str(
        construction.get("equave_expression", "2")
    ).strip()
    if not equave_expression:
        raise ValueError("equave expression cannot be empty")
    construction["kind"] = kind
    construction["equave_expression"] = equave_expression

    reference = definition.get("reference", {})
    if not isinstance(reference, dict):
        raise ValueError("tuning reference must be an object")
    reference = {
        "midi_note": int(reference.get("midi_note", 69)),
        "frequency_hz": float(reference.get("frequency_hz", 440.0)),
        "degree": int(reference.get("degree", 0)),
    }
    if not 0 <= reference["midi_note"] <= 127:
        raise ValueError("reference MIDI key must be between 0 and 127")
    if reference["frequency_hz"] <= 0:
        raise ValueError("reference frequency must be positive")

    notation = definition.get("notation", {})
    if not isinstance(notation, dict):
        raise ValueError("tuning notation must be an object")
    alias_system = notation.get("alias_system")
    if alias_system not in {None, "western_12edo"}:
        raise ValueError(f"unsupported notation alias system {alias_system!r}")

    tags = definition.get("tags", [])
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        raise ValueError("tuning tags must be a list of strings")

    definition.update(
        {
            "schema_version": TUNING_DEFINITION_SCHEMA_VERSION,
            "id": tuning_id,
            "name": name,
            "description": description,
            "construction": construction,
            "reference": reference,
            "notation": {"alias_system": alias_system},
            "tags": [tag.strip() for tag in tags if tag.strip()],
        }
    )
    return definition


def tuning_from_definition(document: dict) -> Tuning:
    definition = normalize_tuning_definition(document)
    construction = definition["construction"]
    kind = construction["kind"]
    common = {
        "id": definition["id"],
        "name": definition["name"],
        "description": definition["description"],
        "equave_expression": construction["equave_expression"],
    }
    if kind == "equal_division":
        space = equal_division_space(
            **common,
            divisions=int(construction["divisions"]),
        )
    elif kind == "generator_chain":
        space = generator_chain_space(
            **common,
            generator_expression=str(construction["generator_expression"]),
            degree_count=int(construction["degree_count"]),
            chain_start=int(construction.get("chain_start", 0)),
        )
    elif kind in {"explicit", "ratio_set"}:
        expressions = construction.get("degree_expressions", [])
        if isinstance(expressions, str):
            expressions = [
                item.strip()
                for item in expressions.replace("\n", ",").split(",")
                if item.strip()
            ]
        space = explicit_degree_space(
            **common,
            degree_expressions=list(expressions),
            construction_kind=kind,
        )
    elif kind == "interval_cycle":
        expressions = construction.get("interval_expressions", [])
        if isinstance(expressions, str):
            expressions = [
                item.strip()
                for item in expressions.replace("\n", ",").split(",")
                if item.strip()
            ]
        space = interval_cycle_space(
            **common,
            interval_expressions=list(expressions),
        )
    else:
        expressions = construction.get("basis_expressions", [])
        space = lattice_space(
            **common,
            basis_expressions=tuple(str(item) for item in expressions),
        )

    reference = definition["reference"]
    if not 0 <= reference["degree"] < space.divisions:
        raise ValueError("reference degree is outside the tuning space")
    return Tuning(
        id=definition["id"],
        name=definition["name"],
        description=definition["description"],
        reference_midi=reference["midi_note"],
        reference_frequency_hz=reference["frequency_hz"],
        reference_degree=reference["degree"],
        divisions=space.divisions,
        equave_ratio=space.equave_ratio,
        algebraic_basis=definition.get("relation_basis"),
        space=space,
        traditional_alias_system=definition["notation"]["alias_system"],
        definition=definition,
    )


def draft_definition(
    payload: dict,
    *,
    default_frequency_hz: float = 440.0,
    default_midi_note: int = 69,
    default_reference_degree: int = 0,
) -> dict:
    if "construction" in payload:
        return normalize_tuning_definition(payload)
    kind = str(payload.get("kind", "equal_division"))
    construction = {
        key: deepcopy(value)
        for key, value in payload.items()
        if key
        in {
            "kind",
            "equave_expression",
            "divisions",
            "generator_expression",
            "degree_count",
            "chain_start",
            "degree_expressions",
            "interval_expressions",
            "basis_expressions",
        }
    }
    construction["kind"] = kind
    construction.setdefault("equave_expression", "2")
    requested_reference_degree = int(
        payload.get("reference_degree", default_reference_degree)
    )
    known_degree_count: int | None = None
    if kind == "equal_division" and "divisions" in construction:
        known_degree_count = int(construction["divisions"])
    elif kind == "generator_chain" and "degree_count" in construction:
        known_degree_count = int(construction["degree_count"])
    elif kind in {"explicit", "ratio_set"}:
        expressions = construction.get("degree_expressions", [])
        if isinstance(expressions, str):
            expressions = [
                item.strip()
                for item in expressions.replace("\n", ",").split(",")
                if item.strip()
            ]
        known_degree_count = len(expressions)
    elif kind == "interval_cycle":
        expressions = construction.get("interval_expressions", [])
        if isinstance(expressions, str):
            expressions = [
                item.strip()
                for item in expressions.replace("\n", ",").split(",")
                if item.strip()
            ]
        known_degree_count = len(expressions)
    if known_degree_count is not None and known_degree_count > 0:
        requested_reference_degree = max(
            0,
            min(requested_reference_degree, known_degree_count - 1),
        )
    return normalize_tuning_definition(
        {
            "schema_version": TUNING_DEFINITION_SCHEMA_VERSION,
            "id": str(payload.get("id", "custom")),
            "name": str(payload.get("name", "自定义律制空间")),
            "description": str(
                payload.get("description", "由 02 律制生成器创建。")
            ),
            "construction": construction,
            "reference": {
                "midi_note": int(payload.get("reference_midi", default_midi_note)),
                "frequency_hz": float(
                    payload.get("reference_frequency_hz", default_frequency_hz)
                ),
                "degree": int(
                    requested_reference_degree
                ),
            },
            "notation": deepcopy(payload.get("notation", {})),
            "tags": deepcopy(payload.get("tags", ["user-draft"])),
        }
    )


class TuningLibrary:
    def __init__(self, user_directory: Path | None = None) -> None:
        self.user_directory = user_directory or default_user_tuning_directory()
        self._entries: dict[str, TuningLibraryEntry] = {}
        self._lock = RLock()
        self.reload()

    def reload(self) -> None:
        entries: dict[str, TuningLibraryEntry] = {}
        builtin_root = resources.files("music_lab").joinpath("presets", "tunings")
        self._load_root(builtin_root, "builtin", entries)
        if self.user_directory.exists():
            self._load_root(self.user_directory, "user", entries)
        with self._lock:
            self._entries = entries

    def _load_root(self, root, scope: str, entries: dict[str, TuningLibraryEntry]) -> None:
        for source in sorted(
            (item for item in root.iterdir() if item.name.endswith(".json")),
            key=lambda item: item.name,
        ):
            try:
                document = json.loads(source.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"cannot load tuning file {source}: {error}") from error
            definitions: Iterable[dict] = document if isinstance(document, list) else [document]
            for raw_definition in definitions:
                definition = normalize_tuning_definition(raw_definition)
                tuning_id = definition["id"]
                if tuning_id in entries:
                    previous = entries[tuning_id]
                    raise ValueError(
                        f"duplicate tuning id {tuning_id!r} in {source}; "
                        f"already defined by {previous.source}"
                    )
                entries[tuning_id] = TuningLibraryEntry(
                    definition=definition,
                    tuning=tuning_from_definition(definition),
                    scope=scope,
                    source=str(source),
                )

    def get(self, tuning_id: str) -> Tuning:
        with self._lock:
            entry = self._entries.get(tuning_id)
        if entry is None:
            raise ValueError(f"unknown tuning {tuning_id!r}")
        return entry.tuning

    def summaries(self) -> list[dict]:
        with self._lock:
            return [entry.summary() for entry in self._entries.values()]

    def save_user_definition(self, document: dict, *, overwrite: bool = False) -> Tuning:
        definition = normalize_tuning_definition(document)
        tuning = tuning_from_definition(definition)
        with self._lock:
            existing = self._entries.get(definition["id"])
        if existing is not None and existing.scope == "builtin":
            raise ValueError("built-in tuning ids cannot be overwritten")
        if existing is not None and not overwrite:
            raise ValueError("a user tuning with this id already exists")
        self.user_directory.mkdir(parents=True, exist_ok=True)
        if existing is not None:
            target = Path(existing.source).resolve()
            try:
                target.relative_to(self.user_directory.resolve())
            except ValueError as error:
                raise ValueError(
                    "user tuning source is outside the configured directory"
                ) from error
            persisted = self._replace_definition_in_source(target, definition)
        else:
            target = self.user_directory / f"{definition['id']}.json"
            if target.exists():
                raise ValueError(
                    "the target filename already exists but does not define this tuning id"
                )
            persisted = definition
        self._atomic_write(target, persisted)
        self.reload()
        return self.get(tuning.id)

    @staticmethod
    def _replace_definition_in_source(target: Path, definition: dict) -> dict | list:
        try:
            document = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"cannot update tuning file {target}: {error}") from error
        if not isinstance(document, list):
            if not isinstance(document, dict) or document.get("id") != definition["id"]:
                raise ValueError("user tuning source no longer contains the selected id")
            return definition
        matching = [
            index
            for index, item in enumerate(document)
            if isinstance(item, dict) and item.get("id") == definition["id"]
        ]
        if len(matching) != 1:
            raise ValueError("user tuning source no longer contains one unique selected id")
        updated = deepcopy(document)
        updated[matching[0]] = definition
        return updated

    @staticmethod
    def _atomic_write(target: Path, document: dict | list) -> None:
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(target)


def default_user_tuning_directory() -> Path:
    configured = os.environ.get("MUSIC_LAB_TUNING_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.cwd() / "configs" / "tunings").resolve()


_DEFAULT_LIBRARY: TuningLibrary | None = None
_DEFAULT_LIBRARY_LOCK = RLock()


def tuning_library() -> TuningLibrary:
    global _DEFAULT_LIBRARY
    with _DEFAULT_LIBRARY_LOCK:
        if _DEFAULT_LIBRARY is None:
            _DEFAULT_LIBRARY = TuningLibrary()
        return _DEFAULT_LIBRARY


def reload_tuning_library() -> None:
    tuning_library().reload()


def save_user_tuning_definition(document: dict, *, overwrite: bool = False) -> Tuning:
    return tuning_library().save_user_definition(document, overwrite=overwrite)
