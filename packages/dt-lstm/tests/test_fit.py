"""Tests for the dt-lstm fit command."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position


def _write_sample_csv(path: Path) -> None:
    header = (
        "op_category,dt_sec,log_dt,z,z_clipped,lburst,m25,m50,m75,z_deseas,sid_final,uid,timestamp_utc\n"
    )
    rows = [
        "AUTH,1.0,0,0,0,0,0,0,0,0,s-1,u-1,2023-01-01T00:00:00Z",
        "READ,2.0,0,0,0,0,0,0,0,0,s-1,u-1,2023-01-01T00:00:02Z",
        "AUTH,1.5,0,0,0,0,0,0,0,0,s-1,u-1,2023-01-01T00:00:03.5Z",
        "UPDATE,3.0,0,0,0,0,0,0,0,0,s-2,u-1,2023-01-01T00:00:06.5Z",
        "AUTH,2.5,0,0,0,0,0,0,0,0,s-3,u-2,2023-01-01T00:00:09Z",
        "DELETE,2.0,0,0,0,0,0,0,0,0,s-3,u-2,2023-01-01T00:00:11Z",
    ]
    path.write_text(header + "\n".join(rows) + "\n", encoding="utf-8")


def test_fit_generates_deterministic_artifacts(tmp_path: Path) -> None:
    csv_path = tmp_path / "train.csv"
    _write_sample_csv(csv_path)

    vocab_path = tmp_path / "ml" / "artifacts" / "vocab.json"
    cfg_path = tmp_path / "ml" / "artifacts" / "train_meta.json"

    args = [
        "fit",
        "--in",
        str(csv_path),
        "--vocab-out",
        str(vocab_path),
        "--cfg-out",
        str(cfg_path),
        "--seed",
        "2025",
    ]

    exit_code = cli.main(args)
    assert exit_code == 0

    first_vocab = vocab_path.read_bytes()
    first_meta = cfg_path.read_bytes()

    # Re-run to ensure outputs are deterministic
    exit_code = cli.main(args)
    assert exit_code == 0
    assert vocab_path.read_bytes() == first_vocab
    assert cfg_path.read_bytes() == first_meta

    vocab_payload = json.loads(first_vocab.decode("utf-8"))
    assert vocab_payload["stoi"]["<pad>"] == 0
    assert vocab_payload["stoi"]["<unk>"] == 1
    assert vocab_payload["stoi"]["AUTH"] == 2
    assert vocab_payload["frequency"]["AUTH"] == 3
    assert vocab_payload["topk_candidates"] == [3, 5]

    meta_payload = json.loads(first_meta.decode("utf-8"))
    assert meta_payload["seed"] == 2025
    assert meta_payload["data"]["num_events"] == 6
    assert meta_payload["model"]["embedding"]["dim"] == 32
    assert meta_payload["model"]["hidden"]["size"] == 64
    assert meta_payload["model"]["regularization"]["dropout"] == pytest.approx(0.1)
    assert meta_payload["model"]["loss"]["time"]["uncertainty_weighting"]["enabled"] is False
    assert meta_payload["model"]["calibration"]["topk"] == [3, 5]
    assert meta_payload["model"]["rmtpp"]["w_init"]["trainable"] == pytest.approx(-1.548, rel=1e-3)
    assert meta_payload["model"]["rmtpp"]["bias_init"]["trainable"] == pytest.approx(-0.693, rel=1e-3)
