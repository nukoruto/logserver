"""dt-lstm コマンドラインインターフェース。"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Sequence

import torch

from .calibrate import calibrate_temperature
from .engine import DTLSTMEngine
from .fit import FitError, main as fit_main
from .model_def import ModelDefinition, save_definition
from .modules import DeltaTimeModel, DeltaTimeModelConfig
from .train import TrainingConfig, train as train_model

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

    fit_parser = subparsers.add_parser("fit", help="学習データから語彙とメタ情報を推定する")
    fit_parser.add_argument("--in", dest="inputs", nargs="+", required=True, help="入力CSVパス (glob対応)")
    fit_parser.add_argument("--vocab-out", required=True, help="語彙JSONの出力先")
    fit_parser.add_argument("--cfg-out", required=True, help="メタ情報JSONの出力先")
    fit_parser.add_argument("--seed", type=int, default=42, help="乱数シード")

    build_parser = subparsers.add_parser("build", help="モデル定義JSONを生成する")
    build_parser.add_argument("--arch", choices=["lstm", "phased_lstm"], default="lstm", help="シーケンス骨格")
    build_parser.add_argument("--time-head", choices=["regression", "rmtpp"], default="regression", help="時間ヘッドの種類")
    build_parser.add_argument("--vocab-size", type=int, default=512, help="語彙サイズ")
    build_parser.add_argument("--emb-dim", type=int, default=128, help="埋め込み次元")
    build_parser.add_argument("--hidden", type=int, default=128, help="隠れ状態次元")
    build_parser.add_argument("--layers", type=int, default=1, help="層数")
    build_parser.add_argument("--dropout", type=float, default=0.1, help="ドロップアウト率")
    build_parser.add_argument("--numeric-dim", type=int, default=4, help="連続特徴量の次元")
    build_parser.add_argument(
        "--mlp-hidden",
        type=int,
        nargs="*",
        default=[64],
        help="連続特徴MLPの隠れ次元。空リストで恒等射",
    )
    build_parser.add_argument(
        "--mlp-activation",
        choices=["relu", "gelu", "silu"],
        default="gelu",
        help="連続特徴MLPの活性化",
    )
    build_parser.add_argument("--mlp-dropout", type=float, default=0.0, help="連続特徴MLPのドロップアウト")
    build_parser.add_argument("--delta-index", type=int, default=0, help="Δt 列のインデックス")
    build_parser.add_argument("--rmtpp-eps", type=float, default=1e-6, help="RMTPP の w 下限ε")
    build_parser.add_argument("--out", required=True, help="model_def.json の出力先")

    train_parser = subparsers.add_parser("train", help="Δt-aware LSTM を学習する")
    train_parser.add_argument("--train", dest="train", nargs="+", required=True, help="学習用CSVのglobパターン")
    train_parser.add_argument("--val", dest="val", nargs="+", default=None, help="検証用CSVのglobパターン")
    train_parser.add_argument("--numeric-cols", nargs="*", default=["z_clipped", "lburst", "m25", "m50", "m75", "z_deseas", "dt_sec"], help="連続特徴量列名")
    train_parser.add_argument("--delta-col", default="dt_sec", help="Δt 列名")
    train_parser.add_argument("--vocab", default=None, help="dt-lstm fit で生成した語彙JSON")
    train_parser.add_argument("--idle-timeout", type=float, default=1800.0, help="セッション分割のアイドルタイムアウト秒")
    train_parser.add_argument("--arch", choices=["lstm", "phased_lstm"], default="lstm", help="シーケンス骨格")
    train_parser.add_argument("--time-head", choices=["regression", "rmtpp"], default="regression", help="時間予測ヘッド")
    train_parser.add_argument("--time-objective", choices=["l1", "huber", "nll", "rmtpp"], default="l1", help="時間損失関数")
    train_parser.add_argument("--emb-dim", type=int, default=128, help="埋め込み次元")
    train_parser.add_argument("--hidden", type=int, default=128, help="隠れ状態次元")
    train_parser.add_argument("--layers", type=int, default=1, help="LSTM 層数")
    train_parser.add_argument("--dropout", type=float, default=0.1, help="ドロップアウト率")
    train_parser.add_argument("--mlp-hidden", type=int, nargs="*", default=[64], help="連続特徴MLPの隠れ次元")
    train_parser.add_argument("--mlp-activation", choices=["relu", "gelu", "silu"], default="gelu", help="MLP活性化")
    train_parser.add_argument("--mlp-dropout", type=float, default=0.0, help="MLPドロップアウト")
    train_parser.add_argument("--delta-index", type=int, default=0, help="連続特徴中のΔt列インデックス")
    train_parser.add_argument("--rmtpp-eps", type=float, default=1e-6, help="RMTPP eps")
    train_parser.add_argument("--epochs", type=int, default=30, help="エポック数")
    train_parser.add_argument("--bs", type=int, default=64, help="バッチサイズ")
    train_parser.add_argument("--lr", type=float, default=1e-3, help="学習率")
    train_parser.add_argument("--min-lr", type=float, default=1e-5, help="学習率の下限 (cosine 用)")
    train_parser.add_argument("--scheduler", choices=["none", "cosine"], default="none", help="スケジューラ種別")
    train_parser.add_argument("--early", type=int, default=5, help="早期終了の許容エポック")
    train_parser.add_argument("--uncertainty-weight", choices=["on", "off"], default="off", help="不確かさ重み付けの有効化")
    train_parser.add_argument("--amp", choices=["off", "O0", "O1"], default="off", help="AMP モード")
    train_parser.add_argument("--clip-grad", type=float, default=1.0, help="勾配クリッピングの上限")
    train_parser.add_argument("--scheduled-sampling", type=float, default=0.0, help="Scheduled Sampling の確率")
    train_parser.add_argument("--focal-gamma", type=float, default=None, help="Focal Loss の gamma")
    train_parser.add_argument("--label-smoothing", type=float, default=0.0, help="ラベルスムージング率")
    train_parser.add_argument("--class-weights", default=None, help="クラス重みJSONパス")
    train_parser.add_argument("--num-workers", type=int, default=0, help="DataLoader のワーカー数")
    train_parser.add_argument("--seed", type=int, default=42, help="乱数シード")
    train_parser.add_argument("--out", required=True, help="出力ディレクトリ")

    calibrate_parser = subparsers.add_parser(
        "calibrate", help="温度スケーリングで ECE を最小化し、Top-K 被覆を評価する"
    )
    calibrate_parser.add_argument(
        "--val",
        dest="val",
        nargs="+",
        required=True,
        help="検証用特徴量CSVのglobパターン",
    )
    calibrate_parser.add_argument(
        "--ckpt",
        required=True,
        help="学習済みモデルのチェックポイント (model.pt)",
    )
    calibrate_parser.add_argument("--out", required=True, help="温度スケーリング結果JSONの出力先")
    calibrate_parser.add_argument("--batch-size", type=int, default=64, help="評価時のバッチサイズ")
    calibrate_parser.add_argument("--seed", type=int, default=42, help="乱数シード")
    calibrate_parser.add_argument("--bins", type=int, default=15, help="ECE の分割ビン数")
    calibrate_parser.add_argument(
        "--max-k",
        type=int,
        default=10,
        help="被覆–冗長曲線で計算する最大 Top-K",
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

    if args.command == "fit":
        vocab_out = Path(args.vocab_out).expanduser().resolve()
        cfg_out = Path(args.cfg_out).expanduser().resolve()
        try:
            result = fit_main(args.inputs, vocab_out, cfg_out, args.seed)
        except FitError as exc:
            _LOGGER.error("fit.failed", extra={"error": str(exc)})
            return 1
        payload = {
            "event": "fit.completed",
            "num_events": result["num_events"],
            "vocab_size": result["vocab_size"],
            "dt_mean": result["dt_mean"],
            "vocab_path": str(vocab_out),
            "meta_path": str(cfg_out),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "build":
        mlp_hidden = tuple(args.mlp_hidden) if args.mlp_hidden else tuple()
        config = DeltaTimeModelConfig(
            arch=args.arch,
            vocab_size=args.vocab_size,
            embedding_dim=args.emb_dim,
            hidden_size=args.hidden,
            num_layers=args.layers,
            dropout=args.dropout,
            numeric_dim=args.numeric_dim,
            mlp_hidden_dims=mlp_hidden,
            mlp_activation=args.mlp_activation,
            mlp_dropout=args.mlp_dropout,
            time_head=args.time_head,
            delta_index=args.delta_index,
            rmtpp_eps=args.rmtpp_eps,
        )
        model = DeltaTimeModel(config)
        param_count = int(sum(parameter.numel() for parameter in model.parameters()))
        definition = ModelDefinition(
            config=config,
            metadata={
                "param_count": param_count,
                "torch_version": torch.__version__,
            },
        )
        out_path = Path(args.out).expanduser().resolve()
        save_definition(definition, out_path)
        payload = {
            "event": "build.completed",
            "arch": args.arch,
            "time_head": args.time_head,
            "param_count": param_count,
            "out_path": str(out_path),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "train":
        engine = DTLSTMEngine(seed=args.seed)
        runtime = engine.configure()
        output_dir = Path(args.out).expanduser().resolve()
        numeric_cols = list(args.numeric_cols or [])
        if args.delta_col not in numeric_cols:
            numeric_cols = [args.delta_col, *numeric_cols]
        # Preserve order while removing duplicates
        seen = set()
        deduped_numeric = []
        for col in numeric_cols:
            if col in seen:
                continue
            seen.add(col)
            deduped_numeric.append(col)
        numeric_cols = deduped_numeric
        model_cfg = DeltaTimeModelConfig(
            arch=args.arch,
            vocab_size=1,
            embedding_dim=args.emb_dim,
            hidden_size=args.hidden,
            num_layers=args.layers,
            dropout=args.dropout,
            numeric_dim=len(numeric_cols),
            mlp_hidden_dims=tuple(args.mlp_hidden) if args.mlp_hidden else tuple(),
            mlp_activation=args.mlp_activation,
            mlp_dropout=args.mlp_dropout,
            time_head=args.time_head,
            delta_index=args.delta_index,
            rmtpp_eps=args.rmtpp_eps,
        )
        training_cfg = TrainingConfig(
            epochs=args.epochs,
            batch_size=args.bs,
            learning_rate=args.lr,
            min_learning_rate=args.min_lr,
            scheduler=args.scheduler,
            early_stopping=args.early,
            clip_grad=args.clip_grad,
            amp_level=args.amp,
            scheduled_sampling=max(0.0, min(1.0, args.scheduled_sampling)),
            uncertainty_weighting=args.uncertainty_weight == "on",
            focal_gamma=args.focal_gamma,
            label_smoothing=max(0.0, min(1.0, args.label_smoothing)),
            num_workers=args.num_workers,
        )
        class_weights = None
        if args.class_weights:
            class_path = Path(args.class_weights).expanduser().resolve()
            class_weights = json.loads(class_path.read_text(encoding="utf-8"))
        val_patterns = args.val if args.val else None
        time_objective = args.time_objective
        if args.time_head == "rmtpp":
            time_objective = "rmtpp"
        try:
            result = train_model(
                args.train,
                val_patterns=val_patterns,
                numeric_columns=numeric_cols,
                delta_column=args.delta_col,
                vocab_path=Path(args.vocab).expanduser().resolve() if args.vocab else None,
                idle_timeout=float(args.idle_timeout),
                model_config=model_cfg,
                training_config=training_cfg,
                device=runtime.device,
                output_dir=output_dir,
                seed=args.seed,
                time_objective=time_objective,
                class_weights=class_weights,
            )
        except Exception as exc:  # pragma: no cover - ログ出力
            _LOGGER.error("train.failed", extra={"error": str(exc)})
            return 1
        payload = {
            "event": "train.completed",
            "model_path": result["model_path"],
            "optimizer_path": result["optimizer_path"],
            "config_path": result["config_path"],
            "history_path": result["history_path"],
            "best_val_loss": result["best_val_loss"],
            "seed": args.seed,
            "device": str(runtime.device),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "calibrate":
        engine = DTLSTMEngine(seed=args.seed)
        runtime = engine.configure()
        ckpt_path = Path(args.ckpt).expanduser().resolve()
        out_path = Path(args.out).expanduser().resolve()
        result = calibrate_temperature(
            args.val,
            checkpoint_path=ckpt_path,
            output_path=out_path,
            device=runtime.device,
            batch_size=args.batch_size,
            bins=args.bins,
            max_k=args.max_k,
        )
        payload = {
            "event": "calibrate.completed",
            "temperature": result["temperature"],
            "ece_before": result["ece"]["before"],
            "ece_after": result["ece"]["after"],
            "out_path": str(out_path),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI エントリ
    sys.exit(main())
