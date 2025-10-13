# -*- coding: utf-8 -*-
"""Synthetic log generator for experimentation."""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

EVENT_VOCAB = ["login", "view", "edit", "save", "logout"]
ANOMALOUS_EVENTS = ["force_logout", "token_reuse", "suspicious_post"]


@dataclass
class ScenarioConfig:
    seed: int = 42
    normal_sessions: int = 100
    anomalous_sessions: int = 20
    base_dt_seconds: Sequence[int] = (2, 5, 8, 13)
    anomaly_dt_multiplier: float = 12.0


def _random_metadata(rng: random.Random) -> Dict[str, str]:
    return {
        "user_agent": rng.choice([
            "Mozilla/5.0",
            "Chrome/126.0",
            "Edge/125.0",
            "Safari/17.0",
        ]),
        "referrer": rng.choice([
            "https://example.com",
            "https://internal.local/dashboard",
            "",
        ]),
    }


def _generate_session(
    rng: random.Random, uid: str, base_ts: datetime, length: int, anomalous: bool
) -> List[Dict[str, object]]:
    events: List[Dict[str, object]] = []
    timestamp = base_ts
    for idx in range(length):
        event = rng.choice(EVENT_VOCAB)
        if anomalous and idx == length - 2:
            event = rng.choice(ANOMALOUS_EVENTS)
        latency = rng.randint(20, 400)
        status = rng.choice([200, 200, 200, 500]) if anomalous and idx == length - 1 else 200
        event_record = {
            "timestamp": timestamp.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
            "session_id": f"{uid}-{base_ts.timestamp():.0f}",
            "uid": uid,
            "event": event,
            "latency_ms": latency,
            "status": status,
            "metadata": _random_metadata(rng),
        }
        events.append(event_record)
        delta = rng.choice([timedelta(seconds=s) for s in (2, 4, 7, 9)])
        if anomalous and idx >= length // 2:
            delta *= ScenarioConfig().anomaly_dt_multiplier
        timestamp += delta
    return events


def generate_dataset(config: ScenarioConfig) -> List[Dict[str, object]]:
    rng = random.Random(config.seed)
    events: List[Dict[str, object]] = []
    now = datetime.now(timezone.utc)
    for session_idx in range(config.normal_sessions):
        uid = f"user-{session_idx % 10}"
        base_ts = now + timedelta(minutes=session_idx)
        events.extend(_generate_session(rng, uid, base_ts, rng.randint(5, 8), anomalous=False))
    for session_idx in range(config.anomalous_sessions):
        uid = f"user-anom-{session_idx % 5}"
        base_ts = now + timedelta(minutes=10 + session_idx)
        events.extend(_generate_session(rng, uid, base_ts, rng.randint(5, 8), anomalous=True))
    events.sort(key=lambda item: item["timestamp"])
    return events


def write_dataset(events: Iterable[Dict[str, object]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Generate synthetic session logs for experimentation")
    parser.add_argument("--output", default="data/raw/synth_logs.jsonl", help="Output JSON Lines file")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--normal", type=int, default=100, help="Number of normal sessions")
    parser.add_argument("--anomalous", type=int, default=20, help="Number of anomalous sessions")
    args = parser.parse_args()

    config = ScenarioConfig(
        seed=args.seed,
        normal_sessions=args.normal,
        anomalous_sessions=args.anomalous,
    )
    events = generate_dataset(config)
    write_dataset(events, Path(args.output))


if __name__ == "__main__":  # pragma: no cover
    main()
