#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm install
pnpm --filter @logserver/session-splitter build
pnpm --filter @logserver/session-splitter-cli build
ls packages/session-splitter-cli/dist/cli.js
node packages/session-splitter-cli/dist/cli.js --help > /dev/null
