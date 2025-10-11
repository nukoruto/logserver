# -*- coding: utf-8 -*-
import numpy as np
import pandas as pd
import pytest

from trainer.logserver.features import robustZ
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


def test_robust_z_quantiles_align_with_normal_distribution() -> None:
    rng = np.random.default_rng(42)
    users = ["alice", "bob"]
    rows = []
    for user in users:
        samples = np.exp(rng.normal(loc=0.0, scale=0.8, size=512))
        for value in samples:
            rows.append({"user_id": user, "delta_t": float(value)})
    df = pd.DataFrame(rows)

    result = robustZ(df)

    for user in users:
        user_rows = result[result["user_id"] == user]
        assert np.abs(user_rows["z"].median()) < 0.1
        q90 = user_rows["z"].quantile(0.9)
        assert np.isfinite(q90)
        assert q90 == pytest.approx(1.28, abs=0.2)
        assert user_rows["z_clipped"].between(-5.0, 5.0).all()

