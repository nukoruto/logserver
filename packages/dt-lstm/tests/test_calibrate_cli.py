from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")  # noqa: F401 - インポート成否でスキップ

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position
from dt_lstm.modules import DeltaTimeModel, DeltaTimeModelConfig  # noqa: E402  pylint: disable=wrong-import-position


def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    headers = list(rows[0].keys())
    lines = [",".join(headers)]
    for row in rows:
        values = [str(row[column]) for column in headers]
        lines.append(",".join(values))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_cli_calibrate_generates_deterministic_artifact(tmp_path, capsys):
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

    val_dir = tmp_path / "data"
    val_dir.mkdir()
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
    val_path = val_dir / "val.csv"
    _write_csv(val_path, rows)

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
        time_head="regression",
        delta_index=0,
        rmtpp_eps=1e-6,
    )
    torch.manual_seed(1234)
    model = DeltaTimeModel(model_cfg)
    for parameter in model.parameters():
        torch.nn.init.normal_(parameter, mean=0.0, std=0.05)
    ckpt_dir = tmp_path / "ml" / "checkpoints"
    ckpt_dir.mkdir(parents=True)
    ckpt_path = ckpt_dir / "best.pt"
    torch.save(model.state_dict(), ckpt_path)

    config = {
        "model": model_cfg.to_dict(),
        "training": {
            "epochs": 10,
            "batch_size": 4,
            "learning_rate": 1e-3,
            "min_learning_rate": 1e-5,
            "scheduler": "none",
            "early_stopping": 3,
            "clip_grad": 1.0,
            "amp_level": "off",
            "scheduled_sampling": 0.0,
            "uncertainty_weighting": False,
            "focal_gamma": None,
            "label_smoothing": 0.0,
            "num_workers": 0,
        },
        "data": {
            "files": [str(val_path)],
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
        "time_objective": "l1",
        "vocab": str(vocab_path),
    }
    config_path = ckpt_dir / "config.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")

    out_path = tmp_path / "ml" / "artifacts" / "calib.json"
    args = [
        "calibrate",
        "--val",
        str(val_path),
        "--ckpt",
        str(ckpt_path),
        "--out",
        str(out_path),
        "--batch-size",
        "2",
    ]
    exit_code = cli.main(args)
    assert exit_code == 0
    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["event"] == "calibrate.completed"
    assert payload["temperature"] > 0

    artifact = json.loads(out_path.read_text(encoding="utf-8"))
    assert artifact["ece"]["after"] <= artifact["ece"]["before"]
    assert "k3" in artifact["coverage"]["comparison"]
    assert artifact["coverage"]["comparison"]["k3"]["k"] == 3

    before = out_path.read_bytes()
    exit_code = cli.main(args)
    assert exit_code == 0
    after = out_path.read_bytes()
    assert before == after, "calibration artifact must be deterministic"
