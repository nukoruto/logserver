# -*- coding: utf-8 -*-
"""Utilities for batching variable-length sessions."""

from __future__ import annotations

import itertools
import random
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, Iterator, List, MutableSequence, Optional, Sequence, Tuple

import numpy as np
import torch
from torch.utils.data import IterableDataset, get_worker_info

PAD_INDEX = 0


@dataclass
class SessionExample:
    event_ids: np.ndarray
    numeric: np.ndarray
    target_event: np.ndarray


@dataclass(frozen=True)
class SessionSlice:
    """Lightweight descriptor of a session slice within an encoded store."""

    key: str
    start: int
    stop: int

    def indices(self) -> slice:
        return slice(self.start, self.stop)


SessionLoader = Callable[[SessionSlice], SessionExample]


class SessionDataset(IterableDataset[SessionExample]):
    """Iterable dataset that materialises sessions on demand."""

    def __init__(
        self,
        slices: Sequence[SessionSlice],
        loader: SessionLoader,
        *,
        shuffle: bool = False,
        seed: Optional[int] = None,
    ):
        self._slices: List[SessionSlice] = list(slices)
        self._loader = loader
        self._shuffle = shuffle
        self._seed = seed

    def __iter__(self) -> Iterator[SessionExample]:
        worker = get_worker_info()
        slices: MutableSequence[SessionSlice]
        if worker is not None:
            slices = list(self._slices[worker.id :: worker.num_workers])
            worker_seed = (self._seed or 0) + worker.id
        else:
            slices = list(self._slices)
            worker_seed = self._seed
        if self._shuffle and len(slices) > 1:
            rng = random.Random(worker_seed)
            rng.shuffle(slices)
        for descriptor in slices:
            yield self._loader(descriptor)

    def __len__(self) -> int:  # pragma: no cover - optional optimisation
        return len(self._slices)

    @classmethod
    def from_encoded(
        cls,
        encoded: Dict[str, np.ndarray | SessionLoader | Callable[[slice], np.ndarray]],
        slices: Sequence[SessionSlice],
        numeric_keys: Sequence[str],
        *,
        shuffle: bool = False,
        seed: Optional[int] = None,
    ) -> "SessionDataset":
        loader = create_array_session_loader(encoded, numeric_keys)
        return cls(slices, loader, shuffle=shuffle, seed=seed)


def collate_examples(batch: Iterable[SessionExample]) -> Dict[str, torch.Tensor]:
    batch = list(batch)
    lengths = [example.event_ids.shape[0] for example in batch]
    max_len = max(lengths)

    event_tensor = torch.full((len(batch), max_len), PAD_INDEX, dtype=torch.long)
    numeric_tensor = torch.zeros(len(batch), max_len, batch[0].numeric.shape[1], dtype=torch.float32)
    target_tensor = torch.full((len(batch), max_len), PAD_INDEX, dtype=torch.long)
    mask_tensor = torch.zeros(len(batch), max_len, dtype=torch.bool)

    for row, example in enumerate(batch):
        length = example.event_ids.shape[0]
        event_tensor[row, :length] = torch.from_numpy(example.event_ids)
        numeric_tensor[row, :length] = torch.from_numpy(example.numeric)
        target_tensor[row, :length] = torch.from_numpy(example.target_event)
        mask_tensor[row, :length] = True

    return {
        "events": event_tensor,
        "numeric": numeric_tensor,
        "targets": target_tensor,
        "mask": mask_tensor,
    }


def build_sessions(
    encoded: Dict[str, np.ndarray | Callable[[slice], np.ndarray]],
    session_ids: Sequence[str],
    numeric_keys: Sequence[str] | None = None,
) -> Tuple[List[SessionSlice], List[str], List[str]]:
    if any(len(encoded[key]) != len(session_ids) for key in _array_like_keys(encoded)):
        raise ValueError("Encoded feature lengths must match session identifiers")
    base_keys = ["delta_t", "latency", "status"]
    ordered_numeric = [key for key in (numeric_keys or base_keys) if key in encoded]
    if not ordered_numeric:
        ordered_numeric = [key for key in base_keys if key in encoded]
    if "delta_t" not in ordered_numeric:
        raise ValueError("delta_t must be present in numeric feature set")
    slices: List[SessionSlice] = []
    unique_keys: List[str] = []
    for key, group in itertools.groupby(enumerate(session_ids), key=lambda item: item[1]):
        start: Optional[int] = None
        stop: Optional[int] = None
        for index, _ in group:
            if start is None:
                start = index
            stop = index
        if start is None or stop is None:
            continue
        slices.append(SessionSlice(key=str(key), start=start, stop=stop + 1))
        unique_keys.append(str(key))
    return slices, unique_keys, ordered_numeric


def create_array_session_loader(
    encoded: Dict[str, np.ndarray | Callable[[slice], np.ndarray]],
    numeric_keys: Sequence[str],
) -> SessionLoader:
    array_fetchers = {
        name: (value if callable(value) else _build_array_fetcher(value))
        for name, value in encoded.items()
    }

    def _load(slice_descriptor: SessionSlice) -> SessionExample:
        session_slice = slice_descriptor.indices()
        events = np.array(array_fetchers["event_id"](session_slice), dtype=np.int64, copy=True)
        target_source = array_fetchers.get("target_event", array_fetchers["event_id"])
        targets = np.array(target_source(session_slice), dtype=np.int64, copy=True)
        numeric_columns = [
            np.array(array_fetchers[name](session_slice), dtype=np.float32, copy=True)
            for name in numeric_keys
        ]
        numeric = np.column_stack(numeric_columns) if numeric_columns else np.zeros((len(events), 0), dtype=np.float32)
        return SessionExample(event_ids=events, numeric=numeric, target_event=targets)

    return _load


def _array_like_keys(
    encoded: Dict[str, np.ndarray | Callable[[slice], np.ndarray]]
) -> Iterable[str]:  # pragma: no cover - helper for readability
    for key, value in encoded.items():
        if callable(value):
            continue
        yield key


def _build_array_fetcher(array: np.ndarray) -> Callable[[slice], np.ndarray]:
    def _fetch(slice_obj: slice) -> np.ndarray:
        return array[slice_obj]

    return _fetch
