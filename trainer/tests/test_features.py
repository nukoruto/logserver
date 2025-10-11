# -*- coding: utf-8 -*-
import pandas as pd

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
