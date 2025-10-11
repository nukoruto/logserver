"""Δt セッションしきい値決定ロジック."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional


_MIN_EVENTS_FOR_DIRECT_ESTIMATE = 50


@dataclass(frozen=True)
class TauEstimate:
    """ログ間隔 τ（log Δt）に関する推定値群."""

    event_count: int
    tau_otsu: float
    should_use_knee: bool
    tau_knee: Optional[float] = None

    def select_tau(self) -> float:
        """採用する τ を返す."""

        if self.should_use_knee and self.tau_knee is not None and math.isfinite(self.tau_knee):
            return float(self.tau_knee)
        return float(self.tau_otsu)


@dataclass(frozen=True)
class HierarchicalTauEstimate:
    """ユーザ→集団→全体の階層しきい値候補."""

    user: TauEstimate
    global_: TauEstimate
    group: Optional[TauEstimate] = None

    def select_best_estimate(self) -> TauEstimate:
        """イベント数に応じて最適な推定値を返す."""

        candidates = (
            self.user,
            self.group if self.group is not None else None,
            self.global_,
        )
        for candidate in candidates:
            if candidate is None:
                continue
            if candidate.event_count >= _MIN_EVENTS_FOR_DIRECT_ESTIMATE:
                return candidate
        # すべての候補が閾値未満の場合は優先順位順で最初の非 None を返す
        for candidate in candidates:
            if candidate is not None:
                return candidate
        raise RuntimeError("有効な τ 推定値が存在しません")


def decide_threshold(stats: HierarchicalTauEstimate) -> float:
    """階層 τ 推定値から ΔT_session_max を算出する."""

    tau_source = stats.select_best_estimate()
    tau_final = tau_source.select_tau()
    if not math.isfinite(tau_final):
        raise ValueError("tau_final が有限値ではありません")
    return float(math.exp(tau_final))


__all__ = [
    "TauEstimate",
    "HierarchicalTauEstimate",
    "decide_threshold",
]

