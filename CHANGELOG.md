# Changelog

## [Unreleased]
### Added
- Deterministic Δt 前処理および SPOT 関連の単体テスト（NaN/Infinity も拒否）。
- README と SRS に ε=0.5×min Δt のクリップ仕様、SPOT 閾値式、比ヒステリシス条件を明文化。

### Removed
- 旧来の `--epsilon-auto` / `--spot-no-hysteresis` などのオプション記述を廃止し、仕様上の固定式へ一本化。
