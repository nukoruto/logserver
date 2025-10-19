"""Artifact bookkeeping utilities."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Mapping


@dataclass
class CommandRecord:
    """Information recorded for each subprocess invocation."""

    name: str
    argv: List[str]
    returncode: int
    outputs: Mapping[str, str]


class ArtifactLogger:
    """Append command logs to env.txt and artifacts_index.json."""

    def __init__(self, directory: Path, env: Mapping[str, str]):
        self.directory = directory
        self.env = dict(env)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._write_env()

    def _write_env(self) -> None:
        env_file = self.directory / "env.txt"
        lines = [f"{key}={self.env[key]}" for key in sorted(self.env)]
        env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def append(self, record: CommandRecord) -> None:
        index_path = self.directory / "artifacts_index.json"
        if index_path.exists():
            payload = json.loads(index_path.read_text(encoding="utf-8"))
        else:
            payload = {"entries": []}
        entries = payload.get("entries")
        if not isinstance(entries, list):
            entries = []
        entry = {
            "name": record.name,
            "argv": record.argv,
            "returncode": int(record.returncode),
            "outputs": dict(record.outputs),
        }
        entries.append(entry)
        payload["entries"] = entries
        index_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def relative_outputs(base: Path, outputs: Mapping[str, Path]) -> Dict[str, str]:
    """Convert output paths to strings relative to base directory when possible."""

    resolved = {}
    for name, path in outputs.items():
        if path is None:
            continue
        try:
            resolved[name] = str(path.resolve().relative_to(base.resolve()))
        except ValueError:
            resolved[name] = str(path)
    return resolved
