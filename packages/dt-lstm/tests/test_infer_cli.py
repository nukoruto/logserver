"""Tests for dt-lstm infer command."""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import pytest
import yaml

torch = pytest.importorskip("torch")  # noqa: F401

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position
from dt_lstm.infer import _chi2_sf, _fisher_statistic, _rmtpp_cdf  # noqa: E402  pylint: disable=protected-access,wrong-import-position
from dt_lstm.modules import DeltaTimeModel, DeltaTimeModelConfig  # noqa: E402  pylint: disable=wrong-import-position


def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def test_cli_infer_produces_fisher_combined_scores(tmp_path, capsys):
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
    data_path = data_dir / "test.csv"
    _write_csv(data_path, rows)

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
            "files": [str(data_path)],
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
    calib_payload = {
        "temperature": 1.0,
        "ece": {"before": 0.1, "after": 0.1, "bins": 10},
        "coverage": {"selected_k": 2, "coverage_rate": 0.8, "curve": [], "comparison": {}},
    }
    calib_path.write_text(json.dumps(calib_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    cfg_path = tmp_path / "infer_config.yaml"
    cfg_payload = {"inference": {"topk": 2}}
    cfg_path.write_text(yaml.safe_dump(cfg_payload), encoding="utf-8")

    out_path = tmp_path / "out" / "scores.csv"
    audit_path = tmp_path / "out" / "audit.jsonl"

    args = [
        "infer",
        "--test",
        str(data_path),
        "--model",
        str(ckpt_path),
        "--calib",
        str(calib_path),
        "--topk",
        "2",
        "--out",
        str(out_path),
        "--audit",
        str(audit_path),
        "--cfg",
        str(cfg_path),
    ]
    exit_code = cli.main(args)
    assert exit_code == 0
    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["event"] == "infer.completed"
    assert payload["config_source"] == str(cfg_path.resolve())
    assert payload["events"] == 4

    with out_path.open("r", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        rows_out = list(reader)
    assert len(rows_out) == 4
    first = rows_out[0]
    assert first["target_token"] == "browse"
    assert math.isclose(float(first["topk_mass"]), 2.0 / 6.0, rel_tol=1e-6)
    expected_p_ev = 1.0 - (2.0 / 6.0)
    assert math.isclose(float(first["p_ev"]), expected_p_ev, rel_tol=1e-6)
    g_val = 0.0
    w_val = math.log(1 + math.exp(0.0)) + 1e-6
    delta = 1.0
    p_time = _rmtpp_cdf(g_val, w_val, delta)
    assert math.isclose(float(first["p_time"]), p_time, rel_tol=1e-6)
    statistic = _fisher_statistic([2.0 / 6.0, 1.0 - p_time])
    expected_combined = _chi2_sf(statistic, 2)
    assert math.isclose(float(first["fisher_statistic"]), statistic, rel_tol=1e-6)
    assert math.isclose(float(first["combined_p"]), expected_combined, rel_tol=1e-6)
    assert "rmtpp_g" in first
    assert "rmtpp_w" in first
    assert "topk_hit" in first
    assert first["topk_hit"] in {"0", "1"}
    assert "topk_rank" in first

    audit_lines = audit_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(audit_lines) == 4
    record = json.loads(audit_lines[0])
    assert len(record["topk"]) == 2
    for item in record["topk"]:
        assert math.isclose(float(item["prob"]), 1.0 / 6.0, rel_tol=1e-6)
    assert record["target_token"] == "browse"
    assert "rmtpp_g" in record
    assert "rmtpp_w" in record
    assert "topk_hit" in record
    assert isinstance(record["topk_hit"], bool)

    # Deterministic outputs
    csv_bytes_before = out_path.read_bytes()
    audit_bytes_before = audit_path.read_bytes()
    exit_code = cli.main(args)
    assert exit_code == 0
    assert csv_bytes_before == out_path.read_bytes()
    assert audit_bytes_before == audit_path.read_bytes()


def test_cli_infer_ignores_time_component_when_censored(tmp_path, capsys):
    vocab_path = tmp_path / "vocab.json"
    vocab_payload = {
        "stoi": {"<pad>": 0, "login": 1, "browse": 2, "edit": 3},
        "itos": ["<pad>", "login", "browse", "edit"],
        "pad_token": "<pad>",
        "oov_token": "<unk>",
    }
    vocab_path.write_text(json.dumps(vocab_payload, ensure_ascii=False), encoding="utf-8")

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    rows = [
        {
            "timestamp_utc": "2024-01-01T00:00:00Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "login",
            "dt_sec": 0.0,
            "time_censored": 0,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:01Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "browse",
            "dt_sec": 1.0,
            "time_censored": 1,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:04Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "edit",
            "dt_sec": 3.0,
            "time_censored": 0,
        },
    ]
    data_path = data_dir / "test.csv"
    _write_csv(data_path, rows)

    model_cfg = DeltaTimeModelConfig(
        arch="lstm",
        vocab_size=4,
        embedding_dim=4,
        hidden_size=4,
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
    torch.manual_seed(7)
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
            "epochs": 1,
            "batch_size": 2,
            "learning_rate": 1e-3,
            "min_learning_rate": 1e-5,
            "scheduler": "none",
            "early_stopping": 1,
            "clip_grad": 1.0,
            "amp_level": "off",
            "scheduled_sampling": 0.0,
            "uncertainty_weighting": False,
            "focal_gamma": None,
            "label_smoothing": 0.0,
            "num_workers": 0,
        },
        "data": {
            "files": [str(data_path)],
            "vocab_size": model_cfg.vocab_size,
            "class_counts": {},
            "dt_stats": {"count": 0.0, "mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0},
            "numeric_dim": model_cfg.numeric_dim,
            "delta_column": "dt_sec",
            "numeric_columns": ["dt_sec"],
            "idle_timeout": 1800.0,
        },
        "seed": 123,
        "device": "cpu",
        "time_objective": "rmtpp",
        "vocab": str(vocab_path),
    }
    (ckpt_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

    calib_path = tmp_path / "ml" / "artifacts" / "calib.json"
    calib_path.parent.mkdir(parents=True)
    calib_payload = {"temperature": 1.0, "ece": {"before": 0.0, "after": 0.0, "bins": 10}, "coverage": {"selected_k": None, "coverage_rate": None, "curve": [], "comparison": {}}}
    calib_path.write_text(json.dumps(calib_payload, ensure_ascii=False), encoding="utf-8")

    out_path = tmp_path / "out" / "scores.csv"
    audit_path = tmp_path / "out" / "audit.jsonl"

    args = [
        "infer",
        "--in",
        str(data_path),
        "--ckpt",
        str(ckpt_path),
        "--calib",
        str(calib_path),
        "--topk",
        "1",
        "--out",
        str(out_path),
        "--audit",
        str(audit_path),
    ]

    exit_code = cli.main(args)
    assert exit_code == 0
    capsys.readouterr()

    with out_path.open("r", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        outputs = list(reader)

    assert len(outputs) == 2
    first = outputs[0]
    assert first["censored"] == "1"
    assert first["p_time"] == ""
    top_mass = float(first["topk_mass"])
    statistic = -2.0 * math.log(max(top_mass, 1e-12))
    expected = _chi2_sf(statistic, 1)
    assert math.isclose(float(first["combined_p"]), expected, rel_tol=1e-9)
    assert math.isclose(float(first["combined_p"]), top_mass, rel_tol=1e-9)
    assert math.isclose(float(first["neglog10_p"]), -math.log10(top_mass), rel_tol=1e-9)

    audit_lines = audit_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(audit_lines) == 2
    entry = json.loads(audit_lines[0])
    assert entry["censored"] is True
    assert entry["p_time"] is None
