"""dt-lstm コマンドラインインターフェース。"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Sequence

from .engine import DTLSTMEngine

_LOGGER = logging.getLogger("dt_lstm.cli")


class _JsonFormatter(logging.Formatter):
    """JSON ロギング用フォーマッタ。"""

    def format(self, record: logging.LogRecord) -> str:  # pragma: no cover - ログ自体は副作用
        payload = {
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key.startswith("_"):
                continue
            if key in {
                "levelname",
                "levelno",
                "name",
                "msg",
                "args",
                "exc_info",
                "exc_text",
                "stack_info",
                "lineno",
                "funcName",
                "created",
                "msecs",
                "relativeCreated",
                "thread",
                "threadName",
                "processName",
                "process",
                "message",
            }:
                continue
            payload[key] = value
        return json.dumps(payload, ensure_ascii=False)


def _configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dt-lstm",
        description="Δt-aware LSTM プロジェクトの雛形を生成し、決定性設定を管理する CLI",
    )
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help="プロジェクト雛形を生成する")
    init_parser.add_argument("--out", required=True, help="出力先ディレクトリ")
    init_parser.add_argument("--preset", default="default", help="利用するテンプレートプリセット")
    init_parser.add_argument("--seed", type=int, default=42, help="乱数シード")
    init_parser.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help="使用デバイス (auto/cpu/cuda)",
    )
    init_parser.add_argument(
        "--gpu-mode",
        choices=["ada6000", "4060"],
        default=None,
        help="GPU_MODE を上書きする場合に指定",
    )
    init_parser.add_argument(
        "--allow-tf32",
        action="store_true",
        help="TF32 を許可する (既定では禁止)",
    )
    init_parser.add_argument(
        "--no-deterministic",
        action="store_true",
        help="決定性設定を無効化する",
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="既存ディレクトリがあっても上書きする",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging()

    if args.command == "init":
        engine = DTLSTMEngine(
            seed=args.seed,
            device=args.device,
            gpu_mode=args.gpu_mode,
            deterministic=not args.no_deterministic,
            allow_tf32=args.allow_tf32,
        )
        out_dir = Path(args.out).expanduser().resolve()
        try:
            runtime = engine.scaffold_project(
                out_dir=out_dir,
                preset=args.preset,
                overwrite=args.force,
            )
        except Exception as exc:  # pragma: no cover - エラー系はロギングのみ
            _LOGGER.error("init.failed", extra={"error": str(exc)})
            return 1

        payload = {
            "event": "init.completed",
            "out_dir": str(out_dir),
            "seed": runtime.seed,
            "device": str(runtime.device),
            "cuda_visible_devices": runtime.cuda_visible_devices,
            "deterministic": runtime.deterministic,
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI エントリ
    sys.exit(main())
