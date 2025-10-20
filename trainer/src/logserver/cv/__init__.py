"""Cross-validation utilities for rolling-origin splits."""

from .rolling import RollingSplitConfig, generate_rolling_origin_splits

__all__ = [
    "RollingSplitConfig",
    "generate_rolling_origin_splits",
]
