from __future__ import annotations

import json
import sys
import tarfile
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")  # noqa: F841 - ensure torch is available

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position


def _write_csv(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def test_export_bundle_and_infer(tmp_path, capsys):
    train_dir = tmp_path / "train"
    val_dir = tmp_path / "val"
    artifacts_dir = tmp_path / "ml" / "artifacts"
    ckpt_dir = tmp_path / "ml" / "checkpoints"
    train_dir.mkdir(parents=True)
    val_dir.mkdir(parents=True)

    train_rows = """timestamp_utc,sid_final,uid,cat_id,op_category,z_clipped,lburst,m25,m50,m75,z_deseas,dt_sec
2024-01-01T00:00:00Z,s-1,u-1,1,AUTH,0.1,0,0,0,0,0,0.0
2024-01-01T00:00:01Z,s-1,u-1,2,READ,0.2,0,0,0,0,0,1.0
2024-01-01T00:00:03Z,s-1,u-1,3,UPDATE,0.3,0,0,0,0,0,2.0
2024-01-02T00:00:00Z,s-2,u-2,1,AUTH,0.1,0,0,0,0,0,0.0
2024-01-02T00:00:01Z,s-2,u-2,4,DELETE,0.4,0,0,0,0,0,1.0
2024-01-02T00:00:05Z,s-2,u-2,2,READ,0.2,0,0,0,0,0,4.0
"""
    val_rows = """timestamp_utc,sid_final,uid,cat_id,op_category,z_clipped,lburst,m25,m50,m75,z_deseas,dt_sec
2024-01-03T00:00:00Z,s-3,u-3,1,AUTH,0.1,0,0,0,0,0,0.0
2024-01-03T00:00:01Z,s-3,u-3,2,READ,0.2,0,0,0,0,0,1.0
2024-01-03T00:00:04Z,s-3,u-3,3,UPDATE,0.3,0,0,0,0,0,3.0
"""
    _write_csv(train_dir / "train.csv", train_rows)
    _write_csv(val_dir / "val.csv", val_rows)

    vocab_path = artifacts_dir / "vocab.json"
    meta_path = artifacts_dir / "train_meta.json"
    exit_code = cli.main(
        [
            "fit",
            "--in",
            str(train_dir / "*.csv"),
            "--vocab-out",
            str(vocab_path),
            "--cfg-out",
            str(meta_path),
        ]
    )
    assert exit_code == 0
    capsys.readouterr()

    # Train model with vocabulary
    exit_code = cli.main(
        [
            "train",
            "--train",
            str(train_dir / "*.csv"),
            "--val",
            str(val_dir / "*.csv"),
            "--arch",
            "lstm",
            "--time-head",
            "rmtpp",
            "--time-objective",
            "rmtpp",
            "--epochs",
            "2",
            "--bs",
            "2",
            "--lr",
            "1e-2",
            "--scheduler",
            "none",
            "--early",
            "2",
            "--uncertainty-weight",
            "off",
            "--seed",
            "123",
            "--vocab",
            str(vocab_path),
            "--out",
            str(ckpt_dir),
        ]
    )
    assert exit_code == 0
    train_payload = json.loads(capsys.readouterr().out.strip())
    ckpt_path = Path(train_payload["model_path"])
    config_path = Path(train_payload["config_path"])
    assert ckpt_path.exists()
    assert config_path.exists()

    # Calibrate temperature
    calib_path = tmp_path / "ml" / "artifacts" / "calib.json"
    exit_code = cli.main(
        [
            "calibrate",
            "--val",
            str(val_dir / "*.csv"),
            "--ckpt",
            str(ckpt_path),
            "--out",
            str(calib_path),
            "--batch-size",
            "2",
        ]
    )
    assert exit_code == 0
    calib_payload = json.loads(capsys.readouterr().out.strip())
    assert Path(calib_payload["out_path"]).exists()

    baseline_out = tmp_path / "baseline.csv"
    exit_code = cli.main(
        [
            "infer",
            "--in",
            str(val_dir / "*.csv"),
            "--ckpt",
            str(ckpt_path),
            "--calib",
            str(calib_path),
            "--topk",
            "3",
            "--out",
            str(baseline_out),
        ]
    )
    assert exit_code == 0
    infer_payload = json.loads(capsys.readouterr().out.strip())
    assert Path(infer_payload["out_path"]).exists()

    bundle_path = tmp_path / "model_bundle.tar"
    exit_code = cli.main(
        [
            "export",
            "--ckpt",
            str(ckpt_path),
            "--vocab",
            str(vocab_path),
            "--calib",
            str(calib_path),
            "--meta",
            str(meta_path),
            "--algo-ver",
            "1",
            "--out",
            str(bundle_path),
        ]
    )
    assert exit_code == 0
    export_payload = json.loads(capsys.readouterr().out.strip())
    assert Path(export_payload["out_path"]).exists()

    with tarfile.open(bundle_path, "r") as archive:
        names = sorted(member.name for member in archive.getmembers())
    assert {
        "calib.json",
        "code_hash.txt",
        "model.ts",
        "model_def.json",
        "state_dict.pt",
        "train_meta.json",
        "vocab.json",
    }.issubset(set(names))

    bundle_out = tmp_path / "bundle.csv"
    exit_code = cli.main(
        [
            "infer",
            "--in",
            str(val_dir / "*.csv"),
            "--bundle",
            str(bundle_path),
            "--topk",
            "3",
            "--out",
            str(bundle_out),
        ]
    )
    assert exit_code == 0
    bundle_payload = json.loads(capsys.readouterr().out.strip())
    assert Path(bundle_payload["out_path"]).exists()

    assert baseline_out.read_text(encoding="utf-8") == bundle_out.read_text(encoding="utf-8")
