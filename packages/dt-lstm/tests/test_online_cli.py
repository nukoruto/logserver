"""Tests for dt-lstm online CLI."""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")  # noqa: F401

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position
from dt_lstm.modules import DeltaTimeModel, DeltaTimeModelConfig  # noqa: E402  pylint: disable=wrong-import-position
from dt_lstm.online import _solve_tau_for_q, _rmtpp_survival  # noqa: E402  pylint: disable=protected-access,wrong-import-position


def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def test_cli_online_emits_arrival_alarm_with_hysteresis(tmp_path, capsys):
    vocab_path = tmp_path / "vocab.json"
    vocab_payload = {
        "stoi": {
            "<pad>": 0,
            "login": 1,
            "browse": 2,
            "edit": 3,
            "delete": 4,
            "logout": 5,
        },
        "itos": ["<pad>", "login", "browse", "edit", "delete", "logout"],
        "pad_token": "<pad>",
        "oov_token": "<unk>",
    }
    vocab_path.write_text(json.dumps(vocab_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    rows = [
        {
            "timestamp_utc": "2024-01-01T00:00:00Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "login",
            "dt_sec": 0.0,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:01Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "browse",
            "dt_sec": 1.0,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:03Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "edit",
            "dt_sec": 2.0,
        },
        {
            "timestamp_utc": "2024-01-01T00:05:00Z",
            "uid": "u2",
            "session_id": "s2",
            "op_category": "login",
            "dt_sec": 0.0,
        },
        {
            "timestamp_utc": "2024-01-01T00:05:02Z",
            "uid": "u2",
            "session_id": "s2",
            "op_category": "delete",
            "dt_sec": 2.0,
        },
        {
            "timestamp_utc": "2024-01-01T00:05:05Z",
            "uid": "u2",
            "session_id": "s2",
            "op_category": "logout",
            "dt_sec": 3.0,
        },
    ]
    stream_path = data_dir / "stream.csv"
    _write_csv(stream_path, rows)

    model_cfg = DeltaTimeModelConfig(
        arch="lstm",
        vocab_size=6,
        embedding_dim=8,
        hidden_size=8,
        num_layers=1,
        dropout=0.0,
        numeric_dim=1,
        mlp_hidden_dims=tuple(),
        mlp_activation="relu",
        mlp_dropout=0.0,
        time_head="rmtpp",
        delta_index=0,
        rmtpp_eps=1e-6,
    )
    torch.manual_seed(0)
    model = DeltaTimeModel(model_cfg)
    for parameter in model.parameters():
        torch.nn.init.constant_(parameter, 0.0)
    ckpt_dir = tmp_path / "ml" / "checkpoints"
    ckpt_dir.mkdir(parents=True)
    ckpt_path = ckpt_dir / "best.pt"
    torch.save(model.state_dict(), ckpt_path)

    config = {
        "model": model_cfg.to_dict(),
        "training": {
            "epochs": 5,
            "batch_size": 4,
            "learning_rate": 1e-3,
            "min_learning_rate": 1e-5,
            "scheduler": "none",
            "early_stopping": 2,
            "clip_grad": 1.0,
            "amp_level": "off",
            "scheduled_sampling": 0.0,
            "uncertainty_weighting": False,
            "focal_gamma": None,
            "label_smoothing": 0.0,
            "num_workers": 0,
        },
        "data": {
            "files": [str(stream_path)],
            "vocab_size": model_cfg.vocab_size,
            "class_counts": {},
            "dt_stats": {"count": 0.0, "mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0},
            "numeric_dim": model_cfg.numeric_dim,
            "delta_column": "dt_sec",
            "numeric_columns": ["dt_sec"],
            "idle_timeout": 1800.0,
        },
        "seed": 42,
        "device": "cpu",
        "time_objective": "rmtpp",
        "vocab": str(vocab_path),
    }
    (ckpt_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")

    calib_path = tmp_path / "ml" / "artifacts" / "calib.json"
    calib_path.parent.mkdir(parents=True)
    calib_payload = {"temperature": 1.0}
    calib_path.write_text(json.dumps(calib_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    out_path = tmp_path / "out" / "online.csv"
    audit_path = tmp_path / "out" / "audit.jsonl"

    args = [
        "online",
        "--stream",
        str(stream_path),
        "--ckpt",
        str(ckpt_path),
        "--calib",
        str(calib_path),
        "--q",
        "0.1",
        "--kofn",
        "1/2",
        "--hysteresis",
        "1.2",
        "--out",
        str(out_path),
        "--audit",
        str(audit_path),
    ]

    exit_code = cli.main(args)
    assert exit_code == 0
    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["event"] == "online.completed"
    assert payload["events"] == 4
    assert payload["raw_alarms"] == 3
    assert payload["triggers"] == 2

    with out_path.open("r", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        rows_out = list(reader)
    assert len(rows_out) == 4

    tau_q = _solve_tau_for_q(0.0, math.log1p(math.exp(0.0)) + 1e-6, 0.1)
    assert tau_q is not None

    # Step with delta=2.0 (sequence 0, step 1)
    second = rows_out[1]
    assert second["sequence_index"] == "0"
    assert second["step_index"] == "1"
    assert second["raw_alarm"] == "1"
    assert second["alarm_active"] == "1"
    assert math.isclose(float(second["tau_q"]), tau_q, rel_tol=1e-6)
    survival = _rmtpp_survival(0.0, math.log1p(math.exp(0.0)) + 1e-6, 2.0)
    assert math.isclose(float(second["survival"]), survival, rel_tol=1e-6)

    # Deterministic outputs on repeated execution
    csv_bytes_before = out_path.read_bytes()
    audit_bytes_before = audit_path.read_bytes()
    exit_code = cli.main(args)
    assert exit_code == 0
    assert csv_bytes_before == out_path.read_bytes()
    assert audit_bytes_before == audit_path.read_bytes()
