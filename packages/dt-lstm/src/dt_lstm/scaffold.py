"""プロジェクト雛形生成処理。"""

from __future__ import annotations

from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Dict, TYPE_CHECKING

if TYPE_CHECKING:
    from .engine import RuntimeContext


def _derive_package_name(project_name: str) -> str:
    cleaned = project_name.replace("-", "_").replace(" ", "_")
    if not cleaned.isidentifier():
        cleaned = "dt_lstm_project"
    return cleaned


def _render(text: str, context: Dict[str, str]) -> str:
    rendered = text
    for key, value in context.items():
        rendered = rendered.replace(f"__{key}__", value)
    return rendered


def _copy_template(template_root: Traversable, destination: Path, context: Dict[str, str]) -> None:
    for entry in template_root.iterdir():
        target = destination / entry.name
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            _copy_template(entry, target, context)
        else:
            raw = entry.read_bytes()
            try:
                data = raw.decode("utf-8")
            except UnicodeDecodeError:
                target.write_bytes(raw)
            else:
                target.write_text(_render(data, context), encoding="utf-8")


def create_project(
    *,
    out_dir: Path,
    preset: str,
    runtime: "RuntimeContext",
    overwrite: bool,
) -> None:
    template_root = resources.files("dt_lstm.templates").joinpath(preset)
    if not template_root.exists() or not template_root.is_dir():
        raise ValueError(f"未対応のプリセットです: {preset}")

    if out_dir.exists() and any(out_dir.iterdir()) and not overwrite:
        raise FileExistsError(f"{out_dir} は既に存在し、--force が指定されていません。")

    out_dir.mkdir(parents=True, exist_ok=True)

    project_name = out_dir.name
    package_name = _derive_package_name(project_name)

    context = {
        "PROJECT_NAME": project_name,
        "PACKAGE_NAME": package_name,
        "SEED": str(runtime.seed),
        "DEVICE": str(runtime.device),
        "CUDA_VISIBLE": runtime.cuda_visible_devices or "",
    }

    _copy_template(template_root, out_dir, context)

    script_file = out_dir / "scripts" / "train.py"
    if script_file.exists():
        script_file.chmod(0o755)
