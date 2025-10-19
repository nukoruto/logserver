# Δt-aware Session Log Anomaly Detection (LSTM) with Simulink Visualization

本リポジトリは、**セッション操作系列の行動モデル化**に基づく異常検知を目的に、
- Δt（イベント間隔）を陽に扱う **LSTM 系列モデル**、
- **異常スコアと閾値設計**（分位点/EVT-POT など）,
- **説明可能性**（Δt 統計や寄与度の可視化）,
- **Simulink による深層制御モデルの可視化と PID との比較**、ユーザ別制御ブロック分離

を一体化した研究用実験基盤です。卒業研究「Simulinkを用いた深層制御モデルの可視化と比較」を踏まえ、
セッション中の**操作内容とタイミング（Δt）**の両面から異常を定義し、
**LSTM を制御器として解釈**する視点で可視化・比較・説明可能性を強化します。

---

## 1. 目的 / 背景

- Web/アプリの**セッション操作系列**（例：ページ遷移・ボタン操作）を時系列としてモデル化し、
  **通常の振る舞い**を学習、逸脱を**異常**とみなします。
- 多くの先行研究が「イベント内容」中心であるのに対し、本研究は**Δt**を第1級特徴として扱い、
  **遅延・間隔の乱れ**も異常の兆候とします。
- **Simulink** で LSTM コントローラをブロック図化し、**PID** との比較や**ユーザ別制御ブロック**での振る舞い差を可視化します。

---

## 2. 主な機能
- **シナリオ駆動シミュレーション**：`collector/src/services/simulationService.ts` が正常／異常シナリオを決定的に生成し、Δt と操作イベントを含むログ系列を CSV + manifest で永続化
- **セッション化 / 前処理**：生成済みログをセッション単位へ分割し、操作カテゴリ（抽象化）と Δt を特徴量として付与
- **LSTM モデル**：イベント埋め込み＋Δt 連続値/ビニングを入力、次イベント／Δt 予測による**予測誤差型**の異常検知
- **異常スコア**：予測確率の逸脱 + Δt 予測誤差/尤度を統合
- **閾値設計**：分位点（例えば上位 p%）/ EVT-POT による自動しきい化、セッション単位/イベント単位いずれも可
- **閾値メタ生成**：セッション分割 CLI は `meta.json` にアルゴリズムバージョン、Δt 関連統計、データセット SHA-256 を保存し、追試・監査を支援
- **監査・再現メタ**：シミュレーション永続化時に `run_meta.json`（run_id/seed/環境/ハッシュ）、`audit.jsonl`（idx・sid_final・op_category・anomaly_type・reason）、`schema.json`（9 列 raw / 派生 features のスキーマ定義）を出力し、`manifest.schema_sha256` に `schema.json` の SHA-256 を記録
- **説明可能性**：Δt 統計（分布・区間）および特徴寄与度の算出、ケース単位の簡易説明レポート
- **Simulink 連携**：学習済み LSTM の重みをエクスポートして Simulink に取り込み、**PID** と**同一条件**で追従・外乱応答・過渡応答を比較
- **ユーザ別制御ブロック**：ユーザセグメントごとにコントローラを切替／分離し、セグメント特性（操作テンポなど）に最適化
- **Electron GUI ブリッジ**：`apps/lstm-gui` 経由で dt-lstm CLI (`fit`/`train`/`calibrate`/`infer`/`online`) を IPC 呼び出しし、進捗ログと生成物
  を GUI に反映（CLI 単体実行とバイト一致を保証）
- **時系列CV オーケストレーター**：Python パッケージ `dt-cv` の CLI `tscv` で Rolling-origin（purged/embargo 付き）クロスバリデーションを決定論的に再現。
  `dt-preproc` / `dt-anom` / `dt-lstm` を束ねつつ、各サブプロセスの環境変数と引数を `env.txt` / `artifacts_index.json` に保存し、完全な監査トレースを提供。

---

## 3. リポジトリ構成（推奨）

```
.
├─ README.md
├─ SRS.md
├─ CONSTRAINTS.md
├─ Makefile
├─ configs/
│   └─ scenario_default.json
├─ collector/
│   ├─ package.json
│   ├─ package-lock.json
│   ├─ src/
│   │   ├─ config/
│   │   ├─ services/
│   │   │   └─ simulationService.ts
│   │   └─ sim/
│   └─ tests/
│       ├─ scripts/
│       ├─ services/
│       └─ sim/
├─ apps/
│   ├─ splitter-gui/
│   └─ lstm-gui/
│       ├─ src/
│       │   ├─ main.ts（Electron メインプロセス）
│       │   ├─ preload.ts（IPC API を `window.dtLstm` に公開）
│       │   └─ python/（dt-lstm CLI ラッパー）
│       ├─ static/
│       └─ tests/（node:test による CLI 引数生成の検証）
├─ trainer/
│   ├─ configs/
│   │   ├─ default.yaml
│   │   └─ simulink.yaml
│   ├─ scripts/
│   │   ├─ preprocess.py
│   │   ├─ train.py
│   │   ├─ score.py
│   │   ├─ threshold.py
│   │   ├─ explain.py
│   │   └─ export_simulink.py
│   ├─ src/logserver/
│   │   ├─ dataio/
│   │   ├─ features/
│   │   ├─ models/
│   │   ├─ scoring/
│   │   ├─ explain/
│   │   ├─ simulink/
│   │   └─ training/
│   ├─ tests/
│   │   ├─ test_sessionize.py
│   │   ├─ test_features.py
│   │   └─ test_trainer.py
│   └─ requirements_*.txt
├─ contract/
│   └─ README.md
├─ artifacts/
│   └─ .gitkeep
└─ outputs/
    └─ .gitkeep
```

> Node.js ワークスペース（`packages/*`, `apps/splitter-gui`, `apps/lstm-gui`）では、`pnpm --filter @logserver/session-splitter-cli build`
> などのビルドを実行すると `dist/` 以下（例: `packages/dt-preproc/dist`, `apps/splitter-gui/dist/main.js`）が生成される。
> これらの生成物は `.gitignore` によりバージョン管理対象から除外される。

---

## 4. セットアップ

### 4.1 依存関係
本リポジトリは Node.js（シミュレーション CLI）と Python（学習・解析）が同居する **pnpm モノレポ** です。Node.js 側のパッケージは `pnpm` で統一管理し、Python 側は従来どおり `pip` または `conda` を利用します。セットアップ時は以下の順に依存関係を整えてください。

1. Corepack で `pnpm@8.15.8` を有効化し、モノレポ全体の Node.js 依存を解決します。

   ```bash
   corepack enable
   corepack prepare pnpm@8.15.8 --activate
   ```

   有効化後にリポジトリルートで以下を実行すると、`collector/` や `apps/` など Node.js サブパッケージの依存がまとめて導入されます。

   ```bash
   pnpm install
   ```

   ビルドを行う場合は、`pnpm -r build`（または後述の `make node-build`）を実行する。`packages/*/dist` や
   `apps/splitter-gui/dist/main.js` が生成され、いずれも `.gitignore` により自動的に除外される。

2. Python 依存は用途に応じて `pip` または `conda` の手順を選択し、学習・解析環境を構築します。

   - Python 3.10+（PyTorch or TensorFlow いずれか、デフォルトは PyTorch）
   - NumPy / Pandas / Scikit-learn / PyYAML / SciPy / Matplotlib
   - （任意）`scikit-extremes` など EVT-POT 実装（同等関数を自前実装可）
   - （Simulink連携）MATLAB R2023b+ と Deep Learning Toolbox, Simulink

   ```
   # pip
   pip install -r requirements.txt

   # conda（例）
   conda env create -f environment.yml
   conda activate sessad
   ```

### 4.2 データ配置
- `data/raw/` には **9 列固定の基本契約 CSV** を配置する。列順は `timestamp_utc, uid, session_id, method, path, referer, user_agent, ip, op_category` で固定し、RFC 3339 UTC と HKDF-HMAC 擬似匿名化を前提とする。
- セッション化 (`trainer.scripts.preprocess`) では `method` / `path` / `op_category` から `template_id` を決定的に導出し、`AUTH::GET::dashboard` のような形式で `template_id` 列と `event` 列の双方に保存する。TypeScript 側の `@logserver/dt-preproc` も同じテンプレート生成ロジックを利用するため、Python/Node 間でテンプレート語彙が一致する。
- 付随情報（severity, module, params）は `meta` に JSON として保持してもよい。
- 派生特徴は別工程で生成する。9 列 CSV を `dt-preproc fit` → `dt-preproc transform` → `python -m trainer.scripts.score` → `python -m trainer.scripts.threshold` に投入し、`data/processed/` や `outputs/` に Δt・ロバスト統計・異常ラベル列を追加した成果物を保存する。
- `trainer/configs/default.yaml` の `data.feature_merge.patterns` で `*-features.csv` を指定すると、`trainer.scripts.train` が `uid/session_id/timestamp_utc/template_id` をキーとして自動マージし、新しい特徴列のみを結合する。
- `data/sim/` はシミュレーション API やシナリオ生成結果の既定保管先（`SIM_LOG_DIR` 未設定時）。CSV（`simEvents-<run-id>.csv`）、マニフェスト（`scenario-<run-id>.json`）、監査メタ（`run_meta.json` / `audit.jsonl` / `schema.json`）が保存され、`manifest.schema_sha256` に `schema.json` のハッシュが追記される。
- `logs/` には 9 列契約に従った参照ログ `sample.csv` を同梱している。初期動作確認では次のように生データ領域へ複製する。

  ```bash
  mkdir -p data/raw
cp logs/sample.csv data/raw/
```

### 4.3 Rolling-origin クロスバリデーション（`tscv`）

`packages/dt-cv` の CLI `tscv` を用いると、Rolling-origin（Purged/Embargo 付き）クロスバリデーションを完全に決定論的な手順で実行
できます。基本的な利用フローは以下の通りです。

1. **split** – 生ログをセッション順に分割し、`fold_*/raw/*.csv` と `splits.yaml` を生成。

   ```bash
   python -m dt_cv.cli split \
     --input data/raw/sample.csv \
     --output outputs/cv_runs/run1 \
     --train-size 1000 --val-size 200 --test-size 200 \
     --step-size 100 --purge 10 --embargo 5 --seed 42
   ```

2. **train** – 各フォールドで `dt-preproc` → `dt-anom fit` → `dt-lstm train` をサブプロセス実行。乱数・CUDA・TF32 が固定され、各コマ
   ンドの環境変数と引数は `preproc/`、`anom/`、`lstm/` 配下の `env.txt` / `artifacts_index.json` に保存される。

   ```bash
   python -m dt_cv.cli train \
     --splits outputs/cv_runs/run1/splits.yaml \
     --dt-preproc dt-preproc --dt-anom dt-anom --dt-lstm dt-lstm \
     --seed 42 --gpu-mode ada6000
   ```

3. **eval / report** – `dt-anom score` と `dt-lstm infer` を走らせ、AUPRC（主指標）/ ROC-AUC（補助）と Fisher 結合スコアを算出し、`cv_report.json`
   に折れ線平均をまとめる。

   ```bash
   python -m dt_cv.cli eval --splits outputs/cv_runs/run1/splits.yaml
   python -m dt_cv.cli report --splits outputs/cv_runs/run1/splits.yaml
   ```

4. **fuse** – Rolling-origin の dev/test それぞれで `dt-anom` / `dt-lstm` の確率スコアを結合。dev では `--dev-calib` に指定した JSON へ
   F1 最大（もしくは `--objective budget` によるアラーム率制約）で求めたしきい値を保存し、test では同ファイルを再利用してリークなし
   に `alarm_fisher` 列を生成します。単位変換（例：Δt 秒→ミリ秒）を行っても、スコア差分は `Δneglog10_p ≤ 0.02` 以内に収まるよう、
   すべて float64 で計算します。

   ```bash
   python -m dt_cv.cli fuse \
     --anom artifacts/folds/k/test_anom_scores.csv \
     --lstm artifacts/folds/k/test_lstm_scores.csv \
     --method fisher \
     --dev-calib artifacts/folds/k/dev_fuse_calib.json \
     --out artifacts/folds/k/test_fused_scores.csv \
     --objective f1
   ```

同じ `splits.yaml` と `--seed` を用いれば、各フォールドの成果物（特徴 CSV、異常統計、LSTM モデル、スコア CSV）はバイトレベルで一致
します。生成物の所在は `splits.yaml` の `folds[].paths` に記録され、追加のアーティファクト管理を行う際も追跡可能です。

- 派生特徴を生成する場合は、コピーした `data/raw/sample.csv` を対象に次を実行すると、基本契約 CSV から Δt 付き特徴 CSV（`data/processed/sample_feat.csv` など）を得られる。`dt-preproc` の `--in` や `--fit-manifest` 引数では `@list.txt` 形式でファイル一覧を参照でき、行頭 `#` はコメントとして無視される。

  ```bash
  pnpm --filter @logserver/dt-preproc run build
  printf 'data/raw/sample.csv\n' > stats/train_manifest.txt
  pnpm exec dt-preproc fit \
    --in @stats/train_manifest.txt \
    --out stats/preproc_stats.json \
    --meta stats/preproc_meta.json \
    --fold-id fold0
  pnpm exec dt-preproc transform \
    --in data/raw/sample.csv \
    --stats stats/preproc_stats.json \
    --out data/processed/sample_feat.csv \
    --fold-id fold0 \
    --fit-manifest @stats/train_manifest.txt
  ```

#### Rolling-origin 時系列CV 分割

Rolling-origin + Purged/Embargo 付きの時系列クロスバリデーション分割は `trainer.scripts.tscv` CLI で生成できます。セッションを時刻昇順に並べ、ユーザ（GroupKFold 相当）を考慮して `train/dev/test/embargo` を YAML 化します。

```bash
python -m trainer.scripts.tscv split \
  --in "data/all/*.csv" \
  --group uid \
  --session-column session_id \
  --timestamp-column timestamp_utc \
  --rolling expanding \
  --window_l 0 \
  --horizon 1 \
  --embargo auto \
  --folds 5 \
  --out artifacts/splits/splits.yaml
```

- `--rolling expanding|fixed` と `--window_l` で訓練ウィンドウを制御。`window_l = 0` の場合、`train_sessions = total_sessions - folds * (2 * horizon)` を採用します。
- `--embargo auto` では `embargo_auto = max(DeltaT_session_max, 2 * median_delta_t)` を用い、実際に用いた秒数をマニフェストへ記録します。
- 各 fold のセッション ID / ユーザ一覧、時間境界、イベント・ラベル統計、seed を完全保存し、`train ∩ {dev, test, embargo} = ∅` を検証してから書き出します。

生成物は `artifacts/splits/splits.yaml` など任意パスに保存でき、学習・推論パイプラインの前処理に再利用できます。
  `fit` コマンドが生成する統計 JSON には、学習に利用したファイル一覧のハッシュ（`source_manifest_hash`）と fold 識別子（`fold_id`）が保存される。`transform` 実行時に `--fold-id` と `--fit-manifest` を指定すると、誤った fold の統計や訓練セットを流用しようとした場合に即座にエラーとなり、Rolling-origin のリークを防止できる。

- 追加の生ログを取得する際は、決定的シードでシミュレータを実行して `artifacts/<run>/` 以下に CSV・manifest・ハッシュ（`checksums.txt`）を保存する。例：

  ```bash
  pnpm dlx ts-node --transpile-only --compiler-options '{"module":"commonjs","target":"ES2020"}' \
    scripts/simulate.ts --seed reproducible-demo --count 64 --anomalies time,auth \
    --scenario configs/scenario_default.json --output-dir artifacts/sim_repro \
    --run-id reproducible-demo --delta-epsilon 0.001
  ```

- サンプルログや生成結果が揃っているかは `ls logs/*.csv artifacts/sim_repro/*.json artifacts/sim_repro/*.txt` などで確認できる。

### 4.3 環境変数ファイル (.env)
1. 雛形 `.env.example` を `.env` にコピーする（任意）。
   ```bash
   cp .env.example .env
   ```
   - **必ず `JWT_HMAC_KEY` を独自の 128bit 以上の Base64 文字列に更新**し、既定値
     `c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=` を利用しないこと。以下のチェック
     スクリプトを利用すると CI とローカルで検証できる。

     ```bash
     python scripts/check_jwt_key.py --env-file .env
     ```
2. シミュレーション結果の保存先を変更したい場合は `SIM_LOG_DIR` を設定する。設定がなければ `data/sim/` が利用される。
3. Δt の最小値（ε フロア）や時間異常モードの既定値を固定したい場合は `SIM_DELTA_EPSILON`（秒、1e-6〜1.0 にクリップ）と
   `SIM_TIME_ANOMALY_MODE`（`auto` / `propagate` / `local`）を設定する。未指定時は 1e-3 秒・`auto` が適用される。
4. GPU を切り替える場合は `.env` の `GPU_MODE` を編集し、対象マシンの GPU スロットに合わせて `ada6000`（RTX 6000 Ada 世代）
   もしくは `4060`（RTX 4060）を指定する。変更後は依存するサービスを再起動する。

   ```bash
   # RTX 6000 Ada を利用する場合
   sed -i 's/^GPU_MODE=.*/GPU_MODE=ada6000/' .env
   docker compose up -d --force-recreate collector trainer

   # RTX 4060 を利用する場合
   sed -i 's/^GPU_MODE=.*/GPU_MODE=4060/' .env
   docker compose up -d --force-recreate collector trainer
   ```

   - `GPU_MODE` の変更は Python トレーナと Docker コンテナに反映され、`TrainerConfig.device` が対応する GPU を自動選択する。
   - `docker compose exec collector printenv CUDA_VISIBLE_DEVICES` を実行し、`ada6000` の場合は `0`、`4060` の場合は `1` となることを確認する。

### 4.4 シミュレーションログ生成
シナリオに基づく CSV / manifest を生成するには、リポジトリルートで次を実行する。

```bash
pnpm exec ts-node scripts/simulate.ts \
  --scenario configs/scenario_default.json \
  --seed demo-seed \
  --anomalies time,auth \
  --count 256 \
  --output-dir data/sim \
  --delta-epsilon 0.002
```

- `--persist false` を指定すると、生成結果を標準出力に表示するだけでファイルは生成されない。
- `--session-spacing` や `--max-steps` を用いてセッション間隔や系列長を制御できる。
- 実行時には INFO ログでシード値・異常戦略・出力先が記録される。
- 時間異常注入は既定で **auto モード（局所と伝搬のランダム混合）** となり、
  `--time-anomaly-mode auto|propagate|local` で挙動を切り替え可能。
  auto 時の伝搬比率は `--time-anomaly-prop-weight`（0.0..1.0、既定 0.7）で制御する。
  各注入ごとの選択モードと重みは `meta.jsonl` に JSON Lines 形式で記録され、
  manifest の `output.meta_path` および `params.time_anomaly` にも保存される。

## 5. 使い方（CLI の一例）

```
# 1) セッション化・特徴量化・Δt計算
python -m trainer.scripts.preprocess --config trainer/configs/default.yaml

# 2) LSTM 学習（Δt 併用）
python -m trainer.scripts.train --config trainer/configs/default.yaml

# Δt ロバスト特徴（z, z_deseas, lburst, m25, m50, m75）を有効化
python -m trainer.scripts.train --config trainer/configs/default.yaml --features dt

# 3) スコアリングと閾値設計（分位点 or EVT-POT）
python -m trainer.scripts.score --config trainer/configs/default.yaml
python -m trainer.scripts.threshold --config trainer/configs/default.yaml --on-error keep-partial \
  --dump-eval data/processed/boundary_eval.json --dump-hist data/processed/anomaly_hist.json

# 4) 説明レポート（ケース単位）
python -m trainer.scripts.explain --config trainer/configs/default.yaml

`trainer.scripts.train` はセッション単位の分割から学習用統計を `fit` し、検証/テストは `transform` のみで再計算します。`--features dt` を指定すると、Δt 前処理 (`dt-preproc`) が生成した列のうち `delta_robust_z`, `delta_z_deseas_clipped`, `delta_log_burst`, `delta_quantile_0_25`（`delta_m25`）, `delta_quantile_0_5`（`delta_m50`）, `delta_quantile_0_75`（`delta_m75`）を検出し、存在する場合のみ LSTM 入力に連結します（未生成の列は自動的にスキップし、旧来の特徴にフォールバックします）。

- `TrainerConfig.device` は `auto` が既定で、`GPU_MODE=ada6000`（RTX 6000 Ada）または `GPU_MODE=4060`（RTX 4060）を指定すると、自動で `cuda:0` と最適化済みの `num_workers` / `prefetch_factor` / `pin_memory` / `persistent_workers` を適用します。`GPU_MODE` を未設定か、対応表に存在しない値の場合は CUDA 利用可否を判定し `cuda:0` または `cpu` を選択します。
- `data.feature_merge.patterns` に `*-features.csv` を設定すると、`trainer.scripts.train` が該当 CSV を探索し、`uid` / `session_id` / `timestamp_utc` / `template_id` をキーに追加列のみを結合する。テンプレート語彙の一致は Python/TypeScript 共通のテンプレート ID 生成ヘルパーで保証する。
- DataLoader は IterableDataset ベースで、メモリ常駐の numpy 配列だけでなく `numpy.memmap` やスライス呼び出し可能オブジェクトから必要なセッションのみを読み出してバッチ化します。学習実行後は `model.pt` / `features.json` / `model_config.json` に加えて乱数種・DataLoader パラメタ・Git コミットを記録した `repro.json` が生成され、再現性監査を支援します。

- 前処理 CLI 実行後は `data/processed/preproc_report.json` が生成され、前処理前後の統計量・欠損/"unknown" 件数・分位差・単位不変性判定、任意 5 ユーザの変換トレースを含む監査レポートとして保存されます。
- `trainer.scripts.preprocess` は `data.chunksize`（既定 100,000）と `data.use_pyarrow` に従って CSV/JSON/Parquet をチャンク単位で読み込み、Δt 計算・セッション化した結果を `events.csv` / `events.parquet` へ追記します。監査レポート用のサンプルは `report.max_rows` で上限制御され、`null` を指定すると全行を統計用に読み込み、`0` 以下でサンプル取得を完全に無効化します。
- `trainer.scripts.score` は `scoring.chunksize` と `scoring.use_pyarrow` を用いて Parquet ストリーミング推論を行い、セッションが分割されないようにチャンク境界の carry-over を保持しつつ `scores.csv` に追記します。既存の `runs/latest` ディレクトリ構造は変更せず、モデル読込と異常スコア平滑化は従来どおりです。
- 100 万行のモックデータを対象にした統合テスト（`trainer/tests/test_streaming_large.py`）で処理時間（180 秒以内）とメモリ上限（約 1.2 GB 未満）を検証しており、チャンク処理に失敗した場合はテストが失敗するようになっています。

- 閾値 CLI は入力スコア CSV の SHA-256 を冒頭で計算し、`threshold.json` のメタ情報に保存します。フォールバック理由（NaN/空グループなど）も JSON ログおよびメタに明記されます。
- `--on-error` は `abort`（既定、部分成果物を削除）と `keep-partial`（`.partial` 拡張子で保持）を切替でき、運用事故時の調査を容易にします。
- `--dump-eval` オプションを指定すると、`boundary_annotation` 等のアノテーション列が存在する場合に境界検出の F1 / Jaccard / Variation of Information を JSON で出力します（図表生成用）。
- `--dump-hist` を指定すると、異常スコアのヒストグラム（bin 辺・中心・密度・要約統計）を JSON 形式で保存し、二峰性の可視化にそのまま利用できます。`--hist-bins` でビン数を調整できます。

### 5.1 Δt ロバスト統計フィッティング CLI（Fit / Transform ランブック）

### 5.2 dt-lstm パッケージ雛形生成

PyTorch ベースの dt-lstm 実験プロジェクトを新規作成する場合は、`packages/dt-lstm` が提供する CLI を利用できます。決定性設定と GPU 切替を自動で行い、`ml/` 配下に必要なディレクトリとテンプレートを展開します。

```bash
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli init \
  --out ml \
  --preset default \
  --seed 42 \
  --device cuda
```

- `GPU_MODE=ada6000|4060` を設定すると、対応する GPU に `CUDA_VISIBLE_DEVICES` が切り替わります（未指定時は CPU へフォールバック）。
- 生成された `ml/pyproject.toml` は `dt-lstm` パッケージへ依存し、`configs/default.yaml` と `scripts/train.py` は `DTLSTMEngine` を通じて決定性を維持します。
- Electron 等から IPC で CLI を呼び出す場合も同じエンジンを共有できるため、GUI/CLI 間で再現性が一致します。

以下は、新規参加者が**そのままコピー&ペーストできる一連のコマンド**です。`GPU_MODE` で RTX 6000 Ada（`ada6000`）と RTX 4060（`4060`）を切替できます。

```bash
# 0) GPU を選択（例: RTX6000 Ada）
export GPU_MODE=ada6000

# 1) TypeScript Δt CLI のビルド（初回のみ）
pnpm --filter @logserver/dt-preproc run build

# 2) 学習用 CSV から統計をフィット（Fit）
pnpm exec dt-preproc fit \
  --in data/train/*.csv \
  --grouping uid_session \
  --epsilon-t 0.05 \
  --clip-max 300 \
  --robust-z-clip 5 \
  --window 10 \
  --quantiles 0.25,0.5,0.75 \
  --out stats/preproc_stats.json \
  --meta stats/preproc_meta.json

# 3) 保存済み統計を使って検証データを変換（Transform）
pnpm exec dt-preproc transform \
  --in data/val/*.csv \
  --stats stats/preproc_stats.json \
  --window 10 \
  --quantiles 0.25,0.5,0.75 \
  --out data/val_feat/*.csv

# 4) 監査レポートと単位不変性テストを含む前処理ジョブ
python -m trainer.scripts.preprocess --config trainer/configs/default.yaml

# 5) 学習→検証→レポート生成（監査ログ含む）
python -m trainer.scripts.train --config trainer/configs/default.yaml \
  --save-report reports/train_eval_report.json
python -m trainer.scripts.score --config trainer/configs/default.yaml
python -m trainer.scripts.threshold --config trainer/configs/default.yaml \
  --dump-eval data/processed/boundary_eval.json \
  --dump-hist data/processed/anomaly_hist.json
python -m trainer.scripts.explain --config trainer/configs/default.yaml \
  --cases 10 --out reports/explain_latest.json
```

### 5.3 dt-lstm モデル定義ビルド CLI

`dt-lstm build` は、埋め込み・連続特徴 MLP・LSTM/PhasedLSTM 骨格・分類/時間ヘッドを一貫設定した `model_def.json` を生成します。生成物には `arch`（`lstm` / `phased_lstm`）、`time_head`（`regression` / `rmtpp`）、埋め込み次元、隠れ状態、連続特徴 MLP の層構成、Δt インデックス、RMTPP ε など全ハイパラが保存され、`load_definition(...).build_model()` で常に同一グラフを再構築できます。

- `--arch phased_lstm` を選択した場合は、時間ゲート φ(t) を内部的に `τ = softplus(τ_raw)`, `r_on = clip(sigmoid(r_on_raw), 0.05, 0.5)` で正規化し、Δt 累積時刻ベクトルを `--times` 引数で渡すと、ゲート開閉に応じて状態が更新されます。
- `--time-head rmtpp` では `g_i = v^T h_i + b`, `λ*(t) = exp(g_i + w × (t - t_i))`, `w = softplus(w_raw) + ε` を出力し、積分項は `∫_{0}^{Δ} λ*(t) dt = (exp(g_i + w Δ) - exp(g_i)) / w`（`|w| < 1e-6` の極限は `exp(g_i) × Δ`）で評価します。
- 連続特徴は LayerNorm→MLP（活性化は `--mlp-activation` で指定）で射影後、イベント埋め込みと連結してシーケンス骨格へ入力されます。

```bash
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli build \
  --arch lstm \
  --time-head rmtpp \
  --vocab-size 256 \
  --emb-dim 64 \
  --hidden 256 \
  --layers 2 \
  --dropout 0.1 \
  --numeric-dim 6 \
  --mlp-hidden 64 64 \
  --delta-index 0 \
  --out ml/artifacts/model_def.json
```

同じハイパラで `dt-lstm build` を再実行すると出力 JSON の内容は常に一致し、PyTorch のバージョンと総パラメータ数が `metadata` に記録されます。`phased_lstm` を選択した場合は `times` テンソルを前向き計算時に必ず与えてください。

### 5.4 dt-lstm 学習 CLI

`dt-lstm train` は、Δt を含むセッション系列 CSV から LSTM モデルを学習し、`model.pt`・`optimizer.pt`・`config.json`・`history.json` を出力します。多タスク損失はイベント分類（Cross Entropy/Focal/クラス重み）と時間予測（L1/Huber/NLL または RMTPP 尤度）の組み合わせで、`--uncertainty-weight on` を指定すると不確かさに基づく重み付け

```
L_total = Σ_k ( L_k / (2 σ_k^2) + log σ_k )
```

を自動的に最適化します。AMP (`--amp O1`)、勾配クリップ、Cosine スケジューラ、Scheduled Sampling (`--scheduled-sampling 0.1`) なども CLI フラグで切り替え可能です。RMTPP ヘッドを選択した場合、右打ち切りサンプルには生存項のみを加算します。

```
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli train \
  --train data/train_feat/*.csv \
  --val data/val_feat/*.csv \
  --arch lstm --time-head rmtpp --time-objective rmtpp \
  --epochs 30 --bs 64 --lr 1e-3 --scheduler cosine --early 5 \
  --uncertainty-weight on --amp O1 --clip-grad 1.0 \
  --scheduled-sampling 0.1 --seed 2025 --out ml/checkpoints/
```

同一シードで再実行すると学習曲線の形状は一致し、完了時に前述の 4 ファイルが出力されます。`config.json` には乱数シード・デバイス・ハイパラ・使用列が保存され、`history.json` には train/val の総損失とイベント/時間損失がエポックごとに記録されます。

### 5.5 dt-lstm 語彙・統計フィット CLI

Δt 特徴量を含む学習 CSV（`dt-preproc transform` 済み）から `op_category` 語彙と RMTPP 初期ハイパラを推定するには、`dt-lstm fit` サブコマンドを利用します。同じ入力に対しては常に同一バイト列の JSON アーティファクトが生成されます。

```bash
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli fit \
  --in data/train/*.csv \
  --vocab-out ml/artifacts/vocab.json \
  --cfg-out ml/artifacts/train_meta.json \
  --seed 2025
```

- `vocab.json` には `<pad>/<unk>` を含む `stoi/itos`、頻度統計、OOV トークン、TopK 候補（`[3,5]`）が保存されます。
- `train_meta.json` にはデータ件数・Δt 要約統計に加え、埋め込み次元・隠れ状態・ドロップアウト初期値、温度スケーリング枠、RMTPP の `w_init` / `bias_init` / `scale`（学習対象・固定の両設定）が保存されます。
- 失敗時は JSON ログに `fit.failed` が出力され、欠損列や入力ファイル不在などの理由を即座に確認できます。

### 5.6 dt-lstm バッチ推論 CLI（p 値統一スコア）

`dt-lstm infer` は学習済みモデル (`model.pt`) と温度スケーリング結果 (`calib.json`) を読み込み、Top-K 被覆と RMTPP 到着確率を p 値として統一し、Fisher 結合で異常スコアを算出します。推論対象 CSV は `dt-preproc transform` 済みの特徴量で、学習時と同じ `numeric_columns` / `delta_column` が利用可能である必要があります。

- イベント側 p 値: `p_ev = 1 - Σ_{y∈TopK} p(y)`。Top-K 被覆確率そのもの（`Σ_{y∈TopK} p(y)`）は出力 CSV の `topk_mass` 列に保存されます。
- 時間側 p 値: RMTPP で得られた `g_i, w` と観測 Δ に対し `p_time = 1 - exp(-∫_0^Δ λ*(t) dt)` を評価します。Δ が打ち切り（`time_censored`）の場合は時間成分を無視し、イベント成分のみで Fisher 結合します。
- 結合統計量: `S = -2 Σ_j log(1 - p_j)`（j はイベントと時間の最大 2 成分）。p 合成値は `p_comb = exp(-S/2) × Σ_{n=0}^{k-1} (S/2)^n / n!` で計算し、`neglog10_p = -log10(p_comb)` も同時に出力します。
- 監査 JSONL（`--audit`）はステップごとに `topk`, `p_ev`, `g`, `w`, `delta`, `p_time`, `statistic`（S）を記録し、同一入力に対してバイト完全一致となります。

```bash
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli infer \
  --in data/test_feat/*.csv \
  --ckpt ml/checkpoints/best.pt \
  --calib ml/artifacts/calib.json \
  --topk 5 \
  --out out/test_scored.csv \
  --audit out/lstm_audit.jsonl
```

出力 CSV には以下の列が含まれます。

| 列名 | 意味 |
| --- | --- |
| `sequence_index`, `step_index` | 入力シーケンスと時刻の 0 始まりインデックス |
| `source`, `session_id`, `uid`, `timestamp` | 元ファイル、セッション、ユーザ、イベント時刻（存在する場合） |
| `target_id`, `target_token` | 観測イベント ID と語彙トークン |
| `delta`, `censored` | 観測 Δt（秒）と打ち切りフラグ |
| `topk_mass`, `p_ev` | Top-K 被覆確率と補数の p 値 |
| `p_time` | RMTPP 到着までの累積分布（p 値） |
| `fisher_statistic`, `combined_p`, `neglog10_p` | Fisher 統計量 S、合成 p、負の常用対数スコア |

同じ ckpt/温度/データで再実行すると CSV・JSONL ともにバイト列が完全一致し、再現性監査ログには `infer.completed` が記録されます。

各コマンドは `--help` で詳細を確認できます。`dt-preproc transform` の出力 CSV は完全に決定的で、`preprocess` スクリプトは fit/transform の成果物（`stats/preproc_stats.json` と `stats/preproc_meta.json`）を再利用して追加検証を実施します。

### 5.7 dt-lstm エクスポート CLI（checkpoint + 温度 + TorchScript）

`dt-lstm export` は学習済みモデル (`model.pt`)、構成 (`config.json`)、語彙 (`vocab.json`)、温度スケーリング結果 (`calib.json`)、学習メタ (`train_meta.json`) を単一の `model.tar` に束ね、TorchScript 版 (`model.ts`) とコードハッシュ（`code_hash.txt`）を同梱します。`algo_ver` で互換性を管理し、バンドルだけで `dt-lstm infer --bundle` が再現できるため、ckpt ファイルを個別配布する必要がありません。

```bash
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli export \
  --ckpt ml/checkpoints/best.pt \
  --vocab ml/artifacts/vocab.json \
  --calib ml/artifacts/calib.json \
  --meta ml/artifacts/train_meta.json \
  --algo-ver 1 \
  --out ml/releases/model_v1.tar
```

アーカイブには以下のファイルが含まれます。

| ファイル | 内容 |
| --- | --- |
| `state_dict.pt` | CPU テンソルへ変換した学習済み重み |
| `model_def.json` | `DeltaTimeModelConfig` と `algo_ver` / `data` メタデータ |
| `vocab.json` | `dt-lstm fit` で生成した語彙（存在する場合） |
| `calib.json` | 温度スケーリング結果（未指定時はデフォルト 1.0） |
| `train_meta.json` | 語彙・Δt 統計などの学習メタ情報 |
| `model.ts` | TorchScript 変換済みモデル（ONNX 不要で Simulink/MATLAB 連携可能） |
| `code_hash.txt` | `git rev-parse HEAD`（取得できない場合は `unknown`） |

推論側では `--ckpt` / `--calib` を指定せず、`--bundle ml/releases/model_v1.tar` だけで同一スコアを再現できます。

### 5.8 dt-lstm 評価 CLI（AUROC/F1/遅延/ECE 等）

`dt-lstm eval` は、教師データ（`anomaly_label` 列を含む CSV）と推論済みスコア CSV（`neglog10_p` / `combined_p` など）を突合し、AUROC・F1・平均検知遅延・TopK 精度・RMTPP 負の対数尤度・ECE を決定論的に算出します。`alarm_active` や `spot_alarm_kofn` 列が存在する場合は K-of-N 判定をそのまま利用し、存在しない場合は F1 最大となるスコア閾値を自動選択します。

```bash
PYTHONPATH=packages/dt-lstm/src python -m dt_lstm.cli eval \
  --in data/test_feat/*.csv \
  --scored out/test_scored.csv \
  --out out/metrics.json \
  --bins 15
```

出力される `metrics.json` は `contract/schema/dt_lstm_metrics.schema.json` に準拠し、再実行してもバイト列が一致します。同一ディレクトリに PR 曲線（`*_pr_curve.png`）と校正図（`*_calibration.png`）も生成されます。

学習期の Δt 統計を固定化し、推論期にバイト完全一致の特徴量付与を行うため、`@logserver/dt-preproc` パッケージには `dt-preproc` CLI を用意しています。

```bash
# ビルド（初回のみ）
pnpm --filter @logserver/dt-preproc run build

# フィット：学習 CSV 群から統計を生成
pnpm exec dt-preproc fit \
  --in data/train/*.csv \
  --grouping uid_session \
  --epsilon-t 0.05 \
  --clip-max 300 \
  --robust-z-clip 5 \
  --window 10 \
  --quantiles 0.25,0.5,0.75 \
  --out stats/preproc_stats.json \
  --meta stats/preproc_meta.json

# 変換：保存済み統計を用いて特徴量を追記（RFC 4180 準拠のストリーミング処理）
pnpm exec dt-preproc transform \
  --in data/val/*.csv \
  --stats stats/preproc_stats.json \
  --window 10 \
  --quantiles 0.25,0.5,0.75 \
  --out data/val_feat/*.csv

※ `transform` で `--window` / `--quantiles` を省略した場合は、`fit` 時に保存した設定が自動的に再利用されます。

### 5.4 RFC4180 → テンソル データローダ CLI

`trainer.logserver.dataio.dataloader` は、前処理済み CSV をセッション単位に再構築し、`pack_padded_sequence` と因果マスクを備えたテンソルへ変換する内部ユーティリティです。

- 既定グループキーは `sid_final`。列が無ければ `generated_session_id` → `session_id` の順でフォールバックし、それでも不足する場合は UID ごとの Δt（Otsu + knee）から新しいセッション ID を合成します。
- 特徴ベクトルは `[cat_id, z_clipped, lburst, m25, m50, m75, z_deseas, dt_sec, t_i]` を固定順で連結し、`cat_id` 列が無い場合は `op_category` を辞書順で整数化します。
- 各セッション末尾には `session_end` フラグを立て、BPTT 切断時でもセッション境界を跨がないことを保証します。因果マスクは未来イベントを必ず遮断し、過去情報のみが参照されます。
- CLI 実行時は stdout に JSON ログを出力し、`torch.save` 形式で `categorical_padded`、`numeric_padded`、PackedSequence、`causal_mask` を保存します。同一 CSV（並び順が異なっても可）からは常に同一テンソルが得られます。

```bash
python -m trainer.logserver.dataio.dataloader \
  --input data/processed/events.csv \
  --output outputs/train/packed_sessions.pt \
  --device cuda:0
```

`pytest -k dataloader` でユニットテストを実行できます。Δt 閾値推定は Δt>0 のサンプルのみを用い、未来情報を利用しません。
```

`fit` サブコマンドは `preproc_stats.json` に `freezeFittedStats` の結果を保存し、`--meta` で指定したパス（例：`stats/preproc_meta.json`）にアルゴリズム情報を出力します。メタファイルは JSON/YAML のいずれにも対応し、内容は下記 3 フィールドのみです。

```json
{ "algo_ver": "5.0-spec", "epsilon": "min_half", "epsilon_value": 0.00075 }
```

- `algo_ver`: Δt 前処理アルゴリズムの仕様バージョン。
- `epsilon`: 推定方式（`min_half` 固定）。
- `epsilon_value`: Δt>0 の最小値の半分を 1e-6〜1e-2 にクリップした値（秒）。
  - 式: ε = max(1e-6, min(0.5 × min Δt_measured, 1e-2))

`transform` サブコマンドは `fit` で保存した統計とオプションを読み込み、入力 CSV をストリーミング処理して Δt 系特徴量列（`delta_seconds`, `delta_robust_z`, `delta_quantile_0_25` など）を追記した CSV を生成します。履歴が無い初期行は空欄（空文字）で埋め、NaN を出力しません。同じ統計ファイルを再利用する限り、出力 CSV/メタは完全に決定的です。

#### 単位不変性テスト（Unit Invariance Test）の読み解き方

`python -m trainer.scripts.preprocess` 実行後に生成される `data/processed/preproc_report.json` の `unit_invariance` セクションで、入力列の単位（秒・ミリ秒など）が想定と一致しているかを検証します。

- `status: "pass"` … フィット時と同じ単位であることを確認。
- `status: "warn"` … 平均や分散が基準から 3σ 以内だが僅かな差異あり。再サンプル推奨。
- `status: "fail"` … 大きな単位差（例：ミリ秒→秒）が検知される。`preproc_stats.json` の `options` を確認し、変換前に正規化を適用してください。

`unit_invariance.test_cases` には検証に用いた代表列（`delta_seconds`, `latency_ms` など）とテスト内容が記録され、閾値は `configs/default.yaml` の `preprocess.unit_invariance` セクションで調整できます。

### 5.6 シナリオ生成 CLI / API

- シナリオ定義は `configs/scenario_default.json` に外部化されており、環境変数 `SIM_SCENARIO_FILE` を指定すれば任意ファイルを優先読み込みします。
- CLI からは `ts-node` 経由で `scripts/simulate.ts` を実行し、件数・異常タイプ・シードなどを指定できます。
- `--seed` を省略した場合でも疑似乱数生成器を暗号学的シードで初期化し、レスポンスおよびマニフェストの `params.seed` / `params.seed_source` に保存します（`generated` または `provided`）。
- 実行時には `Simulate start` / `Simulate complete` の INFO ログが出力され、シナリオ ID、遷移数、異常戦略、Δt 閾値計算方式などが記録されます。運用ログを収集することで、同一シードでの再実行や実験差異の追跡が容易になります。
- Δt 分布は lognormal が前提であり、`normal` / `uniform` を指定すると Deprecation Warning を発行します。CLI の `--delta-epsilon` で ε フロア（秒）を 1e-6〜1.0 の範囲で制御でき、未指定時は `SIM_DELTA_EPSILON` または 1e-3 が適用されます。
- `--time-anomaly-mode` の既定値は環境変数 `SIM_TIME_ANOMALY_MODE`（未設定時は `auto`）から決定され、auto 時の伝搬比率は `--time-anomaly-prop-weight`（0〜1、既定 0.7）で制御します。
- CSV 出力の `timestamp_utc` 列は UTC 専用です。ローカルタイム表示は CLI 応答 JSON の `events[].timestamp` や GUI（例: `apps/splitter-gui`）で行います。

```bash
node -r ts-node/register/transpile-only scripts/simulate.ts \
  --count 50 \
  --anomalies time,auth \
  --seed 42 \
  --output-dir data/sim \
  --run-id cli-demo-001 \
  --pretty
```

### 5.7 Δt 前処理 CLI (`@logserver/dt-preproc`)

- TypeScript 製の Δt 特徴量生成 CLI を `packages/dt-preproc` に追加。`@logserver/csv-schema` による検証を通過した行のみを採用し、UID 単位で Δt を算出してクリッピング（`--clip-max`）、Δt ロバストスケーリング（median/MAD）、セッション内シーケンス番号・経過秒を付与します。
- `--ignore-uids` で除外する UID を CSV 形式で指定可能。特徴統計（Δt 中央値、MAD、測定・unknown 比率、クリップ件数など）は `--stats` で JSON 保存できます。
- `--window` で因果窓幅（既定 10）、`--quantiles` で R7 定義の分位点（既定 0.25, 0.5, 0.75）を制御し、出力 CSV には `delta_quantile_{prob}` と `delta_m{25,50,75}` の両列を追加します（履歴不足の行は空欄で埋め、NaN を生成しません）。
- CLI 実行前に `pnpm --filter @logserver/dt-preproc build` で `dist/` を生成してください。

```bash
pnpm --filter @logserver/dt-preproc build
node packages/dt-preproc/dist/cli.js --input artifacts/logs.csv \
  --output outputs/logs_with_feats.csv --stats outputs/dt_stats.json --pretty
```

### 5.8 セッション分割成果の静的監査

`scripts/audit.ts` は、セッション分割後の CSV と `meta.json` を静的に検証し、Δt と ΔT の整合性を確かめます。

```bash
pnpm --filter collector run audit -- --dir artifacts/sessions --fail-on-error
```

- 連続イベントで `sid_final` が変化する際に `Δt` > `ΔT` を満たしているかをチェックし、違反時はエラー終了。
- `time_label` の unknown 比率（`unknown_time_label_ratio`）、UID ごとの `ΔT`（`per_uid_delta_t`）、Otsu/knee の採用数（`method_usage`）を集計。
- 出力例:

```json
{
  "files": 2,
  "rows": 6400,
  "findings": 0,
  "unknown_time_label_ratio": 0.0125,
  "per_uid_delta_t": { "uid-1": 45.0 },
  "method_usage": { "otsu": 6, "knee": 2, "other": 1, "unknown": 0 },
  "sid_final_transition_checks": 188
}
```

### 5.9 Electron GUI（セッション分割サポート）

Electron ベースの GUI から CSV ログのセッション分割・閾値確認・ΔT 上書きを実施できます。

```bash
pnpm --filter @logserver/splitter-gui build
JWT_HMAC_KEY=... pnpm --filter @logserver/splitter-gui exec electron dist/main.js
```

- GUI 操作ランブック：
  1. 起動後に「Open CSV」をクリックし、`artifacts/` 直下のログファイルを選択。
  2. 左上の UID セレクタで対象ユーザを切替（MIMO 分離の観点）。
  3. ヒストグラムタブでは Δt 分布と Otsu 閾値を確認し、`ΔT Override` スライダで値を調整。
  4. `Preview Sessions` タブで変更後のセッション分割とラベルを確認。
  5. 「Export」を押下すると、`dist/export/<timestamp>/` に NDJSON + `thresholds.json` + `meta.json`（`preproc_meta.json` と同等の実行メタ付き）が生成されます。
  6. エクスポート後は `pnpm --filter @logserver/splitter-gui exec playwright test` で GUI の単体・統合テストを再確認してください。
- ΔT を変更するとプレビューが即時更新され、閾値一覧とセッション抜粋が再描画されます。
- 「エクスポート」は CLI (`@logserver/session-splitter-cli`) と同一構成（NDJSON + thresholds JSON + meta.json）で出力します。
- E2E テストは Playwright によりレンダラの主要要素を検証し、静的ビルドの品質を担保します。

#### 監査レポート（`preproc_report.json`）の読み方

`preproc_report.json` は以下の構造で前処理の品質を可視化します。

| フィールド | 内容 | 行動指針 |
| --- | --- | --- |
| `summary.total_rows` | 入力レコード総数 | 想定より少ない場合はセッション抽出の設定を確認 |
| `missing_counts` | 列ごとの欠損件数 | `event` など必須列に欠損があれば収集ロジックを修正 |
| `delta_t.stats` | Δt の平均/分位点/クリップ件数 | クリップ比率 >5% の場合は `--clip-max` を見直す |
| `unit_invariance` | 前述の単位検証 | `fail` の場合はログ生成/変換処理を再実行 |
| `sample_traces` | 代表セッションの before/after | GUI での確認対象として参照 |

報告書は `reports/` にコピーして監査ログとして保存することが推奨です。

```bash
pnpm --filter @logserver/splitter-gui exec playwright test
```

- CLI の出力および `/api/v1/simulations` POST のレスポンスは以下のフォーマットで統一されています（抜粋）。GUI では `summary` や `params` を利用してメタ情報を表示できます。

```json
{
  "scenarioId": "default-flow",
  "generated_at": "2024-11-01T09:00:00.000Z",
  "params": {
    "count": 50,
    "anomalies": ["timeDeviation", "authenticationBypass"],
    "seed": "42",
    "seed_source": "provided",
    "scenario_path": "configs/scenario_default.json",
    "anomaly_rate": 0.2,
    "persist": true,
    "max_steps": 64,
    "session_spacing_seconds": 180,
    "time_deviation_detector": {
      "method": "quantile",
      "quantile": 0.99,
      "min_samples": 5
    },
    "protocol_validator": {
      "enabled": true
    }
  },
  "summary": {
    "events": 50,
    "sessions": 4,
    "anomalies": {
      "normal": 44,
      "time_deviation": 4,
      "auth_failure": 2
    }
  },
  "files": {
    "csvPath": "data/sim/simEvents-cli-demo-001.csv",
    "manifestPath": "data/sim/scenario-cli-demo-001.json"
  },
  "events": [
    {
      "timestamp": "2024-11-01T09:00:00.500Z",
      "session_id": "sess-default-flow-001",
      "event": "login",
      "latency_ms": 142,
      "metadata": { "scenario": { "from": "start", "to": "authenticated" } }
    }
  ]
}
```

---

## 6. モデル概要（LSTM + Δt）

- **入力**：`(event_id, Δt, optional meta)` を時系列で与える。
- **表現**：`event_id -> embedding`、`Δt -> 連続値正規化 or log-bin embedding`。
- **出力**：
  - `p(next_event | history)`（クロスエントロピー）
  - `Δt_hat` または `p(Δt | history)`（MAE/ガウス尤度など）
- **異常スコア**：
  - `S_event = 1 - p(observed_next | history)`
  - `S_dt = |Δt - Δt_hat|` あるいは `-log p(Δt | history)`
  - `S = w1 * S_event + w2 * S_dt`（重みは config で指定）

---

## 7. 閾値設計

- **分位点法**：`τ = Quantile_q(S_normal)`。未知ドメインでも堅牢。
- **EVT-POT**：高分位のテールに一般化パレート分布（GPD）を当てはめ、確率保証のある `τ` を算出。
- **SPOT**：`τ = u + (β / ξ) × ((p_ref / q_star)^ξ - 1)`、`|ξ| → 0` では `τ = u + β × ln(p_ref / q_star)` に漸近し、`p_ref^*(y) = p_ref × exp(-y / β)` の指数極限で監視尾確率を再評価。
- **比ヒステリシス**：監視比 `s_evt = Δt_current / τ_current` が `1 / H` 以下になるまでアラームを保持（`H > 1`）。
- **粒度**：イベント単位 / セッション単位（集約関数：max, mean, topk-mean など）。
- **低サンプル時のバックオフ**：`await estimateThresholdsByUser(..., { min_events, backoff, concurrency, shard_dir })` で min_events (<50 など) 未満の UID を `user_agent_type` 単位→全体分布へ階層的にフォールバックし、`backoff_level` をメタに記録。
- **スケールアウト**：`concurrency` は WorkerThreads 数（CPU コア数と同値が既定）、`shard_dir` はストリーミング集計用の一時ディレクトリを明示指定（未指定時は `os.tmpdir()` に自動作成・自動削除）。

---

## 8. 説明可能性（Explainability）

- **Δt統計**：ユーザ・セッション・操作カテゴリ別の分布要約（分位点、外れ値範囲）。
- **ケース説明**：スコア寄与の高いタイムステップ、Δt の逸脱度合いをテキストと表で出力。
- **制御器としての直観**：Simulink でブロック図表示し、フィードバック挙動を**PID**と比較することで、
  速度・減衰・オーバーシュート等の“制御語彙”で解釈。

---

## 9. Simulink 連携ワークフロー

1. **重みエクスポート**：`src/simulink/export_weights.py` で `.mat` 等に LSTM 重みを出力。
2. **Simulink 取込**：`src/simulink/import_lstm.m` で Deep Learning Toolbox の LSTM Network として読み込み。
3. **評価シナリオ**：同じ参照入力（正常テンポ/遅延/外乱）で **LSTM** と **PID** を並走。
4. **可視化**：出力応答（追従誤差、立上り時間、整定時間、オーバーシュート）を数値比較。
5. **ユーザ別制御ブロック**：ユーザセグメント毎に LSTM ブロックを切替（例：ルックアップテーブル + スイッチ）。

> 図はリポジトリには含めませんが、Simulink モデルは `src/simulink/models/` に配置してください。

---

## 10. 実験用ログの自作

- `src/data/synth_logs.py` にて**正常シナリオ**（定常テンポ、許容揺らぎ）と、
  **異常シナリオ**（操作順序の破綻、**Δt の伸長/短縮**、スパイク）を注入。
- 乱数シード固定で**再現可能**なデータ生成。

---

## 11. 設定ファイル（例：`configs/default.yaml`）

- データ：入出力パス、セッションタイムアウト、操作カテゴリマップ
- 特徴量：イベント語彙サイズ、埋め込み次元、Δt エンコード法（連続/ビン）
- モデル：LSTM 層数・隠れ次元・ドロップアウト、損失の重み（event/dt）
- 学習：エポック、バッチサイズ、最適化、early stopping
- 異常スコア：重み `w1, w2`、集約関数
- 閾値：`method ∈ {quantile, pot}`, `q`, `tail_fraction`
- 乱数：seed、デバイス

---

## 12. 評価指標

- **イベント単位**：AUC-PR, F1, Precision@k, Recall@k
- **セッション単位**：F1、平均検知遅延（time-to-detect）
- **制御比較（Simulink）**：ISE/IAE、立上り/整定時間、最大オーバーシュート

---

## 13. 再現性 / ロギング

- 乱数シード固定、データ分割記録、学習ログ（ハイパパラメータ、検証スコア）を `runs/` に保存。
- モデルは `runs/<datetime>/` に保存、`last.ckpt` シンボリックリンクを作成。

---

## 14. よくある質問（FAQ）

- **Δt が欠損/ゼロの場合？**  
  タイムスタンプの同時刻は微小値に置換、欠損は最近傍補完 or マスク。選択は `configs/default.yaml` で指定。

- **Simulink を使わない場合？**  
  Python 内の可視化のみで完結可能。Simulink 比較はオプション。

- **PID のチューニングは？**  
  Ziegler–Nichols 等の初期値 + グリッドサーチ/最適化。設定は `configs/simulink.yaml` に記述。

---

## 15. 引用 / ライセンス

- 本研究成果を利用した場合は、卒業論文および関連セクション（2.3–2.9）を引用してください（IEEE形式推奨）。
- データは匿名化・権利クリア済みのもののみ格納してください。
- ライセンスは `LICENSE` を参照（未定の場合は研究用途のみ）。

---

## 16. 連絡先

- Author: Komei Ogata
- Affiliation: Tanaka Lab. / National institute of Technology, Kurume College
- Email: df360a@gmail.com

---

### 補足：本 README は **SRS.md**（要件定義）を補完し、研究実験を即時に再現/拡張できることを目標にしています。

## クイックスタート
1. 依存関係をインストール: pip install -r requirements_cpu.txt
2. データ配置: data/raw/ にログ CSV を置く（サンプルは data/sample/）
3. 前処理: python -m scripts.preprocess --config configs/default.yaml
4. 学習: python -m scripts.train --config configs/default.yaml
5. 推論: python -m scripts.score --config configs/default.yaml
6. 閾値と説明: python -m scripts.threshold --config configs/default.yaml → python -m scripts.explain --config configs/default.yaml

参照: SRS.md / CONSTRAINTS.md / dev_prompt.md

### 内側CVランダムサーチ（dt-lstm）
外側foldごとの学習データに対して、Rolling-origin + Purge/Embargo 付きの時系列CVでハイパーパラメータを探索します。

```bash
tscv search \
  --splits artifacts/splits/splits.yaml \
  --space configs/search_space.yaml \
  --n_trials 50 \
  --metric ap \
  --out artifacts/search_results.json
```

- `--splits`: foldごとの `train_sessions` / `validation_sessions` を記述したYAML。`dataset.processed_dir` `label_column` `timestamp_column` を含める。
- `--space`: `trainer`/`model`/`features` セクションで乱数探索するハイパーパラメータ分布を定義したYAML。
- 出力: ベスト構成を `--out` にJSONで書き出し、同階層に `<out>.jsonl` の全試行ログ（各trialのseed・fold指標・AP/ROC-AUC）を生成。種を固定すればベスト構成が再現できます。

探索中の特徴エンコーダはfoldごとの学習データでfit→検証へ凍結適用され、リークを防止します。

### 5.10 dt-lstm Electron ブリッジ（自己診断）
- ビルドと起動:
  ```bash
  pnpm --filter @logserver/lstm-gui build
  GPU_MODE=ada6000 pnpm --filter @logserver/lstm-gui exec electron dist/src/main.js
  ```
  - `.env` の `GPU_MODE` を省略した場合は現在のシェル環境変数が利用されます。`ada6000`（RTX 6000 Ada）/`4060`（RTX 4060）/`cpu` がサポート対象です。
- アプリ起動時に自動で `lstm.health` が実行され、メインウィンドウに以下の診断ダイアログが送信されます。
  1. **I/O 診断**：`artifacts/`・`outputs/`・`logs/` の存在と書き込み権限を検査し、`Permission denied` が発生する場合は Runbook 9.1 の権限復旧手順を参照してください。
  2. **ディスク容量**：リポジトリ直下の空き容量を `10 GiB` しきい値で評価します。未満の場合は Runbook 9.2 のクリーンアップ手順を実施してください。
  3. **GPU モード**：`GPU_MODE` と `CUDA_VISIBLE_DEVICES` を表示し、`nvidia-smi` が利用可能であれば検出した GPU 名称/メモリを列挙します。`nvidia-smi` が無い環境では自動的に CPU モードへフォールバックし、警告タグを表示します。
- 画面右上の「環境診断を開く」ボタンからいつでもダイアログを再表示できます。`再診断` ボタンを押すと即時に `lstm.health` を再実行し、結果が BrowserWindow へ再送されます。
- ダイアログには重大度タグ（重大/注意/OK）が表示され、エラー検出時は自動でモーダルが開きます。`logs/` パネルには従来どおり `lstm.progress` ストリームが追記されます。
