"""Feature engineering utilities for the trainer package."""

from .robust import RobustDeltaStats, robustZ, summarize_stats

__all__ = ["robustZ", "summarize_stats", "RobustDeltaStats"]

