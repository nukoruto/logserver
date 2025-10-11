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
- **擬似匿名化**：JWT 等のトークンは HMAC-SHA256 により UID 化し、生値を永続化しない
- **LSTM モデル**：イベント埋め込み＋Δt 連続値/ビニングを入力、次イベント／Δt 予測による**予測誤差型**の異常検知
- **異常スコア**：予測確率の逸脱 + Δt 予測誤差/尤度を統合
- **閾値設計**：分位点（例えば上位 p%）/ EVT-POT による自動しきい化、セッション単位/イベント単位いずれも可
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
- `data/raw/` に CSV/JSONL 等でログを配置（カラム例：timestamp, user_id, action, meta...）。
- 付随情報（severity, module, params）は `meta` に JSON として保持してもよい。

### 4.3 環境変数ファイル (.env)
1. 雛形 `.env.example` を `.env` にコピーする。
   ```bash
   cp .env.example .env
   ```
2. `JWT_HMAC_KEY` には 128bit 以上の鍵（Base64 または Hex）を設定する。例:
   ```bash
   openssl rand -base64 32
   ```

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

---

## 5. 使い方（CLI の一例）

```
# 1) セッション化・特徴量化・Δt計算
python -m trainer.scripts.preprocess --config trainer/configs/default.yaml

# 2) LSTM 学習（Δt 併用）
python -m trainer.scripts.train --config trainer/configs/default.yaml

# 3) スコアリングと閾値設計（分位点 or EVT-POT）
python -m trainer.scripts.score --config trainer/configs/default.yaml
python -m trainer.scripts.threshold --config trainer/configs/default.yaml

# 4) 説明レポート（ケース単位）
python -m trainer.scripts.explain --config trainer/configs/default.yaml

# 5) NTP オフセットの手動計測（chronyc/ntpstat の動作確認）
cd collector && node scripts/check-ntp.js
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
- **粒度**：イベント単位 / セッション単位（集約関数：max, mean, topk-mean など）。

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

- Author: Your Name
- Affiliation: Your Lab / University
- Email: your.name@example.com

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
