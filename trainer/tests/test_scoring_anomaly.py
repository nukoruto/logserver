import numpy as np

from trainer.logserver.scoring.anomaly import _moving_average


def test_moving_average_returns_original_for_small_window() -> None:
    values = np.array([0.5, 1.0, 2.5], dtype=np.float64)
    result_window_one = _moving_average(values, 1)
    result_large_window = _moving_average(values, 5)
    assert np.array_equal(result_window_one, values)
    assert np.array_equal(result_large_window, values)


def test_moving_average_applies_smoothing() -> None:
    values = np.array([0.0, 1.0, 2.0, 3.0], dtype=np.float64)
    smoothed = _moving_average(values, 3)
    expected = np.array([0.0, 1.0 / 3.0, 1.0, 2.0], dtype=np.float64)
    assert smoothed.shape == values.shape
    assert np.allclose(smoothed, expected)
