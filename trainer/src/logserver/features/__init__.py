"""Feature engineering utilities for the trainer package."""

from .robust import RobustDeltaStats, choose_epsilon, robustZ, summarize_stats

__all__ = ["choose_epsilon", "robustZ", "summarize_stats", "RobustDeltaStats"]

