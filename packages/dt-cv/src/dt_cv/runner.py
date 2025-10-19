"""Subprocess orchestration helpers for dt-cv."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, MutableMapping, Sequence

from .artifacts import ArtifactLogger, CommandRecord, relative_outputs


@dataclass
class CommandSpec:
    """Specification of a command to execute."""

    name: str
    argv: Sequence[str]
    cwd: Path
    env: Mapping[str, str]
    outputs: Mapping[str, Path]


def build_deterministic_env(seed: int, gpu_mode: str | None) -> MutableMapping[str, str]:
    """Construct deterministic environment overrides."""

    env = {
        "PYTHONHASHSEED": str(seed),
        "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
        "CUDA_LAUNCH_BLOCKING": "1",
        "CUDNN_DETERMINISTIC": "1",
        "CUDNN_BENCHMARK": "0",
        "TF_CPP_MIN_LOG_LEVEL": "3",
        "NVIDIA_TF32_OVERRIDE": "0",
        "DT_GLOBAL_SEED": str(seed),
    }
    if gpu_mode:
        env["GPU_MODE"] = gpu_mode
        if gpu_mode == "ada6000":
            env["CUDA_VISIBLE_DEVICES"] = "0"
        elif gpu_mode == "4060":
            env["CUDA_VISIBLE_DEVICES"] = "1"
    return env


def run_command(spec: CommandSpec) -> int:
    """Run the command and log artifacts."""

    full_env = os.environ.copy()
    for key, value in spec.env.items():
        full_env[key] = value
    logger = ArtifactLogger(spec.cwd, spec.env)
    result = subprocess.run(list(spec.argv), cwd=spec.cwd, env=full_env, check=False)
    record = CommandRecord(
        name=spec.name,
        argv=[str(arg) for arg in spec.argv],
        returncode=result.returncode,
        outputs=relative_outputs(spec.cwd, spec.outputs),
    )
    logger.append(record)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, spec.argv)
    return result.returncode
