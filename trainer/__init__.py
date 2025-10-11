"""Trainer package bootstrap ensuring src/ modules are discoverable."""

from __future__ import annotations

from pathlib import Path

_SRC_DIR = Path(__file__).resolve().parent / "src"
if _SRC_DIR.is_dir():
    # Prepend src directory so `trainer.logserver` resolves to trainer/src/logserver
    __path__.insert(0, str(_SRC_DIR))  # type: ignore[name-defined]
