"""Golden regression tests for CLI outputs."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import pytest

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm import cli  # noqa: E402  pylint: disable=wrong-import-position
from dt_lstm.modules import DeltaTimeModel, DeltaTimeModelConfig  # noqa: E402  pylint: disable=wrong-import-position


torch = pytest.importorskip("torch")  # type: ignore  # noqa: E305

EXPECTED_SCORED = (
    "sequence_index,step_index,source,session_id,uid,timestamp,target_id,target_token,delta,censored,topk_mass,p_ev,p_time,fisher_"
    "statistic,combined_p,neglog10_p,rmtpp_g,rmtpp_w,topk_hit,topk_rank\r\n"
    "0,0,/workspace/logserver/tmp_golden/data/test.csv,s1,u1,2024-01-01T00:00:01+00:00,2,browse,1.0,0,0.3333333433,0.6666666567,0."
    "7637101045,5.082616232,0.278925116506,0.5545123768,0.0,0.6931481957,0,\r\n"
    "0,1,/workspace/logserver/tmp_golden/data/test.csv,s1,u1,2024-01-01T00:00:03+00:00,3,edit,2.0,0,0.3333333433,0.6666666567,0.986"
    "8072851,10.8534055188,0.028261886669,1.5487988495,0.0,0.6931481957,1,1\r\n"
    "1,0,/workspace/logserver/tmp_golden/data/test.csv,s2,u2,2024-01-01T00:05:02+00:00,4,delete,2.0,0,0.3333333433,0.6666666567,0.98"
    "68072851,10.8534055188,0.028261886669,1.5487988495,0.0,0.6931481957,0,\r\n"
    "1,1,/workspace/logserver/tmp_golden/data/test.csv,s2,u2,2024-01-01T00:05:05+00:00,5,logout,3.0,0,0.3333333433,0.6666666567,0.99"
    "99588746,22.3949958094,0.000167208827,3.776740799,0.0,0.6931481957,1,2\r\n"
)

EXPECTED_AUDIT = (
    '{"censored": false, "combined_p": 0.278925116506, "delta": 1.0, "g": 0.0, "neglog10_p": 0.5545123768, "p_ev": 0.6666666567, '
    '"p_time": 0.7637101045, "rmtpp_g": 0.0, "rmtpp_w": 0.6931481957, "sequence": 0, "statistic": 5.082616232, "step": 0, "target_'
    'id": 2, "target_token": "browse", "topk": [{"id": 3, "prob": 0.1666666716, "rank": 1, "token": "edit"}, {"id": 5, "prob": '
    '0.1666666716, "rank": 2, "token": "logout"}], "topk_hit": false, "topk_mass": 0.3333333433, "topk_rank": null, "w": 0.6931'
    "481957}\n"
    '{"censored": false, "combined_p": 0.028261886669, "delta": 2.0, "g": 0.0, "neglog10_p": 1.5487988495, "p_ev": 0.6666666567, '
    '"p_time": 0.9868072851, "rmtpp_g": 0.0, "rmtpp_w": 0.6931481957, "sequence": 0, "statistic": 10.8534055188, "step": 1, "target_'
    'id": 3, "target_token": "edit", "topk": [{"id": 3, "prob": 0.1666666716, "rank": 1, "token": "edit"}, {"id": 5, "prob": '
    '0.1666666716, "rank": 2, "token": "logout"}], "topk_hit": true, "topk_mass": 0.3333333433, "topk_rank": 1, "w": 0.6931481'
    "957}\n"
    '{"censored": false, "combined_p": 0.028261886669, "delta": 2.0, "g": 0.0, "neglog10_p": 1.5487988495, "p_ev": 0.6666666567, '
    '"p_time": 0.9868072851, "rmtpp_g": 0.0, "rmtpp_w": 0.6931481957, "sequence": 1, "statistic": 10.8534055188, "step": 0, "target_'
    'id": 4, "target_token": "delete", "topk": [{"id": 3, "prob": 0.1666666716, "rank": 1, "token": "edit"}, {"id": 5, "prob": '
    '0.1666666716, "rank": 2, "token": "logout"}], "topk_hit": false, "topk_mass": 0.3333333433, "topk_rank": null, "w": 0.6931'
    "481957}\n"
    '{"censored": false, "combined_p": 0.000167208827, "delta": 3.0, "g": 0.0, "neglog10_p": 3.776740799, "p_ev": 0.6666666567, '
    '"p_time": 0.9999588746, "rmtpp_g": 0.0, "rmtpp_w": 0.6931481957, "sequence": 1, "statistic": 22.3949958094, "step": 1, "target_'
    'id": 5, "target_token": "logout", "topk": [{"id": 3, "prob": 0.1666666716, "rank": 1, "token": "edit"}, {"id": 5, "prob": '
    '0.1666666716, "rank": 2, "token": "logout"}], "topk_hit": true, "topk_mass": 0.3333333433, "topk_rank": 2, "w": 0.6931481'
    "957}\n"
)

EXPECTED_METRICS = (
    '{\n  "artifacts": {\n    "calibration_png": "/workspace/logserver/tmp_golden/out/metrics_calibration.png",\n    "pr_curve_png": '
    '"/workspace/logserver/tmp_golden/out/metrics_pr_curve.png"\n  },\n  "counts": {\n    "anomaly_segments": 1,\n    "detected_segments": '
    '1,\n    "events": 4,\n    "positive_events": 1,\n    "predicted_positive_events": 1\n  },\n  "generated_at": "2024-01-01T00:00:00'
    'Z",\n  "metrics": {\n    "auroc": 1.0,\n    "average_detection_delay_sec": 3.0,\n    "ece": 0.66609597533225,\n    "f1": 1.0,\n    "rmtpp_'
    'negloglik": 3.663144234279794,\n    "topk_accuracy": 0.5\n  },\n  "threshold": {\n    "decision_threshold": 3.776740799,\n    "source": '
    '"optimal_f1"\n  },\n  "version": "1.0"\n}\n'
)


def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def test_infer_and_eval_match_golden(tmp_path: Path, capsys) -> None:
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
            "time_censored": 0,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:01Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "browse",
            "dt_sec": 1.0,
            "time_censored": 0,
        },
        {
            "timestamp_utc": "2024-01-01T00:00:03Z",
            "uid": "u1",
            "session_id": "s1",
            "op_category": "edit",
            "dt_sec": 2.0,
            "time_censored": 0,
        },
        {
            "timestamp_utc": "2024-01-01T00:05:00Z",
            "uid": "u2",
            "session_id": "s2",
            "op_category": "login",
            "dt_sec": 0.0,
            "time_censored": 0,
        },
        {
            "timestamp_utc": "2024-01-01T00:05:02Z",
            "uid": "u2",
            "session_id": "s2",
            "op_category": "delete",
            "dt_sec": 2.0,
            "time_censored": 0,
        },
        {
            "timestamp_utc": "2024-01-01T00:05:05Z",
            "uid": "u2",
            "session_id": "s2",
            "op_category": "logout",
            "dt_sec": 3.0,
            "time_censored": 0,
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
        "2",
        "--out",
        str(out_path),
        "--audit",
        str(audit_path),
    ]
    exit_code = cli.main(args)
    assert exit_code == 0
    capsys.readouterr()

    scored_bytes = out_path.read_bytes()
    audit_bytes = audit_path.read_bytes()

    ground_truth = tmp_path / "ground.csv"
    gt_rows = [
        {"timestamp_utc": "2024-01-01T00:00:00Z", "uid": "u1", "session_id": "s1", "anomaly_label": 0},
        {"timestamp_utc": "2024-01-01T00:00:01Z", "uid": "u1", "session_id": "s1", "anomaly_label": 0},
        {"timestamp_utc": "2024-01-01T00:00:03Z", "uid": "u1", "session_id": "s1", "anomaly_label": 1},
        {"timestamp_utc": "2024-01-01T00:05:00Z", "uid": "u2", "session_id": "s2", "anomaly_label": 0},
        {"timestamp_utc": "2024-01-01T00:05:02Z", "uid": "u2", "session_id": "s2", "anomaly_label": 1},
        {"timestamp_utc": "2024-01-01T00:05:05Z", "uid": "u2", "session_id": "s2", "anomaly_label": 1},
    ]
    _write_csv(ground_truth, gt_rows)

    metrics_path = tmp_path / "out" / "metrics.json"
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.write_text(json.dumps({"generated_at": "2024-01-01T00:00:00Z"}, ensure_ascii=False), encoding="utf-8")
    eval_args = [
        "eval",
        "--in",
        str(ground_truth),
        "--scored",
        str(out_path),
        "--out",
        str(metrics_path),
        "--bins",
        "5",
    ]
    exit_code = cli.main(eval_args)
    assert exit_code == 0
    capsys.readouterr()

    metrics_bytes = metrics_path.read_bytes()

    base_path = str(tmp_path).replace("\\", "/")
    scored_text = scored_bytes.decode("utf-8").replace("\\", "/").replace(base_path, "/workspace/logserver/tmp_golden")
    audit_text = audit_bytes.decode("utf-8").replace("\\", "/").replace(base_path, "/workspace/logserver/tmp_golden")
    metrics_text = metrics_bytes.decode("utf-8").replace("\\", "/").replace(base_path, "/workspace/logserver/tmp_golden")

    assert scored_text == EXPECTED_SCORED
    assert audit_text == EXPECTED_AUDIT
    assert metrics_text == EXPECTED_METRICS
