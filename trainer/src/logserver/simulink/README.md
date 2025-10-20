# Simulink 比較可視化（手法8）

本ディレクトリは、Python 側で生成した参照信号 `r(t)` と LSTM 推定 `y_LSTM(t)` を
MATLAB/Simulink へ入力し、PID 制御器との追従性を比較・可視化するための補助スクリプトを
収めています。Python→Simulink→指標集計までを決定論的に再現できるよう、全ステップで
乱数を使用せず、入力データのハッシュと Git コミット ID を成果物へ書き込みます。

## 構成

```
trainer/src/logserver/simulink/
├─ export_signals.py          # CSV → From Workspace struct 変換 CLI
├─ README.md                  # 本ファイル
└─ model/
   ├─ run_simulink.m          # Simulink バッチ実行スクリプト
   └─ templates/
      └─ compare_lstm_pid.slx # 実行時に自動生成される雛形（無い場合は run_simulink.m が生成）
```

## 1. 参照・推定信号のエクスポート

`export_signals.py` は 2 つの CSV（参照系列と LSTM 推定系列）を読み込み、Simulink
の「From Workspace」ブロックが直接扱える `r`・`yLSTM` の構造体とメタデータ `meta`
を含む `signals.mat` を生成します。

```bash
python -m trainer.src.logserver.simulink.export_signals \
  --scores_csv outputs/lstm_scores.csv \
  --reference_csv data/reference.csv \
  --out_mat artifacts/simulink/run001/signals.mat \
  --Ts 0.1 \
  --scores-time-column time --scores-value-column y_hat \
  --reference-time-column time --reference-value-column r
```

- 入力 CSV の時間列は RFC3339 などの日時文字列、または UTC 秒（float）を受け付けます。
- 列は昇順へ安定ソートされ、NaN/Inf を含む行はエラーになります。
- `meta.data_hash` には参照 CSV と推定 CSV のバイト列から算出した SHA-256 を保存します。
- `meta.git_commit` はリポジトリの最新コミット ID を記録します。

## 2. Simulink 実行

`model/run_simulink.m` は JSON 設定ファイル（既定: 同ディレクトリの `Simulink.env.json`）
を読み込み、以下の手順を自動化します。

1. `signals.mat` を読み込んで `r`・`yLSTM` をベースワークスペースへ配置。
2. `compare_lstm_pid.slx` をテンプレートとして読み込み（存在しなければ自動生成）。
3. 固定ステップ (`FixedStepDiscrete`) でシミュレーションを実行。
4. `r`, `y_PID`, `y_LSTM`, `e_PID`, `e_LSTM` を `StructureWithTime` 形式で取得。
5. 台形則による IAE/ISE/ITAE、`stepinfo` による過渡指標を計算。
6. 指定した境界値を超過した指標を `bounds_violations.csv` に記録。
7. 波形サンプル、シミュレーションログ、計算メタデータをアーティファクトへ保存。

### 設定ファイル例（`Simulink.env.json`）

```json
{
  "signals_mat": "artifacts/simulink/run001/signals.mat",
  "Ts": 0.1,
  "K": 1.0,
  "tau": 1.0,
  "pid": {"Kp": 1.2, "Ki": 0.5, "Kd": 0.0, "N": 100.0},
  "settle_band": 0.02,
  "bounds": {
    "RiseTimeMax": 2.0,
    "SettlingTimeMax": 5.0,
    "OvershootMax": 10.0
  },
  "waveforms_decimation": 1,
  "run_id": "run001",
  "out_dir": "artifacts/simulink"
}
```

### 実行コマンド

```bash
matlab -batch "run('trainer/src/logserver/simulink/model/run_simulink.m')"
```

MATLAB へ引数を渡す場合は `run_simulink('path/to/Simulink.env.json')` を呼び出します。

### 出力生成物

`artifacts/simulink/<run_id>/` に以下を保存します。

- `results.csv` – IAE/ISE/ITAE（PID/LSTM）、K, tau, Ts, settle_band, data_hash, git_commit, model_checksum
- `stepinfo.csv` – `RiseTime`, `SettlingTime`, `Overshoot`, `PeakTime`（PID/LSTM）
- `bounds_violations.csv` – 境界を超えた指標（行が無い場合は空CSV）
- `waveforms.csv` – 時刻と各系列の波形（必要に応じて間引き）
- `simlog.mat` – `SignalLoggingName`=`simlog` のデータセット
- `results_metadata.mat` – MATLAB 構造体形式の補足メタデータ

## 3. 再現性メモ

- Python 側・MATLAB 側とも乱数を使用しません。
- `signals.mat` 内の `meta.data_hash` と `meta.git_commit` が追跡情報の出発点です。
- `results.csv` には `model_checksum` を含め、Simulink ブロック構成の変更検知を容易にします。
- GPU 切替は `Simulink.env.json` に含まれないため、MATLAB 実行時に環境変数
  `CUDA_VISIBLE_DEVICES` を個別設定してください（SRS の GPU モード規約に従う）。

## 4. テストと今後の拡張

- `export_signals.py` は単体テスト化しやすいよう純粋関数で構成しています。
- MATLAB 側の単体テストは `matlab -batch` で起動する Live Script/`matlab.unittest`
  を追加し、`results.csv` のバイト一致を確認する計画です。
- 将来的には LSTM コントローラの ONNX エクスポートおよび Simulink 取り込みブロックの
  自動配置を追加する予定です。
