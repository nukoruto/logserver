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
  | `timestamp_utc` | double | UTC epoch 秒（Chrony 安定化後取得）。必要に応じて派生物として RFC 3339 文字列を別途保存する。 |
  | `uid` | string | `hex(HMAC_SHA256(K_ds, raw_jwt_utf8))` による擬似匿名化済みユーザ ID。 |
  | `session_id` | string | セッション化後の一意キー (`user`+`timestamp`)。 |
  | `method` | string | HTTP 動詞 (`GET/POST/PUT/DELETE`)。 |
  | `path` | string | リクエストパス。`normalize_request_path` ヘルパーで正規化した値を格納する。 |
  | `referer` | string | HTTP Referer。 |
  | `user_agent` | string | ユーザエージェント。 |
  | `ip` | string | RFC5737 のドキュメントレンジ (例: 198.51.100.0/24)。 |
  | `cookie` | string | `uid` から決定的に導出した擬似匿名化セッションクッキー。 |
  | `op_category` | string | `AUTH/READ/UPDATE`。 |
- **派生列**: 10 列契約 CSV から生成（`dt-preproc`→`trainer.scripts.score`→`trainer.scripts.threshold` の決定的パイプライン）。
- **契約遵守**: CSV 本体は常に 10 列固定。派生特徴や監査メタは `run_meta.json` / `audit.jsonl` / `schema.json` のサイドカーで提供し、`manifest.schema_sha256` に `schema.json` のハッシュを格納する。

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
- **擬似匿名化**: `K_ds = HKDF_SHA256(JWT_HMAC_KEY, info="sid")`、`uid = hex(HMAC_SHA256(key=K_ds, message=raw_jwt_utf8))`。`JWT_HMAC_KEY` は 256bit を推奨し、`kid=sid-fixture-202406` を `metadata.json` に記録。
- **時刻同期 (NTP 基準)**: `chronyc tracking` で `Last offset` と `RMS offset` が ±0.050s 以内。証跡は `logs/ntp-*.txt` に保存。
- **セッション化**: `python -m trainer.scripts.preprocess --config trainer/configs/default.yaml` が `delta_t` を算出。
- **乱数種**:
  - シード送信器: `0x5eedc0de`
  - Python/Numpy/Torch: `42`
- **既知バイアス**:
  1. 操作シーケンスは決定論的テンプレートに軽微な揺らぎのみ → 実運用の自由度を過小評価。
  2. 遅延は一様分布 (45–480ms) → 長尾遅延やネットワークジッタが欠落。
  3. 攻撃パターンは未収録 → セキュリティ異常の多様性が不足。

### 5.1 シミュレーション出力例

```
artifacts/sim_demo/
├─ simEvents-sim_demo.csv
├─ scenario-sim_demo.json
├─ run_meta.json
├─ audit.jsonl
└─ schema.json
```

最小構成の `manifest` / `run_meta` は以下のように対応付けられ、`schema_sha256` によりサイドカーの完全性を追跡する。

```json
{
  "scenario_id": "default-flow",
  "schema_sha256": "3a1f...",
  "output": {
    "csv_path": "artifacts/sim_demo/simEvents-sim_demo.csv",
    "run_meta_path": "artifacts/sim_demo/run_meta.json",
    "audit_path": "artifacts/sim_demo/audit.jsonl",
    "schema_path": "artifacts/sim_demo/schema.json"
  }
}
```

```json
{
  "run_id": "sim_demo",
  "created_at_utc": "2024-01-01T00:00:00Z",
  "algo_ver": "sim-delta-v1",
  "simulator_version": "1.0.0",
  "data_fingerprint": {
    "csv_sha256": "c5e7...",
    "features_csv_sha256": null,
    "schema_sha256": "3a1f...",
    "event_count": 64,
    "session_count": 8
  },
  "injection_summary": {
    "anomaly_summary": {
      "normal": 56,
      "time_deviation": 6,
      "protocol_violation": 2
    }
  }
}
```

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
