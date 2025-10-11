# Datasheet: logserver-session-seed (FAIR 準拠)

## 1. 基本情報 (Findable)
- **識別子**: `logserver-session-seed`
- **バージョン**: 2024-06-01
- **管理場所**: `artifacts/<YYYYMMDD>/` (raw) と `data/processed/` (派生)
- **メタデータ**: `dataset/metadata.json` にスキーマ・手順・シードを明記
- **検索キーワード**: LSTM, Δt, session anomaly, Simulink, control engineering

## 2. アクセス (Accessible)
- **ライセンス**: 研究用途限定（学内配布）。外部公開時は追加許可を取得。
- **認証**: `.env` で指定する HMAC 鍵と Docker 内 JWT により内部利用者のみアクセス可能。
- **ホスティング**: Git 管理対象はメタデータのみ。実データは `artifacts/`, `data/processed/`, `runs/` に出力され Git 追跡外。

## 3. 相互運用性 (Interoperable)
- **フォーマット**: CSV (RFC4180), Parquet (Arrow 3.0)
- **スキーマ**:
  | 列名 | 型 | 説明 |
  | ---- | --- | ---- |
  | `timestamp_utc` | string | RFC 3339, UTC (Chrony 安定化後取得)
  | `uid` | string | `base64url(HMAC_SHA256(JWT_HMAC_KEY, raw_jwt))`
  | `session_id` | string | セッション化後の一意キー (`user`+`timestamp`)
  | `method` | string | HTTP 動詞 (`GET/POST/PUT/DELETE`)
  | `path` | string | リクエストパス
  | `referer` | string | HTTP Referer
  | `user_agent` | string | ユーザエージェント
  | `ip` | string | RFC5737 のドキュメントレンジ (例: 198.51.100.0/24)
  | `op_category` | string | `AUTH/READ/UPDATE`
  | `event` | string | `login/browse/edit/logout/...`
  | `status` | int | HTTP ステータス
  | `latency_ms` | int | 応答遅延 (ms)
  | `delta_t` | float | 隣接イベント間隔 (秒)
  | `anomaly_score` | float | LSTM 由来の異常スコア
  | `anomaly_label` | int | 閾値判定 (0:正常, 1:異常)

## 4. 再利用性 (Reusable)
- **収集目的**: Web セッション操作系列の Δt を含む LSTM 制御モデル評価 (SRS.md §1, §6-§8)。
- **生成対象**: 正常系列・擬似異常を含む Node.js ベース疑似ログ。
- **CSV 生成バージョン情報**:
  - Node.js 20.12.2 (`node:20-alpine` イメージ)
  - npm 10.x (`npm --prefix collector run seed`)
  - Python 3.11.8 (`python -m trainer.scripts.*`)
  - `trainer/configs/default.yaml` SHA-256: `8377ebbe432aed767c5bed66f84fb02f119a5e9e841112f03d48f61a07db44a5`
  - PyTorch 2.x (CUDA モードは `.env` の `GPU_MODE` で切替)

## 5. データ収集と前処理
- **擬似匿名化**: `uid = base64url(HMAC_SHA256(key=JWT_HMAC_KEY, message=raw_jwt))`。`JWT_HMAC_KEY` は 256bit を推奨。
- **時刻同期 (NTP 基準)**: `chronyc tracking` で `Last offset` と `RMS offset` が ±0.050s 以内。証跡は `logs/ntp-*.txt` に保存。
- **セッション化**: `python -m trainer.scripts.preprocess --config trainer/configs/default.yaml` が `delta_t` を算出。
- **乱数種**:
  - シード送信器: `0x5eedc0de`
  - Python/Numpy/Torch: `42`
- **既知バイアス**:
  1. 操作シーケンスは決定論的テンプレートに軽微な揺らぎのみ → 実運用の自由度を過小評価。
  2. 遅延は一様分布 (45–480ms) → 長尾遅延やネットワークジッタが欠落。
  3. 攻撃パターンは未収録 → セキュリティ異常の多様性が不足。

## 6. 再現手順 (Full Command)
```bash
docker compose up -d collector
npm --prefix collector run seed
python -m trainer.scripts.preprocess --config trainer/configs/default.yaml
python -m trainer.scripts.train --config trainer/configs/default.yaml
python -m trainer.scripts.score --config trainer/configs/default.yaml
python -m trainer.scripts.threshold --config trainer/configs/default.yaml
python -m trainer.scripts.explain --config trainer/configs/default.yaml
```
- 実行順序は厳守。閾値・説明生成は `scores.csv` を前提とする。
- 実行ログ・バージョン情報は `artifacts/manifest.json`, `runs/<timestamp>/` に保管。

## 7. 品質保証
- `npm --prefix collector run audit -- --dir artifacts` で CSV を検証 (`findings: 0` を要求)。
- `python -m trainer.scripts.threshold` 実行後、`data/processed/threshold.json` の `threshold` を記録。
- Δt 統計: `data/processed/dt_stats.json`、ケースレポート: `data/processed/reports/*.md`。

## 8. 連絡先
- 責任者: 実装責任エンジニア (本 repo の Maintainer)
- 連絡: 研究室 GitHub Issues または内部 Slack `#lstm-simulink` チャンネル
