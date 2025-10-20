"""dt-lstm CLI の挙動テスト。"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")  # noqa: F841 - 利用有無でスキップ

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli, load_definition  # noqa: E402  pylint: disable=wrong-import-position


def test_cli_init_creates_expected_structure(tmp_path, capsys):
    out_dir = tmp_path / "ml"
    exit_code = cli.main([
        "init",
        "--out",
        str(out_dir),
        "--preset",
        "default",
        "--seed",
        "777",
        "--device",
        "cpu",
    ])
    assert exit_code == 0

    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["event"] == "init.completed"
    assert payload["seed"] == 777
    assert Path(payload["out_dir"]) == out_dir.resolve()

    expected_files = [
        out_dir / "pyproject.toml",
        out_dir / "configs" / "default.yaml",
        out_dir / "dt_lstm" / "__init__.py",
        out_dir / "dt_lstm" / "pipeline.py",
        out_dir / "scripts" / "train.py",
        out_dir / "tests" / "test_placeholder.py",
    ]
    for path in expected_files:
        assert path.exists(), f"{path} が生成されていません"

    pyproject_text = (out_dir / "pyproject.toml").read_text(encoding="utf-8")
    assert "__SEED__" not in pyproject_text
    assert "seed = 777" in pyproject_text

    config_text = (out_dir / "configs" / "default.yaml").read_text(encoding="utf-8")
    assert "__DEVICE__" not in config_text
    assert "prefer: \"cpu\"" in config_text or "prefer: cpu" in config_text

    mode = (out_dir / "scripts" / "train.py").stat().st_mode
    assert mode & stat.S_IXUSR, "train.py が実行可能ではありません"

    assert os.environ["CUBLAS_WORKSPACE_CONFIG"] == ":16:8"


def test_cli_help(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    output = capsys.readouterr().out
    assert "dt-lstm" in output


def test_cli_build_creates_definition(tmp_path, capsys):
    out_path = tmp_path / "model_def.json"
    exit_code = cli.main(
        [
            "build",
            "--arch",
            "lstm",
            "--time-head",
            "rmtpp",
            "--vocab-size",
            "32",
            "--emb-dim",
            "16",
            "--hidden",
            "24",
            "--layers",
            "2",
            "--dropout",
            "0.2",
            "--numeric-dim",
            "5",
            "--mlp-hidden",
            "12",
            "--delta-index",
            "1",
            "--out",
            str(out_path),
        ]
    )
    assert exit_code == 0
    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["event"] == "build.completed"
    assert out_path.exists()
    definition = load_definition(out_path)
    model_a = definition.build_model()
    model_b = definition.build_model()
    assert sum(p.numel() for p in model_a.parameters()) == sum(p.numel() for p in model_b.parameters())
