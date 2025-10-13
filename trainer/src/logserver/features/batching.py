# -*- coding: utf-8 -*-
"""Utilities for batching variable-length sessions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np
import torch
from torch.utils.data import Dataset

PAD_INDEX = 0


@dataclass
class SessionExample:
    event_ids: np.ndarray
    numeric: np.ndarray
    target_event: np.ndarray


class SessionDataset(Dataset[SessionExample]):
    def __init__(self, sessions: Sequence[Dict[str, np.ndarray]]):
        self.sessions = sessions

    def __len__(self) -> int:
        return len(self.sessions)

    def __getitem__(self, index: int) -> SessionExample:
        session = self.sessions[index]
        if isinstance(session, SessionExample):
            return session
        return SessionExample(
            event_ids=session["event_ids"],
            numeric=session["numeric"],
            target_event=session["target_event"],
        )


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
    encoded: Dict[str, np.ndarray],
    session_ids: Sequence[str],
    numeric_keys: Sequence[str] | None = None,
) -> Tuple[List[Dict[str, np.ndarray]], List[str]]:
    sessions: List[Dict[str, np.ndarray]] = []
    session_keys: List[str] = []
    current_session = None
    buffer: Dict[str, List] = {
        "event_ids": [],
        "numeric": [],
        "target_event": [],
    }
    base_keys = ["delta_t", "latency", "status"]
    ordered_numeric = [key for key in (numeric_keys or base_keys) if key in encoded]
    if not ordered_numeric:
        ordered_numeric = [key for key in base_keys if key in encoded]
    if "delta_t" not in ordered_numeric:
        raise ValueError("delta_t must be present in numeric feature set")
    for index, session_id in enumerate(session_ids):
        if current_session is None:
            current_session = session_id
        if session_id != current_session:
            sessions.append({
                "event_ids": np.asarray(buffer["event_ids"], dtype=np.int64),
                "numeric": np.asarray(buffer["numeric"], dtype=np.float32),
                "target_event": np.asarray(buffer["target_event"], dtype=np.int64),
            })
            session_keys.append(current_session)
            buffer = {"event_ids": [], "numeric": [], "target_event": []}
            current_session = session_id
        buffer["event_ids"].append(int(encoded["event_id"][index]))
        buffer["numeric"].append([float(encoded[key][index]) for key in ordered_numeric])
        buffer["target_event"].append(int(encoded["event_id"][index]))
    if buffer["event_ids"]:
        sessions.append({
            "event_ids": np.asarray(buffer["event_ids"], dtype=np.int64),
            "numeric": np.asarray(buffer["numeric"], dtype=np.float32),
            "target_event": np.asarray(buffer["target_event"], dtype=np.int64),
        })
        session_keys.append(current_session if current_session is not None else "session-0")
    return sessions, session_keys
