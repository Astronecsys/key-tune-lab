from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from copy import deepcopy
from dataclasses import dataclass
from importlib import resources
from pathlib import Path


@dataclass(frozen=True)
class DefinitionEntry:
    definition: dict
    scope: str
    source: str


def _documents(root) -> Iterable[tuple[dict, str]]:  # noqa: ANN001
    # importlib.resources 的 Traversable 在 wheel/zip 中不保证实现 Path.exists()。
    if not root.is_dir():
        return
    for source in sorted(
        (item for item in root.iterdir() if item.name.endswith(".json")),
        key=lambda item: item.name,
    ):
        try:
            document = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"cannot load definition file {source}: {error}") from error
        definitions = document if isinstance(document, list) else [document]
        for definition in definitions:
            if not isinstance(definition, dict):
                raise ValueError(f"definition in {source} must be an object")
            yield definition, str(source)


def load_open_definitions(
    *,
    preset_folder: str,
    user_directory: Path,
    normalize: Callable[[dict], dict],
) -> dict[str, DefinitionEntry]:
    """内置 JSON 与用户 JSON 走同一校验流程，避免形成两套功能等级。"""
    entries: dict[str, DefinitionEntry] = {}
    builtin_root = resources.files("music_lab").joinpath("presets", preset_folder)
    for root, scope in ((builtin_root, "builtin"), (user_directory, "user")):
        for raw, source in _documents(root):
            definition = normalize(deepcopy(raw))
            definition_id = definition["id"]
            if definition_id in entries:
                raise ValueError(
                    f"duplicate {preset_folder} id {definition_id!r} in {source}; "
                    f"already defined by {entries[definition_id].source}"
                )
            entries[definition_id] = DefinitionEntry(
                definition=definition,
                scope=scope,
                source=source,
            )
    return entries
