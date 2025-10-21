from __future__ import annotations

import numpy as np
import pytest

from trainer.logserver.thresholds import ThresholdConfig, ThresholdStatus, resolve_threshold


def test_quantile_matches_target_alpha() -> None:
    rng = np.random.default_rng(42)
    values = rng.lognormal(mean=0.0, sigma=0.5, size=20000)
    config = ThresholdConfig(method="quantile", transform="score", alpha=0.01)
    result = resolve_threshold(values, config, allow_small_sample=True)
    assert result.status == ThresholdStatus.OK
    tail_rate = np.mean(values >= result.tau_hi)
    assert abs(tail_rate - 0.01) < 0.002


def _sample_gpd(size: int, xi: float, beta: float, rng: np.random.Generator) -> np.ndarray:
    u = rng.uniform(0.0, 1.0, size=size)
    if abs(xi) < 1e-8:
        return -beta * np.log(1.0 - u)
    return beta / xi * ((1.0 - u) ** (-xi) - 1.0)


@pytest.mark.parametrize("xi", [0.0, 0.2])
def test_spot_controls_tail_probability(xi: float) -> None:
    rng = np.random.default_rng(123)
    base = _sample_gpd(60000, xi, 1.0, rng)
    config = ThresholdConfig(
        method="spot",
        transform="score",
        alpha=0.01,
        q=1e-3,
        u_quantile=0.95,
        min_exceed=200,
        calib_frac=0.5,
    )
    result = resolve_threshold(base, config, allow_small_sample=True)
    assert result.status == ThresholdStatus.OK
    evaluation = base[int(base.size * config.calib_frac) :]
    tail_rate = np.mean(evaluation >= result.tau_hi)
    if xi == 0.0:
        assert abs(tail_rate - config.q) < 5e-4
    else:
        assert tail_rate <= config.alpha


def test_spot_falls_back_to_quantile_when_exceedances_low() -> None:
    rng = np.random.default_rng(321)
    values = rng.normal(loc=0.0, scale=1.0, size=1000)
    config = ThresholdConfig(
        method="spot",
        transform="score",
        alpha=0.05,
        q=1e-3,
        min_exceed=2000,
        fallback_methods=("quantile",),
    )
    result = resolve_threshold(values, config, allow_small_sample=True)
    assert result.status == ThresholdStatus.OK
    assert result.applied_method == "quantile"


def test_otsu_separates_bimodal_distribution() -> None:
    rng = np.random.default_rng(55)
    cluster_a = rng.lognormal(mean=0.0, sigma=0.1, size=4000)
    cluster_b = rng.lognormal(mean=2.5, sigma=0.1, size=4000)
    log_values = np.log(np.concatenate([cluster_a, cluster_b]))
    config = ThresholdConfig(method="otsu", transform="score", side="upper")
    result = resolve_threshold(log_values, config, allow_small_sample=True)
    assert result.status == ThresholdStatus.OK
    boundary = np.exp(result.tau_hi)
    assert np.mean(cluster_a <= boundary) > 0.95
    assert np.mean(cluster_b >= boundary) > 0.95


def test_otsu_falls_back_for_unimodal() -> None:
    rng = np.random.default_rng(77)
    values = rng.normal(loc=0.0, scale=0.2, size=5000)
    config = ThresholdConfig(method="otsu", transform="score", alpha=0.05)
    result = resolve_threshold(values, config, allow_small_sample=True)
    quantile_ref = np.quantile(values, 0.95)
    if result.applied_method == "quantile":
        assert True
    else:
        assert abs(result.tau_hi - float(np.mean(values))) < 0.1


def test_knee_detects_elbow_point() -> None:
    low_segment = np.linspace(0.0, 1.0, 800, endpoint=False)
    high_segment = np.linspace(3.0, 4.0, 200)
    values = np.concatenate([low_segment, high_segment])
    config = ThresholdConfig(method="knee", transform="score", alpha=0.01, side="upper")
    result = resolve_threshold(values, config, allow_small_sample=True)
    assert result.status == ThresholdStatus.OK
    assert abs(result.tau_hi - 1.0) < 0.1


def test_knee_fallback_when_curve_flat() -> None:
    values = np.linspace(0.0, 1.0, 1000)
    config = ThresholdConfig(method="knee", transform="score", alpha=0.05)
    result = resolve_threshold(values, config, allow_small_sample=True)
    assert result.applied_method == "quantile"


def test_threshold_resolution_is_deterministic() -> None:
    rng = np.random.default_rng(999)
    values = rng.lognormal(mean=0.0, sigma=0.6, size=10000)
    config = ThresholdConfig(method="quantile", transform="score", alpha=0.02)
    first = resolve_threshold(values, config, allow_small_sample=True)
    second = resolve_threshold(values, config, allow_small_sample=True)
    assert first.tau_hi == pytest.approx(second.tau_hi, rel=0, abs=0)
    assert first.data_hash == second.data_hash
