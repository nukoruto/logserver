"""dt-lstm コマンドラインインターフェース。"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

import torch
import yaml

from .calibrate import CalibrationError, calibrate_temperature
from .engine import DTLSTMEngine
from .export import DEFAULT_ALGO_VERSION, ExportError, export_bundle
from .fit import FitError, main as fit_main
from .infer import InferenceError, run_inference
from .model_def import ModelDefinition, save_definition
from .modules import DeltaTimeModel, DeltaTimeModelConfig
from .online import OnlineError, run_online_stream
from .eval import EvaluationError, evaluate
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


def _parse_kofn(spec: str) -> tuple[int, int]:
    try:
        numerator, denominator = spec.split("/", 1)
        k_value = int(numerator.strip())
        n_value = int(denominator.strip())
    except Exception as exc:  # pragma: no cover - defensive branch
        raise ValueError("K-of-N は 'K/N' 形式で指定してください") from exc
    if k_value <= 0 or n_value <= 0:
        raise ValueError("K と N は正の整数で指定してください")
    if k_value > n_value:
        raise ValueError("K は N 以下である必要があります")
    return k_value, n_value


def _load_yaml_config(path: Path) -> Mapping[str, Any]:
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ValueError(f"設定ファイルが見つかりません: {path}") from exc
    try:
        data = yaml.safe_load(content) or {}
    except yaml.YAMLError as exc:  # pragma: no cover - 例外系
        raise ValueError(f"設定ファイルの解析に失敗しました: {path}: {exc}") from exc
    if not isinstance(data, Mapping):
        raise ValueError("設定ファイルのルート要素はマッピングである必要があります")
    return data


def _optional_sequence(value: Any, desc: str) -> Optional[Sequence[Any]]:
    if value is None:
        return None
    if isinstance(value, (str, bytes)):
        raise ValueError(f"{desc} は配列形式で指定してください")
    if isinstance(value, Sequence):
        return value
    raise ValueError(f"{desc} は配列形式で指定してください")


def _optional_int(value: Any, desc: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{desc} は整数で指定してください")
    try:
        return int(value)
    except Exception as exc:  # pragma: no cover - 異常入力
        raise ValueError(f"{desc} は整数で指定してください") from exc


def _optional_float(value: Any, desc: str) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{desc} は数値で指定してください")
    try:
        return float(value)
    except Exception as exc:  # pragma: no cover - 異常入力
        raise ValueError(f"{desc} は数値で指定してください") from exc


def _optional_str(value: Any, desc: str) -> Optional[str]:
    if value is None:
        return None
    try:
        return str(value)
    except Exception as exc:  # pragma: no cover - 異常入力
        raise ValueError(f"{desc} は文字列で指定してください") from exc


def _coerce_bool(value: Any, desc: str, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "on", "1"}:
            return True
        if lowered in {"false", "no", "off", "0"}:
            return False
    raise ValueError(f"{desc} は真偽値で指定してください")


def _resolve_model_paths(*, ckpt: Optional[str], bundle: Optional[str], model: Optional[str]) -> tuple[Optional[Path], Optional[Path]]:
    ckpt_path = Path(ckpt).expanduser().resolve() if ckpt else None
    bundle_path = Path(bundle).expanduser().resolve() if bundle else None
    if model:
        candidate = Path(model).expanduser().resolve()
        if candidate.suffix.lower() == ".tar":
            if bundle_path is not None or ckpt_path is not None:
                raise ValueError("checkpoint/bundle と model を同時指定できません")
            bundle_path = candidate
        else:
            if ckpt_path is not None or bundle_path is not None:
                raise ValueError("checkpoint/bundle と model を同時指定できません")
            ckpt_path = candidate
    if ckpt_path is not None and bundle_path is not None:
        raise ValueError("checkpoint と bundle は同時指定できません")
    return ckpt_path, bundle_path


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
    train_parser.add_argument("--val", "--dev", dest="val", nargs="+", default=None, help="検証用CSVのglobパターン")
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
    train_parser.add_argument("--cfg", default=None, help="YAML 設定ファイル")

    calibrate_parser = subparsers.add_parser(
        "calibrate", help="温度スケーリングで ECE を最小化し、Top-K 被覆を評価する"
    )
    calibrate_parser.add_argument(
        "--val",
        "--dev",
        dest="val",
        nargs="+",
        required=True,
        help="検証用特徴量CSVのglobパターン",
    )
    source_group = calibrate_parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument(
        "--ckpt",
        help="学習済みモデルのチェックポイント (model.pt)",
    )
    source_group.add_argument("--bundle", dest="bundle", help="dt-lstm export で生成したバンドルtar")
    source_group.add_argument(
        "--model",
        dest="model",
        help="チェックポイント (model.pt) またはバンドル (model.tar)",
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
    calibrate_parser.add_argument("--cfg", default=None, help="YAML 設定ファイル")

    export_parser = subparsers.add_parser("export", help="学習済みチェックポイントを単一tarにバンドルする")
    export_parser.add_argument("--ckpt", required=True, help="学習済みモデルのチェックポイント (model.pt)")
    export_parser.add_argument("--vocab", default=None, help="語彙JSONのパス")
    export_parser.add_argument("--calib", default=None, help="温度スケーリングJSONのパス")
    export_parser.add_argument("--meta", default=None, help="train_meta.json のパス")
    export_parser.add_argument(
        "--algo-ver",
        default=DEFAULT_ALGO_VERSION,
        help="互換性管理用のアルゴリズムバージョン",
    )
    export_parser.add_argument("--out", required=True, help="出力tarパス")

    infer_parser = subparsers.add_parser("infer", help="Δt-aware LSTM でバッチ推論を実行する")
    infer_parser.add_argument("--in", "--test", dest="inputs", nargs="+", required=True, help="入力CSVパス (glob対応)")
    source_group = infer_parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--ckpt", help="学習済みモデルのチェックポイント (model.pt)")
    source_group.add_argument("--bundle", dest="bundle", help="dt-lstm export で生成したバンドルtar")
    source_group.add_argument(
        "--model",
        dest="model",
        help="チェックポイント (model.pt) またはバンドル (model.tar)",
    )
    infer_parser.add_argument(
        "--calib",
        default=None,
        help="温度スケーリングJSONのパス (bundle 指定時はバンドル内を使用)",
    )
    infer_parser.add_argument("--topk", type=int, default=5, help="Top-K 被覆で利用するK")
    infer_parser.add_argument("--out", required=True, help="スコアCSVの出力先")
    infer_parser.add_argument("--audit", default=None, help="監査JSONLの出力先")
    infer_parser.add_argument("--seed", type=int, default=42, help="乱数シード")
    infer_parser.add_argument("--cfg", default=None, help="YAML 設定ファイル")

    online_parser = subparsers.add_parser(
        "online", help="Δt-aware LSTM によるオンライン到着前アラーム監視を実行する"
    )
    online_parser.add_argument("--stream", required=True, help="疑似ストリームCSVのパス")
    online_parser.add_argument("--ckpt", required=True, help="学習済みモデルのチェックポイント (model.pt)")
    online_parser.add_argument("--calib", default=None, help="温度スケーリングJSONのパス")
    online_parser.add_argument("--q", type=float, required=True, help="生存関数が下回る監視閾値 q")
    online_parser.add_argument(
        "--kofn",
        required=True,
        help="K-of-N 条件 (例: 2/5)",
    )
    online_parser.add_argument(
        "--hysteresis",
        type=float,
        default=1.1,
        help="ヒステリシス比 H (>1)。解除条件は s_evt ≤ 1/H",
    )
    online_parser.add_argument("--out", required=True, help="オンライン監視結果CSVの出力先")
    online_parser.add_argument("--audit", default=None, help="監査JSONLの出力先")
    online_parser.add_argument("--seed", type=int, default=42, help="乱数シード")

    eval_parser = subparsers.add_parser("eval", help="スコアCSVを評価して指標を算出する")
    eval_parser.add_argument("--in", dest="inputs", nargs="+", required=True, help="教師データCSVのglobパターン")
    eval_parser.add_argument("--scored", required=True, help="スコアCSVのパス")
    eval_parser.add_argument("--out", required=True, help="指標JSONの出力先")
    eval_parser.add_argument("--bins", type=int, default=15, help="ECE 計算時のビン数")
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
        cfg_path = Path(args.cfg).expanduser().resolve() if args.cfg else None
        cfg_data: Optional[Mapping[str, Any]] = None
        if cfg_path is not None:
            try:
                cfg_data = _load_yaml_config(cfg_path)
            except ValueError as exc:
                _LOGGER.error("train.invalid_config", extra={"error": str(exc)})
                return 1

        numeric_cols: Sequence[Any] = list(args.numeric_cols or [])
        delta_column = args.delta_col
        idle_timeout = float(args.idle_timeout)
        arch = args.arch
        time_head = args.time_head
        embedding_dim = int(args.emb_dim)
        hidden_size = int(args.hidden)
        num_layers = int(args.layers)
        dropout = float(args.dropout)
        mlp_hidden = tuple(args.mlp_hidden) if args.mlp_hidden else tuple()
        mlp_activation = args.mlp_activation
        mlp_dropout = float(args.mlp_dropout)
        delta_index = int(args.delta_index)
        rmtpp_eps = float(args.rmtpp_eps)

        epochs = int(args.epochs)
        batch_size = int(args.bs)
        learning_rate = float(args.lr)
        min_lr = float(args.min_lr)
        scheduler_name = args.scheduler
        early_stopping = int(args.early)
        clip_grad = float(args.clip_grad)
        amp_level = str(args.amp)
        scheduled_sampling = max(0.0, min(1.0, float(args.scheduled_sampling)))
        uncertainty = args.uncertainty_weight == "on"
        focal_gamma = args.focal_gamma
        label_smoothing = max(0.0, min(1.0, float(args.label_smoothing)))
        num_workers = int(args.num_workers)
        time_objective = args.time_objective
        class_weights: Optional[Mapping[str, float]] = None

        if cfg_data is not None:
            try:
                data_cfg = cfg_data.get("data") if isinstance(cfg_data, Mapping) else None
                if isinstance(data_cfg, Mapping):
                    seq = _optional_sequence(data_cfg.get("numeric_columns"), "data.numeric_columns")
                    if seq is not None:
                        numeric_cols = [str(item) for item in seq]
                    delta_override = _optional_str(data_cfg.get("delta_column"), "data.delta_column")
                    if delta_override is not None:
                        delta_column = delta_override
                    idle_override = _optional_float(data_cfg.get("idle_timeout"), "data.idle_timeout")
                    if idle_override is not None:
                        idle_timeout = float(idle_override)

                model_cfg_section = cfg_data.get("model") if isinstance(cfg_data, Mapping) else None
                if isinstance(model_cfg_section, Mapping):
                    arch_override = _optional_str(model_cfg_section.get("arch"), "model.arch")
                    if arch_override is not None:
                        arch = arch_override
                    head_override = _optional_str(model_cfg_section.get("time_head"), "model.time_head")
                    if head_override is not None:
                        time_head = head_override
                    emb_override = _optional_int(model_cfg_section.get("embedding_dim"), "model.embedding_dim")
                    if emb_override is not None:
                        embedding_dim = emb_override
                    hidden_override = _optional_int(model_cfg_section.get("hidden_size"), "model.hidden_size")
                    if hidden_override is not None:
                        hidden_size = hidden_override
                    layer_override = _optional_int(model_cfg_section.get("num_layers"), "model.num_layers")
                    if layer_override is not None:
                        num_layers = layer_override
                    dropout_override = _optional_float(model_cfg_section.get("dropout"), "model.dropout")
                    if dropout_override is not None:
                        dropout = float(dropout_override)
                    mlp_override = _optional_sequence(model_cfg_section.get("mlp_hidden"), "model.mlp_hidden")
                    if mlp_override is not None:
                        hidden_dims = []
                        for idx, value in enumerate(mlp_override):
                            try:
                                hidden_dims.append(int(value))
                            except Exception as exc:  # pragma: no cover - 異常入力
                                raise ValueError(f"model.mlp_hidden[{idx}] は整数で指定してください") from exc
                        mlp_hidden = tuple(hidden_dims)
                    activation_override = _optional_str(model_cfg_section.get("mlp_activation"), "model.mlp_activation")
                    if activation_override is not None:
                        mlp_activation = activation_override
                    mlp_dropout_override = _optional_float(model_cfg_section.get("mlp_dropout"), "model.mlp_dropout")
                    if mlp_dropout_override is not None:
                        mlp_dropout = float(mlp_dropout_override)
                    delta_index_override = _optional_int(model_cfg_section.get("delta_index"), "model.delta_index")
                    if delta_index_override is not None:
                        delta_index = delta_index_override
                    rmtpp_override = _optional_float(model_cfg_section.get("rmtpp_eps"), "model.rmtpp_eps")
                    if rmtpp_override is not None:
                        rmtpp_eps = float(rmtpp_override)

                train_cfg_section = cfg_data.get("training") if isinstance(cfg_data, Mapping) else None
                if isinstance(train_cfg_section, Mapping):
                    epochs_override = _optional_int(train_cfg_section.get("epochs"), "training.epochs")
                    if epochs_override is not None:
                        epochs = epochs_override
                    batch_override = _optional_int(train_cfg_section.get("batch_size"), "training.batch_size")
                    if batch_override is not None:
                        batch_size = batch_override
                    lr_override = _optional_float(train_cfg_section.get("learning_rate"), "training.learning_rate")
                    if lr_override is not None:
                        learning_rate = float(lr_override)
                    min_lr_override = _optional_float(train_cfg_section.get("min_learning_rate"), "training.min_learning_rate")
                    if min_lr_override is not None:
                        min_lr = float(min_lr_override)
                    scheduler_override = _optional_str(train_cfg_section.get("scheduler"), "training.scheduler")
                    if scheduler_override is not None:
                        scheduler_name = scheduler_override
                    early_override = _optional_int(train_cfg_section.get("early_stopping"), "training.early_stopping")
                    if early_override is not None:
                        early_stopping = early_override
                    clip_override = _optional_float(train_cfg_section.get("clip_grad"), "training.clip_grad")
                    if clip_override is not None:
                        clip_grad = float(clip_override)
                    amp_override = _optional_str(train_cfg_section.get("amp_level"), "training.amp_level")
                    if amp_override is not None:
                        amp_level = amp_override
                    ss_override = _optional_float(train_cfg_section.get("scheduled_sampling"), "training.scheduled_sampling")
                    if ss_override is not None:
                        scheduled_sampling = max(0.0, min(1.0, float(ss_override)))
                    uncertainty = _coerce_bool(
                        train_cfg_section.get("uncertainty_weighting"),
                        "training.uncertainty_weighting",
                        uncertainty,
                    )
                    focal_override = _optional_float(train_cfg_section.get("focal_gamma"), "training.focal_gamma")
                    if focal_override is not None:
                        focal_gamma = float(focal_override)
                    smoothing_override = _optional_float(train_cfg_section.get("label_smoothing"), "training.label_smoothing")
                    if smoothing_override is not None:
                        label_smoothing = max(0.0, min(1.0, float(smoothing_override)))
                    workers_override = _optional_int(train_cfg_section.get("num_workers"), "training.num_workers")
                    if workers_override is not None:
                        num_workers = workers_override

                time_obj_override = _optional_str(cfg_data.get("time_objective"), "time_objective")
                if time_obj_override is not None:
                    time_objective = time_obj_override

                class_cfg = cfg_data.get("class_weights")
                if isinstance(class_cfg, Mapping):
                    mapped: dict[str, float] = {}
                    for key, value in class_cfg.items():
                        mapped[str(key)] = float(value)
                    class_weights = mapped
                elif class_cfg is not None:
                    class_path = Path(str(class_cfg)).expanduser().resolve()
                    class_weights = json.loads(class_path.read_text(encoding="utf-8"))
            except ValueError as exc:
                _LOGGER.error("train.invalid_config", extra={"error": str(exc)})
                return 1

        numeric_list = [str(col) for col in (numeric_cols or [])]
        if delta_column not in numeric_list:
            numeric_list = [delta_column, *numeric_list]
        deduped_numeric: list[str] = []
        seen_cols = set()
        for col in numeric_list:
            if col in seen_cols:
                continue
            seen_cols.add(col)
            deduped_numeric.append(col)
        numeric_cols = deduped_numeric

        if args.class_weights:
            class_path = Path(args.class_weights).expanduser().resolve()
            class_weights = json.loads(class_path.read_text(encoding="utf-8"))

        model_cfg = DeltaTimeModelConfig(
            arch=arch,
            vocab_size=1,
            embedding_dim=embedding_dim,
            hidden_size=hidden_size,
            num_layers=num_layers,
            dropout=dropout,
            numeric_dim=len(numeric_cols),
            mlp_hidden_dims=tuple(int(x) for x in mlp_hidden),
            mlp_activation=mlp_activation,
            mlp_dropout=mlp_dropout,
            time_head=time_head,
            delta_index=delta_index,
            rmtpp_eps=rmtpp_eps,
        )
        training_cfg = TrainingConfig(
            epochs=epochs,
            batch_size=batch_size,
            learning_rate=learning_rate,
            min_learning_rate=min_lr,
            scheduler=scheduler_name,
            early_stopping=early_stopping,
            clip_grad=clip_grad,
            amp_level=str(amp_level),
            scheduled_sampling=scheduled_sampling,
            uncertainty_weighting=uncertainty,
            focal_gamma=focal_gamma,
            label_smoothing=label_smoothing,
            num_workers=num_workers,
        )
        val_patterns = args.val if args.val else None
        if time_head == "rmtpp":
            time_objective = "rmtpp"
        try:
            result = train_model(
                args.train,
                val_patterns=val_patterns,
                numeric_columns=numeric_cols,
                delta_column=delta_column,
                vocab_path=Path(args.vocab).expanduser().resolve() if args.vocab else None,
                idle_timeout=float(idle_timeout),
                model_config=model_cfg,
                training_config=training_cfg,
                device=runtime.device,
                output_dir=output_dir,
                seed=args.seed,
                time_objective=time_objective,
                class_weights=class_weights,
                config_source=cfg_path,
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
        if cfg_path is not None:
            payload["config_source"] = str(cfg_path)
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "calibrate":
        engine = DTLSTMEngine(seed=args.seed)
        runtime = engine.configure()
        cfg_path = Path(args.cfg).expanduser().resolve() if args.cfg else None
        cfg_data: Optional[Mapping[str, Any]] = None
        if cfg_path is not None:
            try:
                cfg_data = _load_yaml_config(cfg_path)
            except ValueError as exc:
                _LOGGER.error("calibrate.invalid_config", extra={"error": str(exc)})
                return 1
        try:
            ckpt_path, bundle_path = _resolve_model_paths(
                ckpt=args.ckpt,
                bundle=getattr(args, "bundle", None),
                model=getattr(args, "model", None),
            )
        except ValueError as exc:
            _LOGGER.error("calibrate.invalid_model", extra={"error": str(exc)})
            return 1
        if ckpt_path is None and bundle_path is None:
            _LOGGER.error("calibrate.missing_model", extra={"error": "--ckpt/--bundle/--model のいずれかを指定してください"})
            return 1
        out_path = Path(args.out).expanduser().resolve()
        batch_size = int(args.batch_size)
        bins = int(args.bins)
        max_k = int(args.max_k)
        if cfg_data is not None:
            try:
                calib_cfg = cfg_data.get("calibration") if isinstance(cfg_data, Mapping) else None
                if isinstance(calib_cfg, Mapping):
                    batch_override = _optional_int(calib_cfg.get("batch_size"), "calibration.batch_size")
                    if batch_override is not None:
                        batch_size = batch_override
                    bins_override = _optional_int(calib_cfg.get("bins"), "calibration.bins")
                    if bins_override is not None:
                        bins = bins_override
                    maxk_override = _optional_int(calib_cfg.get("max_k"), "calibration.max_k")
                    if maxk_override is not None:
                        max_k = maxk_override
            except ValueError as exc:
                _LOGGER.error("calibrate.invalid_config", extra={"error": str(exc)})
                return 1
        try:
            result = calibrate_temperature(
                args.val,
                checkpoint_path=ckpt_path,
                bundle_path=bundle_path,
                output_path=out_path,
                device=runtime.device,
                batch_size=batch_size,
                bins=bins,
                max_k=max_k,
            )
        except CalibrationError as exc:
            _LOGGER.error("calibrate.failed", extra={"error": str(exc)})
            return 1
        payload = {
            "event": "calibrate.completed",
            "temperature": result["temperature"],
            "ece_before": result["ece"]["before"],
            "ece_after": result["ece"]["after"],
            "out_path": str(out_path),
        }
        if cfg_path is not None:
            payload["config_source"] = str(cfg_path)
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "export":
        ckpt_path = Path(args.ckpt).expanduser().resolve()
        vocab_path = Path(args.vocab).expanduser().resolve() if args.vocab else None
        calib_path = Path(args.calib).expanduser().resolve() if args.calib else None
        meta_path = Path(args.meta).expanduser().resolve() if args.meta else None
        out_path = Path(args.out).expanduser().resolve()
        try:
            payload = export_bundle(
                checkpoint_path=ckpt_path,
                output_path=out_path,
                vocab_path=vocab_path,
                calibration_path=calib_path,
                train_meta_path=meta_path,
                algo_version=str(args.algo_ver),
            )
        except ExportError as exc:
            _LOGGER.error("export.failed", extra={"error": str(exc)})
            return 1
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "infer":
        engine = DTLSTMEngine(seed=args.seed)
        runtime = engine.configure()
        cfg_path = Path(args.cfg).expanduser().resolve() if args.cfg else None
        cfg_data: Optional[Mapping[str, Any]] = None
        if cfg_path is not None:
            try:
                cfg_data = _load_yaml_config(cfg_path)
            except ValueError as exc:
                _LOGGER.error("infer.invalid_config", extra={"error": str(exc)})
                return 1
        try:
            ckpt_path, bundle_path = _resolve_model_paths(
                ckpt=args.ckpt,
                bundle=getattr(args, "bundle", None),
                model=getattr(args, "model", None),
            )
        except ValueError as exc:
            _LOGGER.error("infer.invalid_model", extra={"error": str(exc)})
            return 1
        if ckpt_path is None and bundle_path is None:
            _LOGGER.error("infer.missing_model", extra={"error": "--ckpt/--bundle/--model のいずれかを指定してください"})
            return 1
        calib_path = Path(args.calib).expanduser().resolve() if args.calib else None
        out_path = Path(args.out).expanduser().resolve()
        audit_path = Path(args.audit).expanduser().resolve() if args.audit else None
        topk = int(args.topk)
        if cfg_data is not None:
            try:
                infer_cfg = cfg_data.get("inference") if isinstance(cfg_data, Mapping) else None
                if isinstance(infer_cfg, Mapping):
                    topk_override = _optional_int(infer_cfg.get("topk"), "inference.topk")
                    if topk_override is not None:
                        topk = topk_override
            except ValueError as exc:
                _LOGGER.error("infer.invalid_config", extra={"error": str(exc)})
                return 1
        try:
            summary = run_inference(
                args.inputs,
                checkpoint_path=ckpt_path,
                calibration_path=calib_path,
                output_path=out_path,
                audit_path=audit_path,
                topk=int(topk),
                device=runtime.device,
                bundle_path=bundle_path,
            )
        except InferenceError as exc:
            _LOGGER.error("infer.failed", extra={"error": str(exc)})
            return 1
        payload = {
            "event": "infer.completed",
            "sequences": summary.sequences,
            "events": summary.events,
            "out_path": str(summary.out_path),
            "audit_path": summary.audit_path and str(summary.audit_path),
        }
        if cfg_path is not None:
            payload["config_source"] = str(cfg_path)
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "online":
        try:
            k_value, n_value = _parse_kofn(args.kofn)
        except ValueError as exc:
            _LOGGER.error("online.invalid_kofn", extra={"error": str(exc)})
            return 1
        engine = DTLSTMEngine(seed=args.seed)
        runtime = engine.configure()
        ckpt_path = Path(args.ckpt).expanduser().resolve()
        calib_path = Path(args.calib).expanduser().resolve() if args.calib else None
        out_path = Path(args.out).expanduser().resolve()
        audit_path = Path(args.audit).expanduser().resolve() if args.audit else None
        stream_path = Path(args.stream).expanduser().resolve()
        try:
            summary = run_online_stream(
                stream_path=stream_path,
                checkpoint_path=ckpt_path,
                calibration_path=calib_path,
                output_path=out_path,
                audit_path=audit_path,
                q=float(args.q),
                kofn=(k_value, n_value),
                hysteresis=float(args.hysteresis),
                device=runtime.device,
            )
        except OnlineError as exc:
            _LOGGER.error("online.failed", extra={"error": str(exc)})
            return 1
        payload = {
            "event": "online.completed",
            "sequences": summary.sequences,
            "events": summary.events,
            "raw_alarms": summary.raw_alarms,
            "kofn_active_steps": summary.kofn_alarms,
            "active_steps": summary.active_steps,
            "triggers": summary.triggers,
            "out_path": str(summary.out_path),
            "audit_path": summary.audit_path and str(summary.audit_path),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if args.command == "eval":
        scored_path = Path(args.scored).expanduser().resolve()
        out_path = Path(args.out).expanduser().resolve()
        try:
            payload = evaluate(
                args.inputs,
                scored_path=scored_path,
                metrics_path=out_path,
                bins=int(args.bins),
            )
        except EvaluationError as exc:
            _LOGGER.error("eval.failed", extra={"error": str(exc)})
            return 1
        event_payload = {
            "event": "eval.completed",
            "metrics_path": str(out_path),
            "pr_curve_png": payload["artifacts"]["pr_curve_png"],
            "calibration_png": payload["artifacts"]["calibration_png"],
        }
        sys.stdout.write(json.dumps(event_payload, ensure_ascii=False) + "\n")
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI エントリ
    sys.exit(main())
