"""Configuration dataclasses for dt-cv."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Mapping, MutableMapping, Optional


@dataclass
class RollingOriginSplitConfig:
    """Parameters controlling rolling-origin splits."""

    input_path: Path
    output_dir: Path
    session_column: str
    timestamp_column: str
    label_column: Optional[str]
    train_size: int
    val_size: int
    test_size: int
    step_size: int
    purge_count: int
    embargo_count: int
    max_folds: Optional[int]
    seed: int

    def validate(self) -> None:
        if self.train_size <= 0:
            raise ValueError("train_size must be positive")
        if self.val_size <= 0:
            raise ValueError("val_size must be positive")
        if self.step_size <= 0:
            raise ValueError("step_size must be positive")
        if self.purge_count < 0:
            raise ValueError("purge_count must be non-negative")
        if self.embargo_count < 0:
            raise ValueError("embargo_count must be non-negative")
        if self.test_size < 0:
            raise ValueError("test_size must be non-negative")
        if self.max_folds is not None and self.max_folds <= 0:
            raise ValueError("max_folds must be positive when provided")


@dataclass
class FoldPaths:
    """Convenience container for fold resource paths."""

    raw_train: Path
    raw_validation: Path
    raw_test: Optional[Path]
    features_train: Path
    features_validation: Path
    features_test: Optional[Path]
    preproc_stats: Path
    preproc_meta: Path
    anomaly_stats: Path
    anomaly_meta: Path
    anomaly_scores_validation: Path
    anomaly_scores_test: Optional[Path]
    lstm_dir: Path
    lstm_validation_scores: Path
    lstm_test_scores: Optional[Path]
    fisher_validation_scores: Path
    fisher_test_scores: Optional[Path]
    metrics_validation: Path
    metrics_test: Optional[Path]


@dataclass
class FoldDefinition:
    """Fold membership description."""

    fold_id: int
    train_sessions: List[str]
    validation_sessions: List[str]
    test_sessions: List[str]
    purge_count: int
    embargo_count: int
    paths: FoldPaths


@dataclass
class RollingOriginSplitResult:
    """Result payload persisted to splits.yaml."""

    version: int
    seed: int
    input_path: str
    session_column: str
    timestamp_column: str
    label_column: Optional[str]
    params: Mapping[str, int]
    folds: List[MutableMapping[str, object]] = field(default_factory=list)

    def to_mapping(self) -> Mapping[str, object]:
        return {
            "version": self.version,
            "seed": self.seed,
            "input_path": self.input_path,
            "session_column": self.session_column,
            "timestamp_column": self.timestamp_column,
            "label_column": self.label_column,
            "params": dict(self.params),
            "folds": [dict(fold) for fold in self.folds],
        }


def ensure_list(value: Iterable[str]) -> List[str]:
    """Materialize iterable of strings as list."""

    return [str(item) for item in value]
