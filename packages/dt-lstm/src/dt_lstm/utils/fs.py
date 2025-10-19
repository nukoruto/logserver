"""Filesystem helpers with deterministic semantics."""

from __future__ import annotations

from pathlib import Path


def ensure_dir(path: str | Path) -> Path:
    """Ensure that *path* exists as a directory and return it as :class:`Path`.

    The helper is idempotent and can be safely invoked for already-existing
    directories. Relative paths are resolved to the absolute path based on the
    current working directory so that logs contain fully qualified locations.
    """

    target = Path(path).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    return target
