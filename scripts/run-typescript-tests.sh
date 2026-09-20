#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v npm >/dev/null 2>&1 || { echo "FATAL: npm not found" >&2; exit 2; }

node "$ROOT/scripts/audit-publication.mjs"

# browser-playwright/v3 consumes the public @surfaceloom/test declarations, so
# build test before installing and compiling that optional adapter.
for package in core component-catalog reporter agent-loop test browser-playwright native service llm-judge; do
	PACKAGE_DIR="$ROOT/packages/$package"
	if [ ! -d "$PACKAGE_DIR/node_modules" ]; then
		npm --prefix "$PACKAGE_DIR" ci
	fi
	npm --prefix "$PACKAGE_DIR" test
done

node "$ROOT/scripts/run-repository-contract-tests.mjs"
