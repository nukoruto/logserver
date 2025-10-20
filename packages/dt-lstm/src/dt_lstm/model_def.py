"""Model definition utilities for dt-lstm architectures."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping

from .modules import DeltaTimeModel, DeltaTimeModelConfig


@dataclass
class ModelDefinition:
    """Serializable model definition with metadata."""

    config: DeltaTimeModelConfig
    metadata: Dict[str, Any] = field(default_factory=dict)
    version: str = "1.0"

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "version": self.version,
            "config": self.config.to_dict(),
            "metadata": dict(self.metadata),
        }
        return payload

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ModelDefinition":
        version = str(data.get("version", "1.0"))
        cfg_dict = data.get("config")
        if not isinstance(cfg_dict, Mapping):
            raise ValueError("model definition missing config mapping")
        metadata = data.get("metadata") or {}
        if not isinstance(metadata, Mapping):
            raise ValueError("metadata must be a mapping")
        config = DeltaTimeModelConfig.from_dict(cfg_dict)
        return cls(config=config, metadata=dict(metadata), version=version)

    def build_model(self) -> DeltaTimeModel:
        """Instantiate a model from this definition."""

        return DeltaTimeModel(self.config)


def save_definition(definition: ModelDefinition, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = definition.to_dict()
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")


def load_definition(path: Path) -> ModelDefinition:
    text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, Mapping):
        raise ValueError("model definition JSON must be an object")
    return ModelDefinition.from_dict(data)

