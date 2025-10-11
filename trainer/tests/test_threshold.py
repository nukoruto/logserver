"""ΔT しきい値決定ロジックのテスト."""

import math

import pytest

from trainer.logserver.scoring import HierarchicalTauEstimate, TauEstimate, decide_threshold


def _estimate(
    *,
    event_count: int,
    tau_otsu: float,
    should_use_knee: bool,
    tau_knee: float | None = None,
) -> TauEstimate:
    return TauEstimate(
        event_count=event_count,
        tau_otsu=tau_otsu,
        should_use_knee=should_use_knee,
        tau_knee=tau_knee,
    )


def test_decide_threshold_prefers_user_estimate_when_sufficient() -> None:
    stats = HierarchicalTauEstimate(
        user=_estimate(event_count=120, tau_otsu=0.0, should_use_knee=True, tau_knee=1.5),
        group=_estimate(event_count=200, tau_otsu=0.7, should_use_knee=False, tau_knee=None),
        global_=_estimate(event_count=500, tau_otsu=0.5, should_use_knee=False, tau_knee=None),
    )
    threshold = decide_threshold(stats)
    assert math.isclose(threshold, math.exp(1.5))


def test_decide_threshold_backoff_to_group_for_sparse_user() -> None:
    stats = HierarchicalTauEstimate(
        user=_estimate(event_count=10, tau_otsu=0.2, should_use_knee=True, tau_knee=0.1),
        group=_estimate(event_count=70, tau_otsu=0.4, should_use_knee=False, tau_knee=None),
        global_=_estimate(event_count=300, tau_otsu=0.6, should_use_knee=True, tau_knee=0.9),
    )
    threshold = decide_threshold(stats)
    assert math.isclose(threshold, math.exp(0.4))


def test_decide_threshold_backoff_to_global_when_group_unavailable() -> None:
    stats = HierarchicalTauEstimate(
        user=_estimate(event_count=20, tau_otsu=0.3, should_use_knee=False, tau_knee=None),
        group=_estimate(event_count=25, tau_otsu=0.1, should_use_knee=True, tau_knee=0.05),
        global_=_estimate(event_count=600, tau_otsu=0.8, should_use_knee=True, tau_knee=1.0),
    )
    threshold = decide_threshold(stats)
    assert math.isclose(threshold, math.exp(1.0))


def test_decide_threshold_uses_otsu_when_knee_missing() -> None:
    stats = HierarchicalTauEstimate(
        user=_estimate(event_count=100, tau_otsu=0.45, should_use_knee=True, tau_knee=None),
        group=_estimate(event_count=50, tau_otsu=0.5, should_use_knee=True, tau_knee=None),
        global_=_estimate(event_count=80, tau_otsu=0.55, should_use_knee=False, tau_knee=None),
    )
    threshold = decide_threshold(stats)
    assert math.isclose(threshold, math.exp(0.45))


def test_decide_threshold_rejects_non_finite_tau() -> None:
    stats = HierarchicalTauEstimate(
        user=_estimate(event_count=120, tau_otsu=float("nan"), should_use_knee=False, tau_knee=None),
        group=None,
        global_=_estimate(event_count=200, tau_otsu=0.5, should_use_knee=False, tau_knee=None),
    )
    with pytest.raises(ValueError):
        decide_threshold(stats)

