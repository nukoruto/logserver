# 運用 Runbook: Δt-aware ログサーバ再現手順

## 0. 目的と前提
- 目的: `.env` 整備から CSV 確認までを 30 分以内で再現し、SRS/README のエンドツーエンド実験を初期化する。
- 対象: 新規参画エンジニア。ホストは Ubuntu 22.04 / Windows11+WSL2、Docker Desktop 4.30 以上、Node.js 20.12.2、Python 3.11。
- 依存: `docker`, `docker compose`, `npm`, `python3`, `chronyc` (または `ntpstat`)、`jq`, `tree`。GPU は `GPU_MODE=ada6000|4060|cpu` で選択。

> 重要: すべてのコマンドはリポジトリルート `/workspace/logserver` から実行すること。

---

## 1. `.env` の作成
1. 雛形をコピーし、Git 管理外の `.env` を作成する。
   ```bash
   cp .env.example .env
   cp collector/.env.example collector/.env
   ```
2. ルート `.env` に以下を追記・確認する。
   ```ini
   JWT_HMAC_KEY=c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=
   SID_KEY_ID=sid-fixture-202406
   GPU_MODE=ada6000  # RTX6000 Ada。4060 を使う場合は 4060 に変更。
   SEED_SESSION_COUNT=220
   ```
   - `SID_KEY_ID` は `JWT_HMAC_KEY` から派生する `K_ds = HKDF_SHA256(JWT_HMAC_KEY, info="sid")` に対応する鍵識別子。CSV/メタ書き出し時に参照される。
3. Windows の場合は LF 改行を維持 (`git config core.autocrlf false`)。

![.env 作成画面](images/runbook_env.svg)

---

## 2. Docker サービスの起動
1. ベースイメージをビルドして collector サービスを起動。
   ```bash
   docker compose build collector
   docker compose up -d collector
   ```
2. GPU モードを確認。
   ```bash
   docker compose exec collector printenv CUDA_VISIBLE_DEVICES
   ```
   - `GPU_MODE=ada6000` → `0`、`GPU_MODE=4060` → `1` が期待値。`none` の場合は未設定で CPU 実行。
3. ログを確認して HTTP 8000 が LISTEN 状態であることを確認。
   ```bash
   docker compose logs -n 20 collector
   ```

![Docker 起動画面](images/runbook_docker.svg)

---

## 3. NTP 同期の確認
1. ホストで NTP 偏差を測定。
   ```bash
   chronyc tracking
   ```
   または:
   ```bash
   ntpstat
   ```
2. `Last offset`/`Root delay` が ±0.050 秒以内で安定していることを確認。ずれが大きい場合は後述トラブルシュート参照。
3. 記録用に `logs/ntp-$(date -u +%Y%m%dT%H%M%SZ).txt` へ保存。
   ```bash
   chronyc tracking | tee logs/ntp-$(date -u +%Y%m%dT%H%M%SZ).txt
   ```

![NTP 確認画面](images/runbook_ntp.svg)

---

## 4. シードデータ投入
1. collector コンテナが起動済みであることを確認し、Node.js 側で疑似ログを送信。
   ```bash
   npm --prefix collector run seed
   ```
2. 成功時メトリクス
   - `[seed] Sessions executed: 220`
   - `[seed] Total events inserted: >= 1540`
   - 乱数生成器は固定 `0x5eedc0de`、JWT_HMAC_KEY が雛形値と一致しない場合は警告。
3. 実行ログは `artifacts/seed/` に保存（自動生成）。

![シード投入画面](images/runbook_seed.svg)

---

## 5. 品質監査 (Quality Audit)
1. 収集済み CSV（`artifacts/` 配下）を Node 監査スクリプトで検証。
   ```bash
   npm --prefix collector run audit -- --dir artifacts
   ```
2. 期待出力: `{"files": <N>, "rows": >=1540, "findings": 0}`。`findings` が 0 以外の場合は CSV を修正して再実行。
3. 監査レポートは `artifacts/audit/latest.json` に保存（存在しない場合は `tee` で保存）。

![品質監査画面](images/runbook_audit.svg)

---

## 6. メトリクス閲覧
1. Python 環境を有効化し、前処理→学習→スコアリング→閾値→説明を順次実行。
   ```bash
   python -m trainer.scripts.preprocess --config trainer/configs/default.yaml
   python -m trainer.scripts.train --config trainer/configs/default.yaml
   python -m trainer.scripts.score --config trainer/configs/default.yaml
   python -m trainer.scripts.threshold --config trainer/configs/default.yaml --on-error keep-partial
   python -m trainer.scripts.explain --config trainer/configs/default.yaml
   ```
2. 学習履歴と閾値を確認。
   ```bash
   jq '.' runs/latest/history.json
   jq '.' data/processed/threshold.json
   ```
   - `threshold.json` には入力 CSV の SHA-256 とフォールバック理由（NaN/空集合など）が記録され、閾値決定に失敗した場合は WARN ログとともに `status=skipped` が保存されます。
   - `--on-error=keep-partial` を指定すると例外発生時に `.partial` ファイルを残し、`abort`（既定）は部分成果物を削除します。
3. Δt 統計は `data/processed/dt_stats.json`、ケースレポートは `data/processed/reports/` に出力。

![メトリクス閲覧画面](images/runbook_metrics.svg)

---

## 7. CSV / 生成物の所在
- 収集段階:
  - 生ログ: `artifacts/<YYYYMMDD>/raw/*.csv`
  - manifest/checksums: `artifacts/<YYYYMMDD>/manifest.json`, `checksums.txt`
- 前処理後:
  - `data/processed/events.csv`, `events.parquet`
  - `data/processed/scores.csv`, `scores_with_labels.csv`
  - `data/processed/threshold.json`, `data/processed/dt_stats.json`
- 学習成果:
  - `runs/<timestamp>/model.pt`, `features.json`, `history.json`, `model_config.json`
  - シンボリックリンク `runs/latest`

```bash
tree -L 1 data/processed
```
![CSV 所在](images/runbook_csv.svg)

---

## 8. Δt CLI 再現（session-split → dt-preproc → dt-anom）
1. Node.js パッケージをビルドする（初回のみ）。
   ```bash
   pnpm install
   pnpm --filter @logserver/session-splitter build
   pnpm --filter @logserver/session-splitter-cli build
   pnpm --filter @logserver/csv-schema build
   pnpm --filter @logserver/dt-preproc build
   pnpm --filter @logserver/dt-anom build
   ```
2. セッション分割 CLI で Δt を含む CSV とメタデータを生成する。
   ```bash
   mkdir -p out stats data
   JWT_HMAC_KEY=c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY= \
     node packages/session-splitter-cli/dist/bulk.js \
     --in logs/sample.csv \
     --out out/split.csv \
     --meta out/split.meta.json \
     --epsilon 0.01 \
     --k 3 \
     --scan-step 0.05 \
     --min-events 3 \
     --algo otsu+kneedle-v1 \
     --idle-timeout 1800
   ```
   - `out/split.csv` と `out/split.meta.json` が生成され、`split.meta.json` には `DeltaT`・`tau_final`・`dataset_hash` が保存される。
3. `dt-preproc` で統計を推定し、同一入力に対して 2 回特徴量を生成して決定性と NaN 非存在を確認する。
   ```bash
   node packages/dt-preproc/dist/cli.js fit \
     --input out/split.csv \
     --out stats/preproc_stats.json \
     --meta stats/preproc_meta.json \
     --pretty

   node packages/dt-preproc/dist/cli.js transform \
     --input out/split.csv \
     --stats stats/preproc_stats.json \
     --out data/feat1.csv

   node packages/dt-preproc/dist/cli.js transform \
     --input out/split.csv \
     --stats stats/preproc_stats.json \
     --out data/feat2.csv

   sha256sum data/feat1.csv data/feat2.csv
   rg "NaN" data/feat1.csv
   ```
   - `sha256sum` が一致することを確認し、`rg` で `NaN` が出現しないことを検証する。
4. `dt-anom` 用の入力 CSV を Δt 特徴量から生成する。初期イベント（Δt 欠損）は除外する。
   ```bash
   python - <<'PY'
import csv, math
from pathlib import Path
src = Path('data/feat1.csv')
dst = Path('data/dt_anom_input.csv')
with src.open() as f:
    reader = csv.DictReader(f)
    fieldnames = [
        'timestamp_utc','uid','session_id','method','path',
        'referer','user_agent','ip','cookie','op_category',
        'dt_sec','log_dt','z','z_clipped','z_deseas'
    ]
    rows = []
    for row in reader:
        dt_raw = row.get('delta_clipped_seconds') or row.get('delta_seconds') or ''
        if not dt_raw:
            continue
        dt = float(dt_raw)
        rows.append({
            'timestamp_utc': row['timestamp_utc'],
            'uid': row['uid'],
            'session_id': row['session_id'],
            'method': row['method'],
            'path': row['path'],
            'referer': row['referer'],
            'user_agent': row['user_agent'],
            'ip': row['ip'],
            'cookie': row['cookie'],
            'op_category': row['op_category'],
            'dt_sec': f"{dt:.6f}",
            'log_dt': f"{math.log(max(dt, 1e-9)):.6f}",
            'z': ('' if not row.get('delta_robust_z') else f"{float(row['delta_robust_z']):.6f}"),
            'z_clipped': ('' if not row.get('delta_z_deseas_clipped') else f"{float(row['delta_z_deseas_clipped']):.6f}"),
            'z_deseas': ('' if not row.get('delta_z_deseas_clipped') else f"{float(row['delta_z_deseas_clipped']):.6f}")
        })
with dst.open('w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
PY
   ```
5. `dt-anom` で統計を学習し、同一入力を 2 回スコアリングして決定性と必須列を検証する。
   ```bash
   PREPROC_HASH=$(sha256sum stats/preproc_stats.json | awk '{print $1}')
   node packages/dt-anom/dist/cli.js fit \
     --input data/dt_anom_input.csv \
     --stats-out stats/anom_stats.json \
     --meta-out stats/anom_meta.json \
     --column dt_sec \
     --quantile-lower 0.1 \
     --quantile-upper 0.9 \
     --min-quantile-samples 1 \
     --budget-total 0.5 \
     --spot-domain log_dt \
     --spot-calib-count 2 \
     --spot-p0 0.8,0.9,0.95 \
     --min-tail 1 \
     --flag-tail-prob 0.1 \
     --alpha 0.5 \
     --q 0.95 \
     --calib-window 10 \
     --decluster-r 1 \
     --kofn 1/1 \
     --H 1.2 \
     --reestimate-every 5 \
     --min-exceed 1 \
     --pool-strategy per-user \
     --xi-eps 0.001 \
     --upper-cap-per-day 5 \
     --lower-clip -5 \
     --seed 123 \
     --preproc-hash "$PREPROC_HASH" > logs/dt-anom-fit.json

   node packages/dt-anom/dist/cli.js score \
     --input data/dt_anom_input.csv \
     --output out/scored_1.csv \
     --stats stats/anom_stats.json \
     --meta stats/anom_meta.json \
     --audit out/spot_audit.jsonl > logs/dt-anom-score1.json

   node packages/dt-anom/dist/cli.js score \
     --input data/dt_anom_input.csv \
     --output out/scored_2.csv \
     --stats stats/anom_stats.json \
     --meta stats/anom_meta.json \
     --audit out/spot_audit_run2.jsonl > logs/dt-anom-score2.json

   sha256sum out/scored_1.csv out/scored_2.csv
   rg "NaN" out/scored_1.csv
   head -n 1 out/scored_1.csv
   ```
   - `sha256sum` が一致し、`spot_tau_t`・`tau_hi`・`spot_alarm_kofn`・`alarm` 列がヘッダに含まれていることを確認する。
   - `out/spot_audit.jsonl` を確認し、`flagged` としきい値メタ情報（`spot_tau`、`p_upper_spot` など）が記録されているか検証する。

### 8.5 最短パイプライン回帰テスト（dt-preproc → dt-anom → dt-lstm）

1. Python 依存（`torch`, `numpy`, `pyyaml`, `pandas`, `matplotlib`）が導入済みであることを確認し、GPU を利用しない場合は `GPU_MODE=cpu` を設定する。
2. リポジトリルートで次を実行し、Vitest が `packages/dt-preproc/tests/e2e.pipeline.spec.ts` を単体実行する。
   ```bash
   pnpm test --filter dt-preproc -- tests/e2e.pipeline.spec.ts
   ```
3. テストは `packages/dt-preproc/test/fixtures/pipeline_small.csv` を入力として、
   `dt-preproc transform` → `dt-anom fit/score` → `dt-lstm fit/train/infer` の順に CLI を起動する。
   - 生成された中間 CSV に `dt_sec` 列が付与され、`delta_seconds` と同値であることをアサートする。
   - `dt-anom fit` の `base_column`、`dt-lstm train` の完了ログ、`dt-lstm infer` の出力 CSV までを確認する。
4. Vitest の完了メッセージが `1 passed` であることをもって、Δt 列名のエイリアスと LSTM パイプラインの最短経路が再現できたと判断する。

---

## 9. トラブルシュート
### 9.1 権限エラー (EACCES / Permission denied)
- 症状: `artifacts/` や `data/processed/` への書き込み失敗。
- 対処:
  ```bash
  sudo chown -R "$USER" artifacts data logs
  chmod -R u+rwX artifacts data logs
  docker compose restart collector
  ```
- Docker ボリュームが root 所有の場合は `docker run --rm -v $(pwd)/artifacts:/mnt busybox chown -R 1000:1000 /mnt`。

### 9.2 ディスク不足
- 症状: `No space left on device`。
- 対処:
  ```bash
  docker system df
  docker system prune -f
  rm -rf artifacts/* data/processed/* runs/*
  ```
- 収集物削除前に `tar czf backup-$(date -u +%Y%m%d).tgz artifacts data/processed runs` で退避。

### 9.3 NTP 不安定
- 症状: `chronyc tracking` で `Last offset` > 0.050s が継続。
- 対処:
  ```bash
  sudo systemctl restart chronyd  # or chrony
  sudo chronyc makestep
  chronyc sources -v
  ```
- コンテナ内はホスト時間に追従するため、ホストの NTP 安定化が必須。安定後にシードをやり直すことで Δt の再現性を担保。

### 9.4 `dt-anom` CLI で `recalibrate` が失敗する
- 症状: `pnpm exec dt-anom recalibrate` など `recalibrate` サブコマンドを実行すると、毎回
  `Hierarchical SPOT recalibration is not supported. Please rerun dt-anom fit.` が出力され処理が停止する。
- 原因: `packages/dt-anom/src/cli.ts` にて `recalibrate` コマンドは意図的に未実装であり、例外を送出して
  `fit` の再実行を促す仕様。SPOT の再推定は学習済み統計を破壊するため、現在の運用フローでは
  `fit` の再計算のみを許可している。
- 対処:
  1. `pnpm --filter @logserver/dt-anom run build` を最新にしてから、`pnpm exec dt-anom fit ...` を再実行し統計と
     メタデータを再生成する。
  2. 新しい統計 (`anom_stats.json`) とメタ (`anom_meta.json`) を `score` や Python パイプラインに再投入する。
  3. 差分検証が必要な場合は、旧成果物を `reports/` 等に退避してから再試行する。
- 備考: 将来的に再推定をサポートする場合は `docs/` 配下の runbook と CLI ヘルプを同時更新すること。

---

## 10. 完了条件チェックリスト
- [ ] `.env` に JWT_HMAC_KEY / SID_KEY_ID / GPU_MODE / SEED_* を設定
- [ ] `docker compose ps` で collector が `Up` かつ 8000 LISTEN
- [ ] `chronyc tracking` で ±50ms 内に収束
- [ ] `npm --prefix collector run seed` が成功し 1,540 件以上のイベントが生成
- [ ] `npm --prefix collector run audit` で `findings: 0`
- [ ] `data/processed/scores_with_labels.csv` を生成
- [ ] `runs/latest/` に学習成果を保存

上記が揃えば、Simulink エクスポートや追加実験（閾値比較、説明可能性、PID 対比）に移行可能。
