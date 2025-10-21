"""Utility metrics for robust evaluation."""

from .metrics import (
    AggregatedMetric,
    AggregatorConfig,
    FoldMetric,
    MetricSummary,
    ObjectiveConfig,
    SearchDeviceConfig,
    SearchExecutionConfig,
    TrialStatus,
    compute_aggregate,
    deterministic_hash,
    safe_average_precision,
    safe_f1_at_best_threshold,
    safe_roc_auc,
    select_f1_threshold,
    summarise_metrics,
)

__all__ = [
    "AggregatedMetric",
    "AggregatorConfig",
    "FoldMetric",
    "MetricSummary",
    "ObjectiveConfig",
    "SearchDeviceConfig",
    "SearchExecutionConfig",
    "TrialStatus",
    "compute_aggregate",
    "deterministic_hash",
    "safe_average_precision",
    "safe_f1_at_best_threshold",
    "safe_roc_auc",
    "select_f1_threshold",
    "summarise_metrics",
]
