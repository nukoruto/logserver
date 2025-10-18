"""Mathematical unit and property tests for inference utilities."""

from __future__ import annotations

import math
import sys

import pytest
import torch

PACKAGE_SRC = __import__("pathlib").Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from dt_lstm.infer import _chi2_sf, _fisher_statistic, _rmtpp_cdf  # noqa: E402  pylint: disable=protected-access,wrong-import-position
from dt_lstm.modules import RMTPPTimeHead  # noqa: E402  pylint: disable=wrong-import-position


torch = pytest.importorskip("torch")  # type: ignore  # noqa: E305


def test_rmtpp_integral_matches_linear_limit() -> None:
    """極小 w の場合でも積分が exp(g) * delta に収束することを確認する。"""

    head = RMTPPTimeHead(hidden_size=3, eps=1e-9)
    with torch.no_grad():
        head.linear.weight.zero_()
        g_val = 0.25
        raw_w = -20.0  # softplus(raw_w) ≈ 2.06e-9
        head.linear.bias.copy_(torch.tensor([g_val, raw_w], dtype=torch.float32))

    hidden = torch.zeros(1, 4, 3)
    delta = torch.full((1, 4), 3.5, dtype=torch.float32)
    outputs = head(hidden, delta=delta)
    integral = outputs["rmtpp_integral"]
    expected = torch.exp(torch.full((1, 4), g_val)) * delta
    assert torch.allclose(integral, expected, atol=1e-6)


def test_fisher_combination_matches_closed_form() -> None:
    """Fisher 結合統計の生存関数が理論式と一致する。"""

    components = [0.5, 0.2]
    statistic = _fisher_statistic(components)
    assert pytest.approx(statistic, rel=1e-9) == -2.0 * (math.log(0.5) + math.log(0.2))
    chi2 = _chi2_sf(statistic, len(components))
    lambda_val = 0.5 * statistic
    expected = math.exp(-lambda_val) * (1.0 + lambda_val)
    assert math.isclose(chi2, expected, rel_tol=1e-12)


def test_unit_invariance_seconds_vs_milliseconds() -> None:
    """Δt の単位変換で neglog10_p がほぼ変化しない。"""

    top_mass = 0.62
    g_val = 0.1
    w_val = 0.35
    delta_sec = 2.4

    p_time_sec = _rmtpp_cdf(g_val, w_val, delta_sec)
    statistic_sec = _fisher_statistic([top_mass, 1.0 - p_time_sec])
    p_comb_sec = _chi2_sf(statistic_sec, 2)
    neglog_sec = -math.log10(max(p_comb_sec, 1e-300))

    scale = 1000.0
    p_time_ms = _rmtpp_cdf(g_val - math.log(scale), w_val / scale, delta_sec * scale)
    statistic_ms = _fisher_statistic([top_mass, 1.0 - p_time_ms])
    p_comb_ms = _chi2_sf(statistic_ms, 2)
    neglog_ms = -math.log10(max(p_comb_ms, 1e-300))

    assert abs(neglog_sec - neglog_ms) <= 0.02


def test_fisher_statistic_requires_components() -> None:
    """Fisher 結合は入力が空の場合にエラーとなる。"""

    with pytest.raises(Exception):
        _fisher_statistic([])  # type: ignore[arg-type]

    with pytest.raises(Exception):
        _chi2_sf(1.0, 0)
