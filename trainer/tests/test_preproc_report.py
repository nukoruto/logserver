# -*- coding: utf-8 -*-
import json
from pathlib import Path
from typing import Iterable

import pandas as pd

from trainer.logserver.dataio.sessionize import SessionConfig, load_events, sessionize
from trainer.logserver.eval.preproc_report import generate_preproc_report
from trainer.scripts import preprocess as preprocess_cli


def test_generate_preproc_report(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.csv"
    df = pd.DataFrame(
        {
            "timestamp": [
                "2024-01-01T00:00:00Z",
                "2024-01-01T00:00:05Z",
                "2024-01-01T00:00:08Z",
                "2024-01-01T00:00:16Z",
            ],
            "uid": ["u1", "u1", "u2", "u2"],
            "event": ["login", "view", "login", "logout"],
            "latency_ms": [100, 120, 80, 90],
            "response_bytes": [512, 256, 128, 64],
        }
    )
    df.to_csv(raw_path, index=False)

    before = load_events(raw_path)
    processed = sessionize(raw_path, tmp_path, SessionConfig(), raw_df=before)

    report_path = tmp_path / "preproc_report.json"
    report = generate_preproc_report(before, processed, report_path, sample_size=2)

    assert report_path.exists()
    with report_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    assert payload["summary"]["row_counts"]["before"] == len(before)
    assert payload["summary"]["row_counts"]["after"] == len(processed)
    assert "delta_t" in payload["summary"]["numeric_stats"]["after"]
    assert payload["summary"]["unit_invariance"]["passed"] is True
    assert len(payload["samples"]) <= 2
    assert all(sample["rows"] for sample in payload["samples"])
    assert report == payload


def test_collect_rows_limit_handling() -> None:
    frames = [
        pd.DataFrame({"value": [1, 2, 3]}),
        pd.DataFrame({"value": [4, 5]}),
    ]

    def generator() -> Iterable[pd.DataFrame]:
        for frame in frames:
            yield frame

    empty = preprocess_cli._collect_rows(generator(), 0)
    assert empty.empty

    unlimited = preprocess_cli._collect_rows(generator(), None)
    assert len(unlimited) == sum(len(frame) for frame in frames)
    assert unlimited.iloc[0]["value"] == 1
