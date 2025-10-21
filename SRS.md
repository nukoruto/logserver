# ソフトウェア要求仕様書 (Software Requirements Specification, SRS)

## 0. ドキュメント情報
- プロジェクト名: セッション操作系列に対する LSTM ベース異常検知と制御可視化  
- バージョン: 1.3  
- 作成日: YYYY-MM-DD  
- 作成者: <Your Name>

## 1. 目的
Web セッションの操作系列を制御工学の枠組みで再解釈し、LSTM による時系列異常検知を確立・評価する。  
主眼は (1) イベント間隔 Δt の活用、(2) MATLAB/Simulink 上での LSTM（深層制御器）と PID（古典制御器）の同条件比較、(3) MIMO の観点からユーザ別ブロック分離（非干渉化）による出力応答の可視化と説明可能性向上。

## 2. スコープ
- 入力: セッションログ（操作種別、タイムスタンプ、ユーザ/セッション ID、メタ情報）  
- 出力: 異常スコア時系列、異常フラグ、可視化（ブロック図レベルの構造・出力応答）、評価レポート  
- 含む: データ収集と前処理、LSTM 学習/推論、閾値設計、Simulink 実装、PID 比較、MIMO 非干渉化、可視化  
- 含まない: 本番常時監視、外部脅威インテリジェンス連携

## 3. 用語定義
- セッション操作系列: login、view、edit、logout 等の時間順イベント列  
- 正常系列: 定義フローに従う系列  
- 異常系列: 順序逸脱、未認証操作、トークン流用、異常な Δt など  
- Δt: 隣接イベント間の時間間隔（秒）  
- LSTM 制御モデル: LSTM を制御器とみなし、予測誤差または再構成誤差を異常度とするモデル  
- PID 制御: 比較対象の古典制御器（同一入出力・外乱で比較）  
- 非干渉化（MIMO）: 多ユーザ/多チャネル間の干渉を低減する設計

## 4. 関係者
- 研究代表: 要件承認、方向性決定  
- 実装担当: データパイプライン、学習・推論、Simulink 実装  
- 評価担当: 指標設計、実験・検証、報告

## 5. システム概要（アーキテクチャ）
1. データ層: シナリオ駆動ログ生成（TypeScript シミュレーション）、永続化（CSV/Parquet）  
2. 前処理層: セッション分割、イベント埋め込み、Δt 付与、標準化  
3. 学習層: LSTM（予測型または再構成型）学習、検証  
4. 推論層: 異常スコア算出、オンライン/バッチ推論  
5. 可視化/制御層: Simulink（LSTM/PID）でブロック化、出力応答の可視化、MIMO 非干渉化

## 6. データ要件
### 6.1 収集
- ランタイム: Node.js v20 以上（シミュレーション CLI）  
- 収集対象: テストシナリオに基づく正常ログ、自動/半自動生成の異常ログ（順序逸脱、再送、Δt 異常など）  
- 保存形式: CSV または Parquet（列指向推奨）
- タイムゾーン: UTC で統一
- 収集直後に `tools/audit_missing.py` で必須列ごとの comp(c) = 1 - missing_count(c) / N を計測し、全必須列で 1.0 を満たさない場合は CI を失敗させる。
- 永続化時に `fair.json`, `datasheet.json`, `provenance.json` を同時生成し、`csv_sha256`, `schema_sha256`, `git_commit`, `seed`, `gpu_mode` を記録する。
- Authorization ヘッダ（Bearer JWT）は取り込み時のみ必須とし、`uid = hex(HMAC_SHA256(secret, jwt_utf8))` を導出した直後に破棄する。CSV や metadata には保存せず、CI でも流出を検知して失敗させる。

### 6.2 基本データ契約（10 列）
- timestamp_utc（UTC epoch 秒 double。必要に応じて別途 RFC 3339 文字列を派生保存）
- uid（擬似匿名化済みユーザ ID。HKDF-SHA256 で導出した K_ds による HMAC-SHA256 を hex エンコード）
- session_id（文字列）
- method（HTTP メソッド）
- path（リソース識別子）
- referer（参照元 URL。欠損は空文字も可）
- user_agent（クライアント識別子）
- ip（IPv4/IPv6。疑似化済み）
- cookie（擬似匿名化済みセッションクッキー。uid から決定的生成し、生 JWT/生クッキーは保存しない）
- op_category（AUTH / READ / UPDATE の 3 区分）

- path 正規化は `normalize_request_path` ヘルパー（TypeScript 実装: `normalisePathTemplate` in `packages/dt-preproc/src/template.ts`, Python 実装: `_normalise_path_template` in `trainer/src/logserver/dataio/sessionize.py`）で行い、以下の規則を統一適用する。
  1. ASCII 英字は小文字化する（大文字を保持するケースは `preserve_case=True` 指定時のみ）。
  2. スキームとホスト部分を除去し、先頭 `/` 付きパスのみを残す。
  3. 連続スラッシュを 1 つに圧縮し、末尾スラッシュはルート以外では除去する。
  4. 安全文字 (`A-Z`, `a-z`, `0-9`, `-._~`) はデコードしてから RFC 3986 準拠で再エンコードする（`%` は大文字）。
  5. クエリパラメータはキーを UTF-8 コード順に、値をキー内で昇順にソートし、`+` ではなく `%20` を用いる。
  6. 正規化後にクエリが空なら `?` を削除する。

### 6.3 派生特徴・ラベル（別工程）
- Δt 系列（dt_sec, log_dt, delta_z, delta_robust_z, delta_quantile_0_25/0_5/0_75 等）
- 応答時間統計（latency_ms、移動平均・分位点）
- 連続特徴量のロバスト正規化値（z_clipped, z_deseas など）
- 異常スコア（Score_total, neglog10_p 等）
- 異常ラベル（anomaly_label, alarm, alarm_reason 等）

これらの派生列は 10 列 CSV を入力として `dt-preproc fit/transform` → `trainer.scripts.score` → `trainer.scripts.threshold` の順に生成し、成果物は data/processed/, outputs/, reports/ 以下へ保存する。

## 7. 前処理要件
- セッション整形: session_id 単位で時系列ソート  
- Δt 計算: Δt_t = timestamp_t - timestamp_t-1（秒）、有効サンプル集合の最小値を min Δt_measured とすると測定許容値 ε は ε = max(1e-6, min(0.5 × min Δt_measured, 1e-2)) で固定
- カテゴリ: 事前定義語彙でエンコード（埋め込み利用）
- テンプレート ID: method/path/op_category から正規化 (`AUTH::GET::dashboard` 形式) し、Python/TypeScript 共通ヘルパーで決定的に生成する
- 数値特徴: 標準化（学習データの平均・分散を保存して再利用）
- 入力テンソル: 時刻 t の特徴ベクトル = [event_embed, Δt, latency, status, …]  
- 分割: train/val/test = 7/1/2（セッション単位）  
- 欠損: イベントは専用トークン、数値は中央値補完

## 8. 機能要件
### 8.1 学習モデル
- 予測型 LSTM: 直近ウィンドウから次ベクトルまたは次イベント分布を予測  
- 再構成型 AE-LSTM: 入力系列の復元誤差で異常度算出  
- 埋め込み次元: 128～256、LSTM 層数: 1～2、ユニット数: 64～256

### 8.2 推論と異常判定
- ウィンドウ推論（滑動またはセッション終端で一括）  
- スコア平滑化（移動平均/メディアン）に対応

### 8.3 Simulink 実装（可視化・比較）
- LSTM ブロック（From Workspace → LSTM Net → To Workspace）  
- PID ブロック（標準 PID）  
- 同一参照入力・同一外乱で応答比較（立上り時間、オーバーシュート、整定時間、定常偏差、IAE/ISE）  
- ユーザ別ブロック分離（MIMO 類推）と簡易非干渉ゲインで干渉低減の効果確認

## 9. 非機能要件
- 再現性: スクリプトで収集→前処理→学習→評価を自動化、乱数種固定。シナリオ生成 API (`simulationService.generateScenario`) はシード指定/自動生成値を常にマニフェストとレスポンス `params.seed` / `params.seed_source` に保存し、INFO ログ（`Simulate start` / `Simulate complete`）にシナリオ ID・遷移確率・Δt 閾値計算法・異常戦略を残す。
- 可搬性: Python 3.12、PyTorch 2.x または TensorFlow 2.12+、MATLAB R2023b+  
- 透明性: 設定は YAML 外部化、実験ごとにアーティファクト保存（学習曲線、指標 JSON、モデルハッシュ）  
- 速度目標: 100 万イベント相当の 1 エポックを 30 分未満（A100 40GB 目安）  
- 監査性: 実験ログと生成物を一元保存し、セッション分割 CLI では `meta.json` に τ 系統計・鍵 ID・データセット SHA-256 を必ず残す

## 10. 評価指標
### 10.1 検知性能
- Precision、Recall、F1、AUROC、AUPRC（イベント単位/セッション単位両方）
- 閾値 CLI (`trainer.scripts.threshold`) の `--dump-eval` は、アノテーション（例: `boundary_annotation`）が存在する場合に境界検出の F1 / Jaccard / Variation of Information を JSON で出力し、論文用図表生成へ直接利用できる形式とする。
- 同 CLI の `--dump-hist` は異常スコア分布のヒストグラムデータ（bin 辺、中心、密度、要約統計）を JSON 化し、二峰性の可視化や閾値設計レポートに再利用できること。

### 10.2 制御性能（Simulink 応答）
- 立上り時間、オーバーシュート（%）、整定時間、IAE/ISE、定常偏差  
- LSTM と PID の同条件比較

### 10.3 可視化
- 応答曲線、異常スコア時系列、混同行列、PR/ROC

## 11. 異常スコアと閾値設計（Word 互換のプレーンテキスト式）
### 11.1 スコア定義
- 予測型 LSTM:  
  Score(t) = || y_t - ŷ_t ||^2  
- 再構成型 AE-LSTM:  
  Score(t) = || x_t - x̂_t ||^2  
- Δt 追加成分（重み付き）:  
  Score_Δ(t) = α × || Δt_t - Δt̂_t ||^2  
- 総合スコア（例）:  
  Score_total(t) = Score(t) + Score_Δ(t)

### 11.2 閾値設計
- 平均・分散方式:
  θ = μ_normal + k × σ_normal（k は 2 または 3 など）
- 分位点方式:
  θ = Q_p(Score_normal)（p は 0.99 など）
- SPOT 式（極値理論）:
  τ = u + (β / ξ) × ((p_ref / q_star)^ξ - 1)、|ξ| → 0 の極限は τ = u + β × ln(p_ref / q_star)、p_ref = 基準尾確率、q_star = 監視対象の尾確率
- 参照確率:
  p_ref^*(y) = p_ref × exp(-y / β) （ξ → 0 極限）
- セッション判定（多数決/積分）:
  A(session) = 1[ Σ_t 1( Score_total(t) > θ ) ≥ m ]
- 比ヒステリシス:
  アラーム保持指標 s_evt = Δt_current / τ_current とし、H > 1 のとき解除条件は s_evt ≤ 1 / H

## 12. 実験計画（ハイレベル）
1. 正常/異常ログ生成 → スナップショット固定（seed、バージョン）  
2. 前処理（セッション化、Δt 付与、埋め込み）→ 統計保存  
3. LSTM 学習（早期終了、ハイパラ探索）→ ベストモデル固定  
4. 推論・スコア化 → 閾値設計（統計/分位点）→ 指標算出  
5. Simulink 実装（LSTM/PID）→ 同一外乱・参照入力 → 応答計測  
6. MIMO/ユーザ別ブロック分離 → 非干渉ゲイン簡易同定 → 応答比較  
7. 結果のレポート化（図表、表、JSON 指標）

## 13. 受け入れ基準（例）
- F1（イベント単位） 0.85 以上、AUROC 0.95 以上  
- オーバーシュート（%）は LSTM ≤ PID（同条件）  
- Δt 異常に対する AUPRC がベースライン比 +5pt 以上  
- make all 相当の一括実行で end-to-end が再現

## 14. リスクと緩和策
- クラス不均衡: 分位点閾値、重み付き損失、平滑化で過検知抑制  
- ドメインドリフト: 正常統計の定期更新、ドリフト検知  
- Simulink 互換性: R2023b で LSTM レイヤ動作を事前確認  
- 過学習: 厳格な検証分割、早期終了、外部検証データ

## 15. 実装方針（ディレクトリ）
- repo/
  - README.md
  - SRS.md
  - CONSTRAINTS.md
  - Makefile
  - collector/（ログシミュレーション CLI。TypeScript 実装）
    - package.json / package-lock.json
    - server.js
    - src/（config, middleware, routes, services, storage, utils）
  - trainer/（Python 3.11 + PyTorch 学習・推論基盤）
    - configs/（実験設定 YAML）
    - scripts/（前処理、学習、推論、閾値、説明、Simulink エクスポート CLI）
    - src/logserver/（dataio, features, models, scoring, explain, simulink, training）
    - tests/（pytest ベースの単体・統合テスト）
    - requirements_*.txt（CPU/GPU 向け依存定義）
  - contract/（データ契約ドキュメントと設定）
  - artifacts/（収集成果物、Git 管理外）
  - outputs/（学習成果物、Git 管理外）

## 16. 追跡性マトリクス（抜粋）
- FR-01: Δt を特徴量として入力 → scripts/preprocess.py → tests/test_preprocess.py  
- FR-02: 予測型/再構成型 LSTM → scripts/train.py → tests/test_train.py  
- FR-03: 分位点閾値 → scripts/thresholds.py → tests/test_thresholds.py  
- FR-04: Simulink LSTM/PID 比較 → simulink/*.slx → tests/test_sim_compare.m  
- FR-05: ユーザ別ブロック分離 → simulink/user_blocks.slx → tests/test_user_blocks.m  
- NFR-01: 再現性自動化 → Makefile → CI green  
- NFR-02: 監査性（成果物保存） → reports/*.json → 生成物存在検査

## 17. 本研究の特徴・位置づけ（要約）
- Δt を組み込む LSTM 制御モデルで時間的異常（遅延・間欠）への感度を強化  
- Simulink で LSTM と PID を同条件比較し、ブロック図レベルの構造と応答で解釈性を向上  
- ユーザ別ブロック分離（MIMO 非干渉化）により系列干渉の影響を可視化・定量化  
- 先行知見（系列学習・時間特徴・説明可能性）を統合し、可視化と指標で説得力ある検証を実現
