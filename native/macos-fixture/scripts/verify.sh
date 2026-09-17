#!/bin/sh
set -eu

fixture_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

swift run --package-path "$fixture_root" SurfaceLoomMacOSFixtureModelTests
node --test "$fixture_root"/Tests/*.test.mjs
swift build --package-path "$fixture_root" -c release
