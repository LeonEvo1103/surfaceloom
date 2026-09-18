#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/run-typescript-tests.sh"
npm --prefix "$ROOT/examples/reference-agent" ci --ignore-scripts
npm --prefix "$ROOT/examples/reference-agent" test
npm --prefix "$ROOT/examples/reference-agent" run test:e2e
