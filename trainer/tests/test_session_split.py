# -*- coding: utf-8 -*-
from datetime import datetime, timedelta, timezone

import pandas as pd

from trainer.logserver.training.trainer import TrainerConfig, create_session_split


def test_create_session_split_orders_and_partitions() -> None:
    base = datetime(2024, 1, 1, tzinfo=timezone.utc)
    events = [
        ("s5", base + timedelta(minutes=50)),
        ("s1", base + timedelta(minutes=10)),
        ("s3", base + timedelta(minutes=30)),
        ("s2", base + timedelta(minutes=20)),
        ("s4", base + timedelta(minutes=40)),
        ("s2", base + timedelta(minutes=25)),
        ("s1", base + timedelta(minutes=15)),
        ("s5", base + timedelta(minutes=55)),
        ("s6", base + timedelta(minutes=60)),
        ("s7", base + timedelta(minutes=70)),
        ("s8", base + timedelta(minutes=80)),
        ("s9", base + timedelta(minutes=90)),
        ("s10", base + timedelta(minutes=100)),
    ]
    session_ids = [session for session, _ in events]
    timestamps = [ts for _, ts in events]
    config = TrainerConfig(validation_split=0.1, seed=999)
    split = create_session_split(session_ids, timestamps, config)
    expected_order = [
        "s1",
        "s2",
        "s3",
        "s4",
        "s5",
        "s6",
        "s7",
        "s8",
        "s9",
        "s10",
    ]
    assert split.ordered_ids == expected_order
    assert split.train_ids == expected_order[:7]
    assert split.val_ids == expected_order[7:8]
    assert split.test_ids == expected_order[8:]


def test_create_session_split_is_deterministic() -> None:
    session_ids = ["a", "b", "a", "c"]
    timestamps = pd.to_datetime(
        [
            "2024-02-01T00:00:05Z",
            "2024-02-01T00:00:10Z",
            "2024-02-01T00:00:06Z",
            "2024-02-01T00:00:20Z",
        ],
        utc=True,
    ).tolist()
    first_split = create_session_split(session_ids, timestamps, TrainerConfig(seed=1))
    second_split = create_session_split(session_ids, timestamps, TrainerConfig(seed=1234))
    assert first_split == second_split
