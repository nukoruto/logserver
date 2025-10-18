# dt-lstm

`dt-lstm` は、Δt を扱う LSTM 異常検知実験のための Python パッケージ兼 CLI です。CLI (`dt-lstm`) は決定的な実行設定と GPU 切替を提供し、Electron からの IPC でも共通利用できるエンジンを内包します。

## 主な機能
- `dt-lstm init --out <dir> --preset default` により、新規プロジェクトの雛形（`pyproject.toml`, `dt_lstm/`, `configs/`, `scripts/`, `tests/`）を生成。
- `dt-lstm fit --in data/train/*.csv --vocab-out ml/artifacts/vocab.json --cfg-out ml/artifacts/train_meta.json` で、`op_category` 語彙と学習初期メタ情報を学習データから決定的に推定し、`stoi/itos`・頻度・TopK 候補・RMTPP 初期パラメタを JSON に保存。
- 決定性モード：Python/NumPy/PyTorch の乱数種固定、`torch.backends` 設定、`CUBLAS_WORKSPACE_CONFIG=:16:8`。
- GPU 切替：`--device cuda` と `GPU_MODE=ada6000|4060` に応じて `CUDA_VISIBLE_DEVICES` を制御し、CPU フォールバックにも対応。
- CLI/IPC 共通エンジン `DTLSTMEngine` を提供し、Node/Electron 側から Python ブリッジ経由で再利用可能。

## 開発用テスト

```bash
python -m pytest
```
