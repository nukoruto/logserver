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
- **セッション化 / 前処理**：ユーザID・タイムアウトでセッション分割、操作カテゴリ（抽象化）付与、Δt 計算
- **擬似匿名化**：JWT 等のトークンは `K_ds = HKDF_SHA256(JWT_HMAC_KEY, info="sid")` から得た鍵で HMAC-SHA256 を適用し、生値を永続化しない（`kid` は `.env` や `metadata.json` に記録）
- **LSTM モデル**：イベント埋め込み＋Δt 連続値/ビニングを入力、次イベント／Δt 予測による**予測誤差型**の異常検知
- **異常スコア**：予測確率の逸脱 + Δt 予測誤差/尤度を統合
- **閾値設計**：分位点（例えば上位 p%）/ EVT-POT による自動しきい化、セッション単位/イベント単位いずれも可
- **閾値メタ生成**：セッション分割 CLI は `meta.json` にアルゴリズムバージョン、Δt 関連統計、鍵情報、データセット SHA-256 を保存し、追試・監査を支援
- **説明可能性**：Δt 統計（分布・区間）および特徴寄与度の算出、ケース単位の簡易説明レポート
- **Simulink 連携**：学習済み LSTM の重みをエクスポートして Simulink に取り込み、**PID** と**同一条件**で追従・外乱応答・過渡応答を比較
- **ユーザ別制御ブロック**：ユーザセグメントごとにコントローラを切替／分離し、セグメント特性（操作テンポなど）に最適化
- **NTP オフセット監視**：`chronyc tracking` または `ntpstat` を解析し、95 パーセンタイルが 50ms を超過した場合は `/healthz` を 503 に切り替えて警告ログを出力

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
│   ├─ server.js
│   └─ src/
│       ├─ app.js
│       ├─ config/
│       ├─ middleware/
│       ├─ routes/
│       ├─ services/
│       ├─ storage/
│       └─ utils/
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

---

## 4. セットアップ

### 4.1 依存関係
本リポジトリは Node.js（収集・Web UI）と Python（学習・解析）が同居する **pnpm モノレポ** です。Node.js 側のパッケージは `pnpm` で統一管理し、Python 側は従来どおり `pip` または `conda` を利用します。セットアップ時は以下の順に依存関係を整えてください。

1. Corepack で `pnpm@9.0.0` を有効化し、モノレポ全体の Node.js 依存を解決します。

   ```bash
   corepack enable
   corepack prepare pnpm@9.0.0 --activate
   ```

   有効化後にリポジトリルートで以下を実行すると、`collector/` や `apps/` など Node.js サブパッケージの依存がまとめて導入されます。

   ```bash
   pnpm install
   ```

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
- `data/raw/` に CSV/JSONL 等でログを配置（カラム例：timestamp, uid, action, meta...）。応答ボディのサイズを表す `response_bytes`
  列を末尾に追加しても旧スキーマはそのまま動作し、新列がある場合のみ下流の LSTM 前処理で特徴量として利用される。
- 付随情報（severity, module, params）は `meta` に JSON として保持してもよい。
- `data/sim/` はシミュレーション API やシナリオ生成結果の既定保管先（`SIM_LOG_DIR` 未設定時）。CSV（`simEvents-<run-id>.csv`）とマニフェスト（`scenario-<run-id>.json`）が保存される。

### 4.3 環境変数ファイル (.env)
1. 雛形 `.env.example` を `.env` にコピーする。
   ```bash
   cp .env.example .env
   ```
2. `JWT_HMAC_KEY` には 128bit 以上の鍵（Base64 または Hex）を設定する。例:
   ```bash
   openssl rand -base64 32
   ```
3. `SID_KEY_ID` には鍵バージョンを示す識別子を設定する。例: `sid-fixture-202406`。`JWT_HMAC_KEY` からは自動的に `K_ds = HKDF_SHA256(JWT_HMAC_KEY, info="sid")` を導出し、UID/セッション ID の擬似化に用いる。

### 4.4 Docker コンテナ (収集サーバ)

収集サーバは `node:20-alpine` ベースの Docker イメージを同梱しています。再現性の高い実行環境が必要な場合は、以下でコンテナを起動してください。

```bash
docker compose up --build
```

- `LOG_DIR` は `/var/log/logserver` としてボリューム化され、ホスト側の `./artifacts/` に永続化されます。
- `GPU_MODE` を `ada6000` または `4060` に設定すると、エントリポイントが `CUDA_VISIBLE_DEVICES` を自動調整します（学習系と同一規約）。
- `.env` をルートに配置すると Compose が自動で読み込みます。研究用の既定鍵として `c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=` を用意しています。

コンテナ起動後、`http://localhost:8000/api/v1/health` が 200 を返却すれば準備完了です。停止は `docker compose down` を利用してください。

### 4.5 サンプルデータ生成

研究用の安定した統計量をもつ CSV を生成するために、ヘッドレスクライアントによるセッション操作のシードスクリプトを用意しています。

```bash
cd collector
npm run seed
```

- `JWT_HMAC_KEY` が未設定の場合は上記コマンドが再現性保証用の固定キーを自動適用します。
- デフォルトで 220 セッション、1,000 行以上のイベントを `/api/v1/events` に送信し、`artifacts/` 以下へ CSV を蓄積します。
- `SEED_SESSION_COUNT` や `SEED_INTERVAL_MS` 等の環境変数でシナリオを調整できます。
3. `LOG_DIR` や `CSV_ROTATION` など、運用に合わせて値を調整する。
4. `.env` には秘匿情報が含まれるため **Git へコミットしないこと**。必要に応じて `.gitignore` や `git update-index --skip-worktree .env` を利用する。
5. Node.js 側では `dotenv` により `.env` が自動ロードされる。別パスを使用したい場合は `CONFIG_PATH` 環境変数を指定する。
6. NTP 計測コマンド（`chronyc` または `ntpstat`）が利用できない環境では、`NTP_MONITOR_DISABLED=true` を設定して監視を明示的に停止する。

主な環境変数（一部抜粋）:

| 変数名 | 既定値 | 説明 |
| --- | --- | --- |
| `SIM_LOG_DIR` | `data/sim` | シミュレーションで生成されたイベント CSV とマニフェストの保存先。絶対パス／相対パスいずれも指定可能。 |

---

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

# 5) NTP オフセットの手動計測（chronyc/ntpstat の動作確認）
cd collector && node scripts/check-ntp.js
```

- 前処理 CLI 実行後は `data/processed/preproc_report.json` が生成され、前処理前後の統計量・欠損/"unknown" 件数・分位差・単位不変性判定、任意 5 ユーザの変換トレースを含む監査レポートとして保存されます。

- 閾値 CLI は入力スコア CSV の SHA-256 を冒頭で計算し、`threshold.json` のメタ情報に保存します。フォールバック理由（NaN/空グループなど）も JSON ログおよびメタに明記されます。
- `--on-error` は `abort`（既定、部分成果物を削除）と `keep-partial`（`.partial` 拡張子で保持）を切替でき、運用事故時の調査を容易にします。
- `--dump-eval` オプションを指定すると、`boundary_annotation` 等のアノテーション列が存在する場合に境界検出の F1 / Jaccard / Variation of Information を JSON で出力します（図表生成用）。
- `--dump-hist` を指定すると、異常スコアのヒストグラム（bin 辺・中心・密度・要約統計）を JSON 形式で保存し、二峰性の可視化にそのまま利用できます。`--hist-bins` でビン数を調整できます。

### 5.1 Δt ロバスト統計フィッティング CLI（Fit / Transform ランブック）

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

各コマンドは `--help` で詳細を確認できます。`dt-preproc transform` の出力 CSV は完全に決定的で、`preprocess` スクリプトは fit/transform の成果物（`stats/preproc_stats.json` と `stats/preproc_meta.json`）を再利用して追加検証を実施します。

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
