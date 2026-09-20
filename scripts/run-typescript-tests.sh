#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v npm >/dev/null 2>&1 || { echo "FATAL: npm not found" >&2; exit 2; }

node "$ROOT/scripts/audit-publication.mjs"

# @surfaceloom/test consumes llm-judge and browser-playwright/v3 consumes test,
# so build those packages in dependency order before their downstream adapters.
for package in core component-catalog reporter agent-loop llm-judge test browser-playwright native service; do
	PACKAGE_DIR="$ROOT/packages/$package"
	if [ ! -d "$PACKAGE_DIR/node_modules" ]; then
		npm --prefix "$PACKAGE_DIR" ci
	fi
	npm --prefix "$PACKAGE_DIR" test
done

node "$ROOT/scripts/run-repository-contract-tests.mjs"
