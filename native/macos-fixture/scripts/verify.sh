#!/bin/sh
set -eu

fixture_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

swift run --package-path "$fixture_root" SurfaceLoomMacOSFixtureModelTests
"$fixture_root/scripts/build-app.sh"
node --test "$fixture_root"/Tests/*.test.mjs
