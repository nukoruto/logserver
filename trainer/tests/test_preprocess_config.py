from __future__ import annotations

from pathlib import Path
import textwrap

import pytest
import yaml

from trainer.scripts.preprocess import _load_config


def test_load_config_valid(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    config_body = textwrap.dedent(
        """
        data:
          raw_dir: data/raw
        session:
          idle_timeout: 30
        """
    ).strip()
    config_path.write_text(config_body, encoding="utf-8")

    loaded = _load_config(config_path)

    assert loaded["data"]["raw_dir"] == "data/raw"
    assert loaded["session"]["idle_timeout"] == 30


def test_load_config_invalid_yaml(tmp_path: Path) -> None:
    config_path = tmp_path / "broken.yaml"
    # Missing closing bracket triggers yaml.YAMLError via the parser.
    config_path.write_text("data: [1, 2", encoding="utf-8")

    with pytest.raises(yaml.YAMLError):
        _load_config(config_path)
