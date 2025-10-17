# テストスイート一覧と実行方法

本ドキュメントは、本リポジトリに存在する手動保守対象のテストをすべて列挙し、想定フレームワークと実行コマンドを整理したカタログである。`node_modules/` 以下など依存パッケージに付属するテスト資産は対象外とする。

## 共通前提
- Node.js: v20.12.2（pnpm ワークスペースの `packageManager` 設定に準拠）
- Python: 3.11 以上（トレーナー側の pytest に合わせる）
- パッケージマネージャ: `pnpm@9.0.0`、`pip` もしくは `conda`
- ルートで `pnpm install` 実行済みであること
- Python 依存は `pip install -r trainer/requirements_cpu.txt` などで解決済みであること

## 全体サマリ
| サブシステム | テストランナー | 一括実行コマンド |
| --- | --- | --- |
| Node.js ワークスペース全体 | pnpm (各パッケージの `test` スクリプト) | `pnpm test` |
| Python トレーナー | pytest | `python -m pytest trainer/tests` |
| Playwright E2E | @playwright/test | `cd apps/splitter-gui && pnpm exec playwright test` |

以下では、各ディレクトリごとにテストファイルを列挙し、目的と個別実行方法を示す。

## 1. Python: `trainer/tests` (pytest)
- 共通準備: `pip install -r trainer/requirements_cpu.txt` または CUDA 環境に応じた requirements をインストール。
- 実行方法: ルートで `python -m pytest trainer/tests`。特定ファイルは `python -m pytest trainer/tests/test_sessionize.py::test_sessionize_computes_delta` のように指定。

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `test_features.py` | 特徴量エンコーダと Δt ロバスト統計 (`RobustDeltaStats`, `encode_dataframe`) の整合性と出力形状を検証。 | `python -m pytest trainer/tests/test_features.py` |
| `test_preproc_report.py` | セッション化 (`sessionize`) と前処理レポート生成 (`generate_preproc_report`) の成果物が JSON 出力に期待フィールドを含むかを確認。 | 同上 |
| `test_scoring_anomaly.py` | 異常スコア平滑化ユーティリティ `_moving_average` が窓幅に応じた挙動をするかを確認。 | 同上 |
| `test_scoring_threshold_cli.py` | `trainer.scripts.threshold` CLI が閾値計算 (`compute_threshold`) とメタデータ書き出しを正しく行うかをエンドツーエンドで検証。 | `python -m pytest trainer/tests/test_scoring_threshold_cli.py` |
| `test_sessionize.py` | セッション分割 (`sessionize`) の Δt 計算、タイムアウト処理、例外処理を検証。 | 同上 |
| `test_threshold.py` | 閾値推定 (`TauEstimate`, `HierarchicalTauEstimate`) の分岐ロジックと Otsu/knee 切替を単体検証。 | 同上 |
| `test_trainer.py` | `train_model` が最小データセットで学習成果物（モデル・統計）を生成するかを確認。 | 同上 |

## 2. Node: `collector` (Jest)
- 準備: `pnpm --filter session-anomaly-detection install`。TypeScript ビルドは不要（ts-jest がトランスパイル）。
- 実行方法: `pnpm --filter session-anomaly-detection test`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `tests/scripts/audit.test.ts` | 監査スクリプト (`scripts/audit.ts`) が CSV 出力を生成し適切に終了するかを e2e で確認。 | `pnpm --filter session-anomaly-detection test -- tests/scripts/audit.test.ts` |
| `tests/scripts/simulate.test.ts` | `scripts/simulate.ts` がディレクトリ生成・CSV 永続化を行うか検証。 | 同上 |
| `tests/services/simulationService.test.ts` | シミュレーション生成 (`generateScenario`) の成果物がメタ情報を含むか確認。 | 同上 |
| `tests/sim/anomalyInjector.test.ts` | 異常注入ロジック (`injectAnomaly`) がイベント列へ異常タグを付与するか検証。 | 同上 |
| `tests/sim/labeler.test.ts` | ラベリング処理が正常/異常ラベルを割り当てるか確認。 | 同上 |
| `tests/sim/normalGenerator.test.ts` | 正常系列生成 (`generateNormalSequence`) がシナリオ設定に従うか検証。 | 同上 |
| `tests/sim/protocolValidator.test.ts` | プロトコル検証 (`validateProtocol`) のエラーパスをチェック。 | 同上 |
| `tests/sim/scenarioLoader.test.ts` | シナリオファイル選択（デフォルト vs 外部指定）の優先順位を検証。 | 同上 |
| `tests/sim/simWriter.test.ts` | シミュレーション結果の CSV/manifest 永続化 (`persistSimulationRun`) を確認。 | 同上 |
| `tests/sim/timeDeviationDetector.test.ts` | Δt 異常検出 (`detectTimeDeviation`) の分位点ロジックを検証。 | 同上 |

## 3. Node: `@logserver/dt-preproc` (Vitest)
- 準備: `pnpm --filter @logserver/dt-preproc install`。`pnpm --filter @logserver/dt-preproc run build` で dist 生成（テスト内で `@logserver/csv-schema` の dist を参照するため事前ビルド推奨）。
- 実行方法: `pnpm --filter @logserver/dt-preproc test`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `test/computeFeatureRows.test.ts` | Δt 付き特徴量行生成 (`computeFeatureRows`) の列構造と値を検証。 | `pnpm --filter @logserver/dt-preproc test -- test/computeFeatureRows.test.ts` |
| `test/cli.e2e.test.ts` | CLI (`dt-preproc`) が入力 CSV から加工済み特徴量を出力するフローを e2e で確認。 | 同上 |
| `test/goldenPipeline.test.ts` | ゴールデンデータを用いてストリーム処理が不変であることを確認。 | 同上 |
| `test/hourOfUTC.test.ts` | `hourOfUTC` のタイムゾーン計算を検証。 | 同上 |
| `test/lburst.test.ts` | バースト指標 `lburst` の数式と端ケースを検証。 | 同上 |
| `test/robust.test.ts` | ロバスト統計推定 (`fitRobustStats`) の再現性と特異値への耐性を確認。 | 同上 |
| `tests/determinism.spec.ts` | ストリーミング変換器 (`StreamingFeatureTransformer`) が乱数非依存で決定的に動作するか検証。 | 同上 |
| `tests/epsilon.min.spec.ts` | 閾値最小値選択 (`chooseEpsilonMin`) の挙動をチェック。 | 同上 |
| `src/__tests__/rollingQuantilesR7.test.ts` | ローリング分位点計算 `rollingQuantilesR7` の数値精度を検証。 | `pnpm --filter @logserver/dt-preproc test -- src/__tests__/rollingQuantilesR7.test.ts` |

## 4. Node: `@logserver/dt-anom` (Vitest)
- 準備: `pnpm --filter @logserver/dt-anom run build`（`@logserver/csv-schema` の dist が必要な場合は事前にビルド）。
- 実行方法: `pnpm --filter @logserver/dt-anom test`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `test/fit-and-score.test.ts` | `fitAnomalyModel` のフィット結果と `scoreAnomalies` の JSON 出力を検証。 | `pnpm --filter @logserver/dt-anom test -- test/fit-and-score.test.ts` |
| `tests/cli.e2e.spec.ts` | `dt-anom` CLI が SPOT しきい値 JSON を生成するかを e2e で確認。 | 同上 |
| `tests/gpd.limit.spec.ts` | 一般化パレート分布の極値挙動 (`gpSurvival`, `spotThreshold`) を数値チェック。 | 同上 |
| `tests/hysteresis.spec.ts` | SPOT のヒステリシス制御が過検知を抑制するかを検証。 | 同上 |
| `tests/spot.alarm.spec.ts` | SPOT しきい値のアラーム感度をシナリオ別に検証。 | 同上 |

## 5. Node: `@logserver/csv-schema` (node:test)
- 準備: `pnpm --filter @logserver/csv-schema run build`
- 実行方法: `pnpm --filter @logserver/csv-schema exec node --test test/*.test.ts`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `test/assignSessions.test.ts` | セッション割当 (`assignSessions`) の境界条件を検証。 | `pnpm --filter @logserver/csv-schema exec node --test test/assignSessions.test.ts` |
| `test/computeDeltas.test.ts` | Δt 計算 (`computeDeltas`) の順序性・精度を確認。 | 同上 |
| `test/forEachUser.test.ts` | ユーザ単位イテレータ (`forEachUser`) のコール順序を検証。 | 同上 |
| `test/parseCsv.test.ts` | ストリーミング CSV パーサーのエラー処理と列マッピングを検証。 | 同上 |
| `test/parseEpochSec.test.ts` | タイムスタンプパース (`parseEpochSec`) のフォーマット対応をチェック。 | 同上 |

## 6. Node: `@logserver/session-splitter` (node:test)
- 準備: `pnpm --filter @logserver/session-splitter run build`
- 実行方法: `pnpm --filter @logserver/session-splitter exec node --test test/*.test.ts`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `test/backoff.test.ts` | `estimateThresholdsWithMeta` のバックオフ・リトライ挙動を検証。 | `pnpm --filter @logserver/session-splitter exec node --test test/backoff.test.ts` |
| `test/bimodalityFallback.test.ts` | ヒストグラムが二峰性検出に失敗した場合のフォールバック分岐を検証。 | 同上 |
| `test/kneeThreshold.test.ts` | `kneeThreshold` と `otsuThreshold` の計算精度を比較。 | 同上 |
| `test/logHistogram.test.ts` | 対数ヒストグラム計算 (`makeLogHistogram`) のビン生成を確認。 | 同上 |
| `test/meta.test.ts` | メタファイル生成（ハッシュ・シード情報）が正しいか検証。 | 同上 |
| `test/sessionId.test.ts` | `makeSid` 等の UID 生成が決定的であることを検証。 | 同上 |
| `test/shardCleanup.test.ts` | 一時シャードのクリーンアップがリソースを解放するかを確認。 | 同上 |
| `test/speedBench.test.ts` | ベンチ CLI が Δt 設定に基づいて結果を出力するか検証。 | 同上 |

## 7. Node: `@logserver/session-splitter-cli` (tsx --test)
- 準備: `pnpm --filter @logserver/session-splitter-cli run build`（スクリプト内で依存ビルドが走る）。
- 実行方法: `pnpm --filter @logserver/session-splitter-cli test`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `test/bulk.e2e.test.ts` | `split-sessions` バルク CLI が大量 CSV を分割し JSON メタを保存するかを検証。 | `pnpm --filter @logserver/session-splitter-cli test -- test/bulk.e2e.test.ts` |
| `__tests__/e2e/split_sessions.spec.ts` | CLI がサンプルデータを分割し指定出力にファイル群を生成するかを e2e で確認。 | 同上 |

## 8. Node: `@logserver/dt-anom` CLI 以外の補助テスト
上記 4. に集約済み。

## 9. Electron GUI: `apps/splitter-gui` (Playwright)
- 準備: `cd apps/splitter-gui && pnpm install`。初回のみ `pnpm exec playwright install` でブラウザ依存を導入。ビルド成果物は `pnpm run build` で生成。
- 実行方法: `cd apps/splitter-gui && pnpm exec playwright test`

| ファイル | 内容 | 使用コマンド例 |
| --- | --- | --- |
| `tests/e2e.spec.ts` | Electron GUI の起動とセッションファイルの読み込み UI フローをエンドツーエンドで検証。 | `cd apps/splitter-gui && pnpm exec playwright test tests/e2e.spec.ts` |

## 10. 追加メモ
- すべてのテストを CI で再現する場合、以下の順序が推奨される。
  1. `pnpm install`
  2. `pnpm run build`（必要に応じて）
  3. `pnpm test`
  4. `python -m pytest trainer/tests`
- GPU モードは不要だが、学習系の結合テストを追加する場合は `GPU_MODE=ada6000` などの環境変数で CUDA デバイスを切替られるようにする。
