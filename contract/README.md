# Contract Directory

このディレクトリには、セッションログのデータ契約を構成する定義ファイルを配置します。

- `schema/` : RFC 3339 (UTC) タイムスタンプ等を含む CSV スキーマ定義
- `schema/dt_lstm_metrics.schema.json` : `dt-lstm eval` が出力する `metrics.json` の JSON Schema（AUROC/F1/遅延/ECE 等）
- `op_category/` : 操作カテゴリ辞書およびマッピング仕様
- `session_split/` : セッション分割（Otsu, ε, 肘法）の閾値設計に関する設定

将来の更新では、各ファイルに対して Git 管理下でバージョンとハッシュを保持してください。
