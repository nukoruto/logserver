# -*- coding: utf-8 -*-
"""Case level report generation for anomalies."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List


@dataclass
class CaseRecord:
    session_id: str
    timestamp: str
    anomaly_score: float
    delta_t: float
    event: str


def build_case_records(rows: Iterable[Dict[str, object]]) -> List[CaseRecord]:
    records: List[CaseRecord] = []
    for row in rows:
        records.append(
            CaseRecord(
                session_id=str(row.get("session_id")),
                timestamp=str(row.get("timestamp")),
                anomaly_score=float(row.get("anomaly_score", 0.0)),
                delta_t=float(row.get("delta_t", 0.0)),
                event=str(row.get("event")),
            )
        )
    return records


def export_case_report(records: List[CaseRecord], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "case_report.json"
    csv_path = output_dir / "case_report.csv"
    with json_path.open("w", encoding="utf-8") as handle:
        json.dump([record.__dict__ for record in records], handle, ensure_ascii=False, indent=2)
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(records[0].__dict__.keys())) if records else csv.DictWriter(handle, fieldnames=["session_id", "timestamp", "anomaly_score", "delta_t", "event"])
        writer.writeheader()
        for record in records:
            writer.writerow(record.__dict__)
