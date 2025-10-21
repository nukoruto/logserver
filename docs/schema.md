# ログスキーマ定義 (UTC epoch 秒契約)

本ドキュメントは、1 行 = 1 リクエストとする CSV ログの標準スキーマを定義する。列順序は固定であり、後続のバリデーションや契約チェックは本仕様を参照する。

| 列名 | 型 / 形式 | 必須 | 説明 |
| --- | --- | --- | --- |
| `timestamp_utc` | 倍精度浮動小数 (UTC epoch 秒) | 必須 | リクエスト発生時刻。Chrony で同期した UTC epoch 秒 double を格納し、必要に応じて派生ファイルで RFC 3339 文字列を併記する。 |
| `uid` | 文字列 | 必須 | 擬似匿名化済みユーザ ID。`K_ds = HKDF_SHA256(JWT_HMAC_KEY, info="sid")` から派生した鍵で HMAC-SHA256 を適用し、`hex(...)` で表現する。 |
| `session_id` | 文字列 | 必須 | セッション識別子。クライアント単位の連続操作を束ねる。 |
| `method` | 文字列 | 必須 | HTTP メソッド (`GET`, `POST` など)。 |
| `path` | 文字列 | 必須 | リクエスト対象のパス。`normalize_request_path` ヘルパーで正規化済みの値（クエリを含む場合は整形済み）を格納する。 |
| `referer` | 文字列 | 任意 | 参照元 URL。存在しない場合は空文字または `-`。 |
| `user_agent` | 文字列 | 任意 | クライアントの User-Agent 文字列。 |
| `ip` | 文字列 | 必須 | クライアント IP アドレス。IPv4/IPv6 をサポートし、匿名化処理後の値を格納する。 |
| `cookie` | 文字列 | 必須 | 擬似匿名化セッションクッキー。収集時の生 Cookie 値（または実験用擬似 Cookie）を入力に `hex(HMAC_SHA256(K_cookie, raw_cookie || salt))` で導出した値を保存する。`uid` を再利用した決定的生成は禁止。 |
| `op_category` | 文字列 (AUTH / READ / UPDATE) | 必須 | 操作カテゴリ。認証 (`AUTH`)、読み取り (`READ`)、更新 (`UPDATE`) のいずれか。 |

## 運用上の留意事項

- CSV は RFC 4180 に準拠し、カラムヘッダを含める。
- `timestamp_utc` は UTC 固定とし、秒単位の epoch double（例: `1705317912.083`）を記録する。可読形式が必要な場合は派生列またはメタファイルとして RFC 3339 文字列を別途生成する。
- `uid` は将来の擬似匿名 ID 仕様（別タスクで定義）に従う。現時点では `HKDF_SHA256` による `K_ds` 派生と HMAC-SHA256 での擬似化を前提とし、`kid` をメタデータに記録する。
- `op_category` は業務要件に基づく 3 区分。新種別を追加する場合は SRS.md と本ドキュメントの改訂を行う。
- `cookie` は生クッキー（または実験用擬似クッキー）から擬似化し、`uid` を入力とした決定的生成は禁止。生クッキー/JWT は導出後に破棄する。
- `meta.jsonl` を生成した場合は manifest.output.dir からの相対パスと `sha256:<hex>` を `manifest.output.meta` に保存し、整合性検証は `sha256sum -c` で行う。

## パス正規化ポリシー

`normalize_request_path` ヘルパー（TypeScript 実装: `normalisePathTemplate` in `packages/dt-preproc/src/template.ts`, Python 実装: `_normalise_path_template` in `trainer/src/logserver/dataio/sessionize.py`）は以下のルールで `path` を正規化する。

1. **ケース保持**: ASCII 文字の大文字/小文字は入力のまま保持する。小文字化が許容されるサーバで実験する場合は SRS にその挙動を明記し、`preserve_case=False` 設定を両実装でテストする。
2. **スキーム・ホスト除去**: `https://example.com/app` のような入力からスキームとホスト部分を除き、先頭スラッシュ付きパスのみを保持する。
3. **スラッシュ圧縮**: 連続する `/` を 1 つに畳み、末尾スラッシュはルート以外で削除する（例: `/app//index/` → `/app/index`）。
4. **パーセントエンコード整形**: RFC 3986 の unreserved 文字（`ALPHA / DIGIT / "-" / "." / "_" / "~"`）に対応する `%` エンコードのみデコードし、予約文字（例: `%2F`）はエンコード済みのまま保持する。再エンコード時は大文字 `%` を使用する。
5. **クエリソート**: `?` 以降のクエリはキーを UTF-8 コード順に安定ソートし、同一キー内の値も安定ソートする。値は `+` を空白に戻さず `%20` でエンコードする。
6. **空クエリ・フラグメント処理**: 正規化後にクエリパラメータが空になった場合は `?` を除去し、`#fragment` は常に破棄する。

この正規化規則は README.md および SRS.md と同一内容で定義し、Node.js 側 (`@logserver/dt-preproc`) と Python 側 (`trainer` パッケージ) の両方で 100 ケース以上のプロパティテストを実施してバイト一致を CI で保証する。
- 追加メタデータが必要な場合は別列を末尾に追加せず、JSON カラム等での拡張を検討する（互換性維持のため）。

本スキーマに準拠した CSV は `contract/` ディレクトリのバリデーションルールおよびデータパイプラインでの検証対象となる。
