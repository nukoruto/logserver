"""Utilities for packaging rolling-origin CV artifacts into a report bundle."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, MutableMapping, Sequence


@dataclass(frozen=True)
class ThresholdRecord:
    fold: str
    subset: str
    method: str
    value: float
    source: str


def _copy_optional(src: Path | None, dest: Path) -> None:
    if src is None or not src.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def _copy_scores(src_dir: Path, dest_dir: Path, pattern: str) -> None:
    for path in src_dir.glob(pattern):
        rel = path.relative_to(src_dir)
        _copy_optional(path, dest_dir / rel)


def _parse_env(path: Path, acc: MutableMapping[str, set[str]]) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        acc.setdefault(key.strip(), set()).add(value.strip())


def _load_artifact_commands(path: Path, fold: str, stage: str) -> list[Mapping[str, str]]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("entries") if isinstance(payload, Mapping) else []
    result: list[Mapping[str, str]] = []
    if not isinstance(entries, list):
        return result
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        argv = entry.get("argv", [])
        argv_str = " ".join(str(part) for part in argv) if isinstance(argv, Sequence) else ""
        result.append(
            {
                "fold": fold,
                "stage": stage,
                "name": str(entry.get("name", stage)),
                "argv": argv_str,
                "returncode": str(entry.get("returncode", "")),
            }
        )
    return result


def _thresholds_from_metrics(path: Path, *, fold: str, subset: str) -> list[ThresholdRecord]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        return []
    methods = payload.get("methods", {})
    if not isinstance(methods, Mapping):
        return []
    records: list[ThresholdRecord] = []
    for method, info in methods.items():
        if not isinstance(info, Mapping):
            continue
        threshold = info.get("threshold")
        if not isinstance(threshold, Mapping):
            continue
        value = threshold.get("value")
        if value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        source = str(threshold.get("source", "unknown"))
        records.append(ThresholdRecord(fold=fold, subset=subset, method=str(method), value=numeric, source=source))
    return records


def _load_metrics_summary(summary_dir: Path | None) -> Mapping[str, object] | None:
    if summary_dir is None:
        return None
    summary_path = summary_dir / "metrics_summary.json"
    if not summary_path.exists():
        return None
    payload = json.loads(summary_path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, Mapping) else None


def _load_cv_report(cv_report_path: Path | None) -> Mapping[str, object] | None:
    if cv_report_path is None or not cv_report_path.exists():
        return None
    payload = json.loads(cv_report_path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, Mapping) else None


def _write_env_summary(path: Path, env_map: Mapping[str, set[str]]) -> None:
    lines = []
    for key in sorted(env_map):
        values = sorted(env_map[key])
        joined = ",".join(values)
        lines.append(f"{key}={joined}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _build_results_md(
    *,
    out_dir: Path,
    generated_at: str,
    fold_dirs: Sequence[Path],
    env_map: Mapping[str, set[str]],
    commands: Sequence[Mapping[str, str]],
    thresholds: Sequence[ThresholdRecord],
    metrics_summary: Mapping[str, object] | None,
    cv_report: Mapping[str, object] | None,
    subsets: Iterable[str],
) -> Path:
    lines: list[str] = []
    lines.append("# Rolling-origin CV Report")
    lines.append("")
    lines.append(f"- 生成日時: {generated_at}")
    lines.append(f"- フォールド数: {len(fold_dirs)}")
    lines.append("")
    lines.append("## 実行環境")
    lines.append("")
    lines.append("| 変数 | 値 |")
    lines.append("| --- | --- |")
    for key in sorted(env_map):
        value = ", ".join(sorted(env_map[key]))
        lines.append(f"| {key} | {value} |")
    lines.append("")
    lines.append("## 実行手順")
    lines.append("")
    lines.append("| フォールド | ステージ | コマンド | 戻り値 |")
    lines.append("| --- | --- | --- | --- |")
    for entry in commands:
        lines.append(
            f"| {entry.get('fold', '')} | {entry.get('stage', '')} | {entry.get('argv', '')} | {entry.get('returncode', '')} |"
        )
    lines.append("")
    lines.append("## 閾値")
    lines.append("")
    lines.append("| フォールド | サブセット | 手法 | しきい値 | ソース |")
    lines.append("| --- | --- | --- | --- | --- |")
    for record in thresholds:
        lines.append(
            f"| {record.fold} | {record.subset} | {record.method} | {record.value:.6f} | {record.source} |"
        )
    lines.append("")
    lines.append("## 指標要約")
    lines.append("")
    lines.append("| サブセット | 手法 | 指標 | 平均 | 標準偏差 | CI下限 | CI上限 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    metric_rows = _metric_rows(metrics_summary, cv_report, subsets)
    for row in metric_rows:
        lines.append(
            "| {subset} | {method} | {metric} | {mean:.6f} | {std:.6f} | {ci_low} | {ci_high} |".format(
                subset=row["subset"],
                method=row["method"],
                metric=row["metric"],
                mean=row["mean"],
                std=row["std"],
                ci_low=row["ci_low"],
                ci_high=row["ci_high"],
            )
        )
    result_path = out_dir / "results.md"
    result_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return result_path


def _metric_rows(
    metrics_summary: Mapping[str, object] | None,
    cv_report: Mapping[str, object] | None,
    subsets: Iterable[str],
) -> list[Mapping[str, object]]:
    rows: list[Mapping[str, object]] = []
    if metrics_summary:
        summary_subsets = metrics_summary.get("subsets", {}) if isinstance(metrics_summary, Mapping) else {}
        if isinstance(summary_subsets, Mapping):
            for subset in subsets:
                subset_payload = summary_subsets.get(subset, {})
                if not isinstance(subset_payload, Mapping):
                    continue
                for method, method_payload in subset_payload.items():
                    metrics = method_payload.get("metrics", {}) if isinstance(method_payload, Mapping) else {}
                    if not isinstance(metrics, Mapping):
                        continue
                    for metric_name, stats in metrics.items():
                        if not isinstance(stats, Mapping):
                            continue
                        mean = stats.get("fold_mean")
                        std = stats.get("fold_std")
                        ci_low = stats.get("ci_low")
                        ci_high = stats.get("ci_high")
                        rows.append(
                            {
                                "subset": subset,
                                "method": method,
                                "metric": metric_name,
                                "mean": float(mean) if mean is not None else 0.0,
                                "std": float(std) if std is not None else 0.0,
                                "ci_low": "" if ci_low is None else f"{ci_low:.6f}",
                                "ci_high": "" if ci_high is None else f"{ci_high:.6f}",
                            }
                        )
    elif cv_report:
        for method, subset_payload in cv_report.items():
            if not isinstance(subset_payload, Mapping):
                continue
            for subset, metrics in subset_payload.items():
                if subset not in subsets or not isinstance(metrics, Mapping):
                    continue
                for metric_name, stats in metrics.items():
                    if not isinstance(stats, Mapping):
                        continue
                    mean = stats.get("mean")
                    std = stats.get("std")
                    rows.append(
                        {
                            "subset": subset,
                            "method": method,
                            "metric": metric_name,
                            "mean": float(mean) if mean is not None else 0.0,
                            "std": float(std) if std is not None else 0.0,
                            "ci_low": "",
                            "ci_high": "",
                        }
                    )
    return rows


def build_report_package(
    *,
    fold_root: Path,
    out_dir: Path,
    subsets: Iterable[str],
    summary_dir: Path | None,
    splits_path: Path | None,
    cv_report_path: Path | None,
) -> Path:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    env_map: MutableMapping[str, set[str]] = {}
    command_entries: list[Mapping[str, str]] = []
    threshold_records: list[ThresholdRecord] = []

    fold_dirs = sorted(path for path in fold_root.iterdir() if path.is_dir() and path.name.startswith("fold_"))
    for fold_dir in fold_dirs:
        dest_fold = out_dir / fold_dir.name
        dest_fold.mkdir(parents=True, exist_ok=True)
        # Preproc artifacts
        _copy_optional(fold_dir / "preproc" / "stats.json", dest_fold / "preproc" / "stats.json")
        _copy_optional(fold_dir / "preproc" / "meta.yaml", dest_fold / "preproc" / "meta.yaml")
        preproc_env = fold_dir / "preproc" / "env.txt"
        _copy_optional(preproc_env, dest_fold / "preproc" / "env.txt")
        _copy_optional(fold_dir / "preproc" / "artifacts_index.json", dest_fold / "preproc" / "artifacts_index.json")
        _parse_env(preproc_env, env_map)
        command_entries.extend(_load_artifact_commands(fold_dir / "preproc" / "artifacts_index.json", fold_dir.name, "preproc"))

        # Anomaly artifacts
        anom_dir = fold_dir / "anom"
        for filename in ("stats.json", "meta.json", "validation_scores.csv", "test_scores.csv", "env.txt", "artifacts_index.json"):
            _copy_optional(anom_dir / filename, dest_fold / "anom" / filename)
        _copy_scores(anom_dir, dest_fold / "anom", "*_scores.csv")
        _parse_env(anom_dir / "env.txt", env_map)
        command_entries.extend(_load_artifact_commands(anom_dir / "artifacts_index.json", fold_dir.name, "anom"))

        # LSTM artifacts
        lstm_dir = fold_dir / "lstm"
        for filename in (
            "model.tar",
            "model.pt",
            "config.json",
            "calib.json",
            "validation_scores.csv",
            "test_scores.csv",
            "env.txt",
            "artifacts_index.json",
        ):
            _copy_optional(lstm_dir / filename, dest_fold / "lstm" / filename)
        audit_dir = lstm_dir / "audit"
        if audit_dir.exists():
            shutil.copytree(audit_dir, dest_fold / "lstm" / "audit", dirs_exist_ok=True)
        _copy_scores(lstm_dir / "curves", dest_fold / "lstm" / "curves", "*.png")
        _parse_env(lstm_dir / "env.txt", env_map)
        command_entries.extend(_load_artifact_commands(lstm_dir / "artifacts_index.json", fold_dir.name, "lstm"))

        # Fisher and metrics
        fisher_dir = fold_dir / "fisher"
        metrics_dir = fold_dir / "metrics"
        _copy_scores(fisher_dir, dest_fold / "fisher", "*_scores.csv")
        for filename in ("validation.json", "test.json"):
            _copy_optional(metrics_dir / filename, dest_fold / "metrics" / filename)

        for subset in subsets:
            threshold_records.extend(
                _thresholds_from_metrics(metrics_dir / f"{subset}.json", fold=fold_dir.name, subset=subset)
            )

        # curves under root (if any)
        for png in fold_dir.glob("**/*.png"):
            if "curves" not in png.parts:
                continue
            relative = png.relative_to(fold_dir)
            _copy_optional(png, dest_fold / relative)

    # Copy root-level artifacts
    if splits_path and splits_path.exists():
        _copy_optional(splits_path, out_dir / "splits.yaml")
    if summary_dir and summary_dir.exists():
        shutil.copytree(summary_dir, out_dir / "summary", dirs_exist_ok=True)
    if cv_report_path and cv_report_path.exists():
        _copy_optional(cv_report_path, out_dir / "cv_report.json")

    env_summary_path = out_dir / "env.txt"
    _write_env_summary(env_summary_path, env_map)

    metrics_summary = _load_metrics_summary(summary_dir)
    cv_report = _load_cv_report(cv_report_path)

    generated_at = datetime.now(timezone.utc).isoformat()
    results_path = _build_results_md(
        out_dir=out_dir,
        generated_at=generated_at,
        fold_dirs=fold_dirs,
        env_map=env_map,
        commands=command_entries,
        thresholds=sorted(threshold_records, key=lambda rec: (rec.fold, rec.subset, rec.method)),
        metrics_summary=metrics_summary,
        cv_report=cv_report,
        subsets=subsets,
    )

    manifest = {
        "generated_at": generated_at,
        "fold_root": str(fold_root),
        "report_dir": str(out_dir),
        "fold_count": len(fold_dirs),
        "subsets": list(subsets),
        "summary_dir": None if summary_dir is None else str(summary_dir),
        "splits": None if splits_path is None else str(splits_path),
        "cv_report": None if cv_report_path is None else str(cv_report_path),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    return results_path


__all__ = ["build_report_package"]

