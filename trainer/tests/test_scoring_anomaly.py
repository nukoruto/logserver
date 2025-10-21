import numpy as np
import pandas as pd

from trainer.logserver.features.encoders import build_feature_pack, encode_dataframe
from trainer.logserver.scoring.anomaly import AnomalyScorer, ScoringConfig, _moving_average
from trainer.logserver.training.trainer import TrainerConfig, create_session_split, fit_model


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


def test_anomaly_scores_deterministic() -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "logout", "login", "view", "logout"],
            "delta_t": [0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
            "latency_ms": [100, 110, 105, 98, 102, 99],
            "status": [200, 200, 200, 200, 200, 200],
            "session_id": ["a", "a", "a", "b", "b", "b"],
            "timestamp": pd.to_datetime(
                [
                    "2024-01-01T00:00:00Z",
                    "2024-01-01T00:01:00Z",
                    "2024-01-01T00:02:00Z",
                    "2024-01-02T00:00:00Z",
                    "2024-01-02T00:01:00Z",
                    "2024-01-02T00:02:00Z",
                ],
                utc=True,
            ),
        }
    )
    session_ids = df["session_id"].astype(str).tolist()
    trainer_config = TrainerConfig(max_epochs=2, batch_size=1, target_mode="next")
    split = create_session_split(session_ids, df["timestamp"].tolist(), trainer_config)
    train_df = df[df["session_id"].isin(split.train_ids)]
    feature_pack = build_feature_pack(train_df, extra_features=None)
    encoded = encode_dataframe(df, feature_pack)
    model, _, _, _, _ = fit_model(encoded, session_ids, feature_pack, trainer_config, split=split)
    scorer = AnomalyScorer(model, feature_pack, ScoringConfig(device="cpu", smoothing_window=3), target_mode="next")
    first = scorer.score(encoded, session_ids)
    second = scorer.score(encoded, session_ids)
    assert first.keys() == second.keys()
    for key in first:
        assert np.allclose(first[key], second[key])
