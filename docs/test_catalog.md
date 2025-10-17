# テストスイート一覧と実行方法

## 0. 前提条件
- Node.js v20.12.2 以上、`corepack` で pnpm 9 系を有効化して依存を解決すること。
- TypeScript パッケージのビルド成果物（`dist/`）を参照するテストについては、事前に `pnpm -r run build` もしくは対象パッケージの `build` スクリプトを実行すること。
- Python 3.11 以上で `trainer/requirements_cpu.txt` または GPU 環境なら `trainer/requirements_cuda121.txt` をインストールしておくこと。
- ルートで `pnpm install` を実行し、Playwright を利用するテストでは `pnpm exec playwright install` によりブラウザ依存を準備する。

## 1. pnpm ワークスペース共通
- 一括実行: `pnpm test` でワークスペース内のすべての Node.js 系テストスクリプトを順番に呼び出す。

## 2. Node.js / TypeScript パッケージ

### 2.1 collector (Jest)
- 実行コマンド: `pnpm --filter collector test`
- 主な対象: 受信ログのサニタイズ、CSV シンク、Simulink 連携用シナリオ生成、NTP 監視など。
- テストファイルとケース:
  - `collector/tests/index.test.ts`（csvSinkMiddleware パイプライン）
    - sanitizes the logframe and warns when opCategory is missing
    - does not warn when opCategory middleware has been applied
  - `collector/tests/log_ingest.e2e.test.ts`（疑似匿名化の E2E 検証）
    - stores only pseudonymous uid in CSV exports
  - `collector/tests/middleware/logCapture.test.ts`（logCapture ミドルウェア）
    - populates logframe and strips sensitive headers
    - handles missing sensitive data gracefully
    - rejects unsupported HTTP methods with validation error
  - `collector/tests/middleware/opCategory.test.ts`
    - sets op_category on existing logframe
    - initialises logframe when missing
  - `collector/tests/ntp/offset.test.ts`
    - parses chronyc tracking output
    - falls back to ntpstat when chronyc is unavailable
    - throws when neither command yields an offset
  - `collector/tests/routes/health.test.ts`
    - returns ok when both subsystems are healthy
    - remains healthy when NTP checks are disabled
    - flags degradation when the CSV sink reports an error
    - signals initializing state when NTP samples are not ready
    - escalates to shutting_down when the sink is draining
  - `collector/tests/routes/metrics.test.ts`
    - formats Prometheus metrics with help and type metadata
    - falls back to NaN when the NTP offset is not yet available
  - `collector/tests/schema/logRecord.test.ts`
    - accepts valid records and normalises blankable fields
    - accepts optional response_bytes when present
    - rejects timestamps that are not RFC 3339
    - rejects unsupported HTTP methods
    - rejects operation categories outside the contract
  - `collector/tests/scripts/audit.test.ts`
    - passes on valid CSV input
    - fails when encountering invalid values with --fail-on-error
  - `collector/tests/scripts/simulate.test.ts`
    - shows help
    - generates a scenario and persists files
  - `collector/tests/security/noJwtLeak.test.ts`
    - does not leak raw JWT tokens in stored metadata
  - `collector/tests/services/ntpMonitor.test.ts`
    - reports disabled state without scheduling checks
    - raises warnings when percentile exceeds threshold and recovers afterwards
  - `collector/tests/services/simulationService.test.ts`
    - generates events, manifest metadata, and anomaly summary
    - produces identical sequences when the same seed is supplied
    - records generated seeds when none are provided
  - `collector/tests/sim/anomalyInjector.test.ts`
    - プロトコル順序違反としてログイン前操作を挿入する
    - 時間逸脱を注入しΔtが大きく変化する
    - 認証不備を注入しセッションIDとユーザIDを不正化する
  - `collector/tests/sim/labeler.test.ts`
    - 正常イベントに normal ラベルを付与し metadata.anomaly を設定する
    - プロトコル違反イベントに protocol_violation を付与する
    - 認証不備が検出されたイベントを auth_failure とする
    - 時間逸脱イベントを time_deviation としてラベル付けする
    - 異常注入時のマークから auth_failure を推定する
  - `collector/tests/sim/normalGenerator.test.ts`
    - 生成された系列が正常フローと確率遷移を順守する
    - 同一seedと開始時刻で系列が再現可能
    - Δtの正規分布指定を尊重して生成する
    - 最大ステップ数でループを安全に終了する
  - `collector/tests/sim/protocolValidator.test.ts`
    - 正常系列では違反フラグが立たない
    - 未認証操作を検出する
    - 重複ログインとログアウト後操作を検出する
    - セッション内のユーザID変化と不正な遷移を検出する
    - セッションID形式の異常とトークン使い回しを検出する
  - `collector/tests/sim/scenarioLoader.test.ts`
    - prefers configs/scenario_default.json when present
    - loads specific file path when provided
  - `collector/tests/sim/simWriter.test.ts`
    - CSV とマニフェストを生成し、異常サマリと Δt 統計を格納する
    - runId を自動正規化し、Δt が存在しない場合でも統計を返す
    - augmentRows で Δt 付与とラベルを生成し、オーバーライド関数を受け付ける
    - formatCsvAugmented で sid_final を session_id で補完し、CSV エスケープを保持する
  - `collector/tests/sim/timeDeviationDetector.test.ts`
    - 基準系列の分位点を用いて長いΔtを異常検知する
    - サンプル不足時はフォールバックしきい値を使用する
  - `collector/tests/sink/csvSink.test.ts`
    - writes header once and appends rows sequentially
    - quotes fields that contain commas, quotes, or newlines
    - rotates files daily
    - rotates files hourly when configured
    - preserves write order even when writes are concurrent
    - rejects new writes after shutdown is initiated
    - rejects records that violate the schema
    - exposes metrics and health status for monitoring
  - `collector/tests/validation/toValidationIssues.test.ts`
    - converts ZodError issues into ValidationIssue array
    - returns empty array when input is not a ZodError
  - `collector/tests/e2e/security.spec.ts`
    - redacts sensitive headers and keeps deterministic pseudonyms

### 2.2 @logserver/csv-schema（tsx --test）
- 実行コマンド: `pnpm --filter @logserver/csv-schema test`
- テストファイルとケース:
  - `packages/csv-schema/test/assignSessions.test.ts`
    - assignSessions splits only when measured delta exceeds threshold
    - assignSessions is stable and preserves row order metadata
  - `packages/csv-schema/test/computeDeltas.test.ts`
    - computeDeltas labels unknown region using epsilon thresholds
    - unknown share increases when epsilon_t grows with large NTP offset
    - computeDeltas promotes zero Δt to epsilon resolution
  - `packages/csv-schema/test/forEachUser.test.ts`
    - forEachUser groups rows by uid and sorts with stable keys
    - forEachUser resolves identical timestamps using row_index as tie-breaker
    - forEachUser discards later duplicates without row_index information
  - `packages/csv-schema/test/parseCsv.test.ts`
    - parses valid CSV rows with normalized timestamp and row index
    - row_index preserves ingestion order even when invalid rows are skipped
    - counts invalid RFC3339 timestamps and skips the row
    - rejects rows violating schema constraints
    - throws when required columns are missing in header
    - streams large files without buffering all rows in memory
  - `packages/csv-schema/test/parseEpochSec.test.ts`
    - parses RFC3339 timestamps with microseconds precisely
    - parses RFC3339 timestamps with nanosecond precision into double
    - rejects invalid calendar dates
    - rejects malformed timestamps

### 2.3 @logserver/dt-preproc（Vitest）
- 実行コマンド: `pnpm --filter @logserver/dt-preproc test`
- テストファイルとケース:
  - `packages/dt-preproc/src/__tests__/rollingQuantilesR7.test.ts`
    - computes Hyndman-Fan R7 quantiles for canonical sample
    - handles leading edges without NaN and matches available data
    - ignores non-finite values and clamps probabilities
    - remains monotonic for heavy-tailed and skewed samples
    - matches sorted order even when inputs arrive unsorted
  - `packages/dt-preproc/test/cli.e2e.test.ts`
    - dt-preproc CLI fits and transforms CSV end-to-end
  - `packages/dt-preproc/test/computeFeatureRows.test.ts`
    - computeFeatureRows annotates symmetric log burst for consecutive measured Δt
    - computeFeatureRows emits causal rolling quantiles without NaN
  - `packages/dt-preproc/test/goldenPipeline.test.ts`
    - loadLogRowsWithFeatures produces stable golden output
  - `packages/dt-preproc/test/hourOfUTC.test.ts`
    - hourOfUTC extracts UTC hour for integer timestamps
    - hourOfUTC truncates fractional seconds before conversion
    - hourOfUTC throws for non-finite inputs
    - hourOfUTC rejects timestamps that overflow Date range
  - `packages/dt-preproc/test/lburst.test.ts`
    - returns zero when both deltas vanish
    - clamps large positive ratio to clip bound
    - clamps large negative ratio to clip bound
    - handles alternating minima and maxima without divergence
    - uses epsilon floor to avoid division by zero for extreme ratios
  - `packages/dt-preproc/test/robust.test.ts`
    - clip clamps values symmetrically with default limit
    - clip supports custom limit
    - computeFeatureRows normalizes epsilon inputs
    - robust z-score falls back to global statistics when user variance is zero
    - robust z-score is approximately invariant under unit scaling
    - session-level stats back off to user aggregates when below minSamples
    - user-level stats back off to global aggregates when user is sparse
    - seasonal residual reduces correlation with global z
    - thawFittedStats loads frozen per-uid robust log-delta statistics without recomputation
    - thawFittedStats supports uid+session grouping from frozen fixture
    - updateStatsStreaming keeps statistics frozen when alpha is zero
    - updateStatsStreaming trims extremes and respects drift limit
    - updateStatsStreaming bounds per-step drift under repeated outliers
    - computeFeatureRows is deterministic for identical inputs
    - StreamingFeatureTransformer maintains prefix stability (causality)
    - StreamingFeatureTransformer matches thawed statistics replay
  - `packages/dt-preproc/tests/determinism.spec.ts`
    - produces identical feature rows for identical fitted stats
  - `packages/dt-preproc/tests/epsilon.min.spec.ts`
    - returns half of the smallest positive delta when within clip bounds
    - clips epsilon to lower bound when min delta is extremely small
    - clips epsilon to upper bound when min delta is large
    - ignores non-positive, NaN, and infinite values
    - falls back to default when no valid deltas exist

### 2.4 @logserver/dt-anom（Vitest）
- 実行コマンド: `pnpm --filter @logserver/dt-anom test`
- テストファイルとケース:
  - `packages/dt-anom/test/fit-and-score.test.ts`
    - fits stats and scores stream with audit output
    - recalibrates xi/beta when sufficient tail samples arrive
  - `packages/dt-anom/tests/cli.e2e.spec.ts`
    - fits and scores via CLI commands
  - `packages/dt-anom/tests/gpd.limit.spec.ts`
    - spotThreshold matches exponential limit as xi approaches 0
    - pValueRef follows exponential tail as xi approaches 0
  - `packages/dt-anom/tests/hysteresis.spec.ts`
    - holds alarm state until s_evt falls below 1/H when H=1.1
  - `packages/dt-anom/tests/spot.alarm.spec.ts`
    - reduces alarm count when tau increases and keeps neglog10_p monotonic

### 2.5 @logserver/session-splitter（Node.js test runner）
- 実行コマンド例:
  1. `pnpm --filter @logserver/session-splitter build`
  2. `node --test packages/session-splitter/test/*.test.ts`
- テストファイルとケース:
  - `packages/session-splitter/test/backoff.test.ts`
    - hierarchical backoff provides stable thresholds for sparse users
  - `packages/session-splitter/test/bimodalityFallback.test.ts`
    - unimodal distributions fall back to knee threshold
  - `packages/session-splitter/test/kneeThreshold.test.ts`
    - knee detection is stable for noisy staircase curves
  - `packages/session-splitter/test/logHistogram.test.ts`
    - makeLogHistogram enforces minimum bin count of 32
    - makeLogHistogram enforces maximum bin count of 512
    - otsuThreshold returns stable log-domain boundary on bimodal mixture
  - `packages/session-splitter/test/meta.test.ts`
    - writeMeta outputs schema-compliant JSON with dataset hash
  - `packages/session-splitter/test/sessionId.test.ts`
    - makeSid is deterministic for identical inputs
    - makeSid changes when any component differs
  - `packages/session-splitter/test/shardCleanup.test.ts`
    - temporary shards are removed after estimation
  - `packages/session-splitter/test/speedBench.test.ts`
    - worker concurrency reduces estimation wall time

### 2.6 @logserver/session-splitter-cli
- 実行コマンド: `pnpm --filter @logserver/session-splitter-cli test`
- テストファイルとケース:
  - `packages/session-splitter-cli/__tests__/e2e/split_sessions.spec.ts`
    - session-splitter CLI respects ntp offset and secrecy
    - split-sessions fails fast when JWT key is missing
  - `packages/session-splitter-cli/test/bulk.e2e.test.ts`
    - split-sessions CLI produces golden CSV and meta

### 2.7 @logserver/splitter-gui（Playwright）
- 実行コマンド:
  1. `pnpm --filter @logserver/splitter-gui build`
  2. `pnpm --filter @logserver/splitter-gui run test:e2e`
- ブラウザ依存のため初回のみ `pnpm exec playwright install` が必要。
- テストファイルとケース:
  - `apps/splitter-gui/tests/e2e.spec.ts`
    - renderer renders expected controls and layout without data

## 3. Python トレーナー（pytest）
- 実行コマンド例:
  1. `python -m venv .venv && source .venv/bin/activate`
  2. `pip install -r trainer/requirements_cpu.txt`
  3. `pytest -q trainer/tests`
- テストファイルと関数:
  - `trainer/tests/test_features.py`
    - test_encode_dataframe_returns_arrays
    - test_encode_dataframe_with_optional_response_bytes
    - test_build_feature_pack_enables_dt_features_when_present
    - test_build_feature_pack_dt_missing_columns_falls_back
    - test_choose_epsilon_quantile_and_clipping
    - test_robust_z_quantiles_align_with_normal_distribution
    - test_robust_z_unit_invariance_between_seconds_and_milliseconds
    - test_summarize_stats_returns_dataclasses
    - test_summarize_stats_requires_complete_columns
  - `trainer/tests/test_preproc_report.py`
    - test_generate_preproc_report
  - `trainer/tests/test_scoring_anomaly.py`
    - test_moving_average_returns_original_for_small_window
    - test_moving_average_applies_smoothing
  - `trainer/tests/test_scoring_threshold_cli.py`
    - test_compute_threshold_handles_nan_skip
    - test_run_success_writes_outputs
    - test_run_skips_when_no_valid_scores
    - test_run_abort_removes_partial_outputs
    - test_run_keep_partial_preserves_files
    - test_run_dump_eval_and_hist
    - test_run_dump_eval_missing_annotation
  - `trainer/tests/test_sessionize.py`
    - test_sessionize_computes_delta
    - test_sessionize_rejects_raw_token_columns
  - `trainer/tests/test_threshold.py`
    - test_decide_threshold_prefers_user_estimate_when_sufficient
    - test_decide_threshold_backoff_to_group_for_sparse_user
    - test_decide_threshold_backoff_to_global_when_group_unavailable
    - test_decide_threshold_uses_otsu_when_knee_missing
    - test_decide_threshold_rejects_non_finite_tau
    - test_decide_threshold_ignores_nonfinite_knee
    - test_select_best_estimate_returns_first_available_when_all_sparse
  - `trainer/tests/test_trainer.py`
    - test_train_model_produces_artifacts
    - test_train_model_with_response_bytes

## 4. 付記
- 各テストは乱数シードや設定ファイルを明示的に固定しているため、SRS の再現性要件に沿って再実行が可能。
- 研究用途で GPU を切り替える際は環境変数 `GPU_MODE=ada6000|4060` を設定し、Python テストは `CUDA_VISIBLE_DEVICES` を適宜制御する。
