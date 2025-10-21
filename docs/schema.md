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
| `cookie` | 文字列 | 必須 | 擬似匿名化セッションクッキー。`uid` を入力に `hex(HMAC_SHA256(K_cookie, uid || session_id))` で導出した値を保存する。 |
| `op_category` | 文字列 (AUTH / READ / UPDATE) | 必須 | 操作カテゴリ。認証 (`AUTH`)、読み取り (`READ`)、更新 (`UPDATE`) のいずれか。 |

## 運用上の留意事項

- CSV は RFC 4180 に準拠し、カラムヘッダを含める。
- `timestamp_utc` は UTC 固定とし、秒単位の epoch double（例: `1705317912.083`）を記録する。可読形式が必要な場合は派生列またはメタファイルとして RFC 3339 文字列を別途生成する。
- `uid` は将来の擬似匿名 ID 仕様（別タスクで定義）に従う。現時点では `HKDF_SHA256` による `K_ds` 派生と HMAC-SHA256 での擬似化を前提とし、`kid` をメタデータに記録する。
- `op_category` は業務要件に基づく 3 区分。新種別を追加する場合は SRS.md と本ドキュメントの改訂を行う。
- `cookie` は `uid` から決定的に導出された疑似値を保持し、生クッキー/JWT は保存しない。

## パス正規化ポリシー

`normalize_request_path` ヘルパー（TypeScript 実装: `normalisePathTemplate` in `packages/dt-preproc/src/template.ts`, Python 実装: `_normalise_path_template` in `trainer/src/logserver/dataio/sessionize.py`）は以下のルールで `path` を正規化する。

1. **ケース正規化**: ASCII 文字を小文字化する。大文字が意味を持つパスは `normalize_request_path(..., preserve_case=True)` で例外指定可能だが、デフォルトは小文字化。
2. **スキーム・ホスト除去**: `https://example.com/app` のような入力からスキームとホスト部分を除き、先頭スラッシュ付きパスのみを保持する。
3. **スラッシュ圧縮**: 連続する `/` を 1 つに畳み、末尾スラッシュはルート以外で削除する（例: `/app//index/` → `/app/index`）。
4. **パーセントエンコード整形**: `decodeURIComponent` 相当で安全文字 (`A-Z`, `a-z`, `0-9`, `-._~`) をデコードしたうえで、再エンコード時は RFC 3986 に従い大文字の `%` エスケープを使用する。
5. **クエリソート**: `?` 以降のクエリはキーを UTF-8 コード順にソートし、同一キーは値順で安定ソートする。値は `+` を空白に戻さず `%20` でエンコードする。
6. **空クエリ除去**: 正規化後にクエリパラメータが空になった場合は `?` を除去する。

この正規化規則は README.md および SRS.md と同一内容で定義し、Node.js 側 (`@logserver/dt-preproc`) と Python 側 (`trainer` パッケージ) の両方で同一結果になるよう単体テストを整備する。
- 追加メタデータが必要な場合は別列を末尾に追加せず、JSON カラム等での拡張を検討する（互換性維持のため）。

本スキーマに準拠した CSV は `contract/` ディレクトリのバリデーションルールおよびデータパイプラインでの検証対象となる。
