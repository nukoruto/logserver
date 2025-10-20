"""dt-cv: Deterministic rolling-origin cross-validation orchestrator."""

from .cli import main
from .splitter import RollingOriginSplitConfig, RollingOriginSplitResult

__all__ = [
    "main",
    "RollingOriginSplitConfig",
    "RollingOriginSplitResult",
]
