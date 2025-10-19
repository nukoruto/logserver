# -*- coding: utf-8 -*-
import numpy as np
import pandas as pd
import pytest

from trainer.logserver.features import (
    RobustDeltaStats,
    choose_epsilon,
    robustZ,
    summarize_stats,
)
from trainer.logserver.features.encoders import build_feature_pack, encode_dataframe


def test_encode_dataframe_returns_arrays() -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "view", "logout"],
            "delta_t": [0.0, 1.0, 2.0, 1.0],
            "latency_ms": [100, 120, 110, 90],
            "status": [200, 200, 200, 200],
        }
    )
    pack = build_feature_pack(df)
    encoded = encode_dataframe(df, pack)
    assert encoded["event_id"].shape[0] == len(df)
    assert encoded["delta_t"].shape[0] == len(df)
    assert 1e-6 <= pack.delta_epsilon <= 1e-2
    assert "response_bytes" not in pack.numeric_features


def test_build_feature_pack_accepts_template_only() -> None:
    df = pd.DataFrame(
        {
            "template_id": [
                "AUTH::GET::login",
                "READ::GET::dashboard",
                "AUTH::POST::logout",
            ],
            "delta_t": [0.0, 5.0, 7.0],
            "latency_ms": [120, 130, 110],
            "status": [200, 200, 200],
        }
    )
    pack = build_feature_pack(df)
    encoded = encode_dataframe(df, pack)
    assert encoded["event_id"].shape[0] == len(df)
    assert pack.event_vocab.to_index("AUTH::GET::login") != pack.event_vocab.to_index("<unk>")


def test_encode_dataframe_with_optional_response_bytes() -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "logout"],
            "delta_t": [0.0, 1.5, 0.5],
            "latency_ms": [100, 95, 90],
            "status": [200, 200, 200],
            "response_bytes": [512, 1024, 256],
        }
    )
    pack = build_feature_pack(df)
    encoded = encode_dataframe(df, pack)
    assert "response_bytes" in pack.numeric_features
    assert "response_bytes" in encoded
    assert encoded["response_bytes"].shape[0] == len(df)


def test_build_feature_pack_enables_dt_features_when_present() -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "view", "logout", "view"],
            "delta_t": [0.0, 1.0, 1.0, 2.0],
            "latency_ms": [100, 110, 95, 105],
            "status": [200, 200, 200, 200],
            "delta_robust_z": [0.0, 0.5, -0.5, 1.0],
            "delta_z_deseas_clipped": [0.0, 0.4, -0.3, 0.9],
            "delta_log_burst": [0.0, 0.1, -0.2, 0.3],
            "delta_q25": [0.1, 0.2, 0.2, 0.3],
            "delta_q50": [0.2, 0.3, 0.3, 0.4],
            "delta_q75": [0.4, 0.5, 0.5, 0.6],
        }
    )
    pack = build_feature_pack(df, extra_features=["dt"])
    expected = {"z", "z_deseas", "lburst", "m25", "m50", "m75"}
    assert expected.issubset(set(pack.numeric_features))
    encoded = encode_dataframe(df, pack)
    for feature in expected:
        assert feature in encoded
        assert encoded[feature].shape[0] == len(df)


def test_build_feature_pack_dt_missing_columns_falls_back() -> None:
    df = pd.DataFrame(
        {
            "event": ["login", "logout"],
            "delta_t": [0.0, 1.0],
            "latency_ms": [100, 120],
            "status": [200, 200],
        }
    )
    pack = build_feature_pack(df, extra_features=["dt"])
    dt_keys = {"z", "z_deseas", "lburst", "m25", "m50", "m75"}
    assert dt_keys.isdisjoint(set(pack.numeric_features))


def test_choose_epsilon_quantile_and_clipping() -> None:
    positives = [1e-5, 5e-5, 1e-4, 2e-4]
    eps = choose_epsilon(positives)
    expected = 0.5 * np.quantile(np.array(positives), 0.05)
    assert eps == pytest.approx(max(1e-6, min(expected, 1e-2)))

    # When only non-positive values are present the lower clip should be used.
    assert choose_epsilon([0.0, 0.0]) == 1e-6


def test_robust_z_quantiles_align_with_normal_distribution() -> None:
    rng = np.random.default_rng(42)
    users = ["alice", "bob"]
    rows = []
    for user in users:
        samples = np.exp(rng.normal(loc=0.0, scale=0.8, size=512))
        for value in samples:
            rows.append({"uid": user, "delta_t": float(value)})
    df = pd.DataFrame(rows)

    result = robustZ(df)

    for user in users:
        user_rows = result[result["uid"] == user]
        assert np.abs(user_rows["z"].median()) < 0.1
        q90 = user_rows["z"].quantile(0.9)
        assert np.isfinite(q90)
        assert q90 == pytest.approx(1.28, abs=0.2)
        assert user_rows["z_clipped"].between(-5.0, 5.0).all()


def test_robust_z_unit_invariance_between_seconds_and_milliseconds() -> None:
    rng = np.random.default_rng(17)
    seconds = rng.lognormal(mean=-4.5, sigma=0.6, size=1024)
    df_seconds = pd.DataFrame({"uid": ["u"] * len(seconds), "delta_t": seconds})
    z_seconds = robustZ(df_seconds, unit_scale=1.0)

    milliseconds = seconds * 1e3
    df_ms = pd.DataFrame({"uid": ["u"] * len(milliseconds), "delta_t": milliseconds})
    z_ms = robustZ(df_ms, unit_scale=1e-3)

    quantiles = np.linspace(0.05, 0.95, 19)
    z_seconds_quant = np.quantile(z_seconds["z"].to_numpy(), quantiles)
    z_ms_quant = np.quantile(z_ms["z"].to_numpy(), quantiles)
    max_diff = np.max(np.abs(z_seconds_quant - z_ms_quant))
    assert max_diff <= 0.02


def test_summarize_stats_returns_dataclasses() -> None:
    df = pd.DataFrame(
        {
            "uid": ["alice", "alice", "bob", "bob"],
            "delta_t": [0.2, 0.4, 0.3, 0.6],
        }
    )
    z_df = robustZ(df)
    summary = summarize_stats(z_df)

    assert len(summary) == 2
    assert all(isinstance(item, RobustDeltaStats) for item in summary)

    alice_stats = summary[0]
    alice_rows = z_df[z_df["uid"] == "alice"].iloc[0]
    assert alice_stats.uid == "alice"
    assert alice_stats.median_log_delta == pytest.approx(alice_rows["median_log_delta"])
    assert alice_stats.mad_log_delta == pytest.approx(alice_rows["mad_log_delta"])
    assert alice_stats.sigma_r == pytest.approx(alice_rows["sigma_r"])

    bob_stats = summary[1]
    assert bob_stats.uid == "bob"
    assert bob_stats.sigma_r > 0


def test_summarize_stats_requires_complete_columns() -> None:
    df = pd.DataFrame(
        {
            "uid": ["u1"],
            "median_log_delta": [0.1],
            "mad_log_delta": [0.01],
            "sigma_r": [0.02],
        }
    )
    with pytest.raises(ValueError, match="Missing columns required for summary"):
        summarize_stats(df.drop(columns=["mad_log_delta"]))

