# -*- coding: utf-8 -*-
"""Simple baseline models for comparison."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Dict, List

import numpy as np


@dataclass
class NGramBaseline:
    order: int = 1

    def fit(self, sequences: List[List[int]]) -> None:
        self.counts: Dict[tuple, Counter] = {}
        for seq in sequences:
            for idx in range(len(seq) - self.order):
                context = tuple(seq[idx : idx + self.order])
                target = seq[idx + self.order]
                self.counts.setdefault(context, Counter())[target] += 1

    def predict_proba(self, context: List[int], vocab_size: int) -> np.ndarray:
        context = tuple(context[-self.order :]) if context else tuple([0] * self.order)
        counter = self.counts.get(context)
        probs = np.ones(vocab_size, dtype=np.float32) / vocab_size
        if counter:
            total = sum(counter.values())
            for token, count in counter.items():
                probs[token] = count / total
        return probs
