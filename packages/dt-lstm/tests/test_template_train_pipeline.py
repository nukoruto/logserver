from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
TRAINER_SRC = Path(__file__).resolve().parents[3] / "trainer" / "src"

for entry in (PACKAGE_SRC, TRAINER_SRC):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

from dt_lstm.engine import DTLSTMEngine


def test_template_pipeline_produces_artifacts(tmp_path: Path) -> None:
    engine = DTLSTMEngine(seed=123, device="cpu", gpu_mode="cpu")
    project_dir = tmp_path / "proj"
    engine.scaffold_project(out_dir=project_dir, preset="default", overwrite=True)

    processed_dir = project_dir / "data" / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    events_csv = processed_dir / "events.csv"
    rows = [
        "session_id,timestamp_utc,template_id,op_category,z_clipped,lburst,m25,m50,m75,z_deseas,dt_sec,t_i",
        "s1,2024-01-01T00:00:00Z,AUTH::GET::login,AUTH,0.1,0.0,0.0,0.0,0.0,0.1,1.0,0",
        "s1,2024-01-01T00:00:02Z,READ::GET::dashboard,READ,0.2,0.1,0.0,0.1,0.2,0.2,2.0,2",
        "s2,2024-01-01T01:00:00Z,AUTH::GET::login,AUTH,0.3,0.0,0.0,0.0,0.0,0.3,1.5,0",
        "s2,2024-01-01T01:00:03Z,UPDATE::POST::profile,UPDATE,0.4,0.2,0.1,0.3,0.4,0.4,3.0,3",
        "s3,2024-01-01T02:00:00Z,AUTH::GET::login,AUTH,0.5,0.2,0.2,0.2,0.2,0.5,4.0,0",
    ]
    events_csv.write_text("\n".join(rows) + "\n", encoding="utf-8")

    splits_dir = project_dir / "splits"
    splits_dir.mkdir(parents=True, exist_ok=True)
    (splits_dir / "train.txt").write_text("s1\ns2\n", encoding="utf-8")
    (splits_dir / "dev.txt").write_text("s3\n", encoding="utf-8")
    (splits_dir / "test.txt").write_text("s2\n", encoding="utf-8")

    env = os.environ.copy()
    env["GPU_MODE"] = "cpu"
    existing_path = env.get("PYTHONPATH")
    new_path = os.pathsep.join(
        [str(PACKAGE_SRC), str(TRAINER_SRC)]
    )
    env["PYTHONPATH"] = (
        new_path
        if not existing_path
        else f"{new_path}{os.pathsep}{existing_path}"
    )
    command = ["python", "-m", "dt_lstm.scripts.train", "--config", "configs/default.yaml"]

    subprocess.run(command, cwd=project_dir, check=True, env=env)

    artifacts_dir = project_dir / "artifacts" / "runs" / "default"
    expected_files = {
        "model": artifacts_dir / "model.pt",
        "model_last": artifacts_dir / "model_last.pt",
        "history": artifacts_dir / "history.json",
        "metrics": artifacts_dir / "metrics.json",
        "repro": artifacts_dir / "repro.json",
        "bundle": artifacts_dir / "model.tar",
        "vocab": artifacts_dir / "vocab.json",
    }

    for name, path in expected_files.items():
        assert path.exists(), f"missing artifact: {name} -> {path}"

    baseline_hash = hashlib.sha256(expected_files["metrics"].read_bytes()).hexdigest()

    subprocess.run(command, cwd=project_dir, check=True, env=env)
    second_hash = hashlib.sha256(expected_files["metrics"].read_bytes()).hexdigest()
    assert baseline_hash == second_hash
