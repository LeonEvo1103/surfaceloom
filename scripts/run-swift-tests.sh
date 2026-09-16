#!/usr/bin/env bash
set -euo pipefail

MODE="check"
SKIP_ARCHITECTURE="0"
while [ "$#" -gt 0 ]; do
	case "$1" in
		--live) MODE="live" ;;
		--skip-architecture) SKIP_ARCHITECTURE="1" ;;
		*) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_PATH="${DESKTOP_TEST_SWIFT_PACKAGE_PATH:-$ROOT}"

[ "$(uname)" = "Darwin" ] || { echo "FATAL: the Swift backend requires macOS" >&2; exit 2; }
command -v swift >/dev/null 2>&1 || { echo "FATAL: Swift toolchain not found" >&2; exit 2; }

if [ "$SKIP_ARCHITECTURE" != "1" ]; then
	"$ROOT/scripts/check-architecture.sh"
fi

if [ "$MODE" = "live" ]; then
	# Accessibility grants are tied to runner identity/path, so live builds use a stable path.
	SCRATCH="${DESKTOP_TEST_SCRATCH_PATH:-$ROOT/.build/macos-live}"
	mkdir -p "$SCRATCH"
else
	SCRATCH="$(mktemp -d -t surfaceloom-swift)"
	cleanup() { rm -rf "$SCRATCH"; }
	trap cleanup EXIT
fi

SWIFT_ARGS=(
	test
	--package-path "$PACKAGE_PATH"
	--scratch-path "$SCRATCH"
)
SWIFT_DISCOVERY_ARGS=(
	test
	--package-path "$PACKAGE_PATH"
	--scratch-path "$SCRATCH"
)

# SwiftPM versions that expose this flag default to serial execution. Newer
# toolchains removed the spelling, so only pass it when the current CLI accepts it.
SWIFT_TEST_HELP="$(swift test --help 2>&1)"
SWIFT_TEST_HIDDEN_HELP="$(swift test --help-hidden 2>&1)"
if [[ "$SWIFT_TEST_HELP" == *"--no-parallel"* ]]; then
	SWIFT_ARGS+=(--no-parallel)
fi

append_file_output() {
	local variable_name="$1"
	local option="$2"
	local output_path="${!variable_name:-}"
	[ -n "$output_path" ] || return 0
	[[ "$SWIFT_TEST_HIDDEN_HELP" == *"$option"* ]] || {
		echo "FATAL: this Swift toolchain does not support $option" >&2
		exit 2
	}
	[ ! -e "$output_path" ] || {
		echo "FATAL: report output already exists: $output_path" >&2
		exit 2
	}
	mkdir -p "$(dirname "$output_path")"
	SWIFT_ARGS+=("$option=$output_path")
}

append_file_output DESKTOP_TEST_XUNIT_OUTPUT --xunit-output
append_file_output DESKTOP_TEST_EVENT_STREAM_OUTPUT --event-stream-output-path
if [ -n "${DESKTOP_TEST_EVENT_STREAM_OUTPUT:-}" ]; then
	SWIFT_ARGS+=(--event-stream-version=0)
fi

if [ -n "${DESKTOP_TEST_ATTACHMENTS_PATH:-}" ]; then
	[[ "$SWIFT_TEST_HIDDEN_HELP" == *"--attachments-path"* ]] || {
		echo "FATAL: this Swift toolchain does not support --attachments-path" >&2
		exit 2
	}
	mkdir -p "$DESKTOP_TEST_ATTACHMENTS_PATH"
	[ -z "$(find "$DESKTOP_TEST_ATTACHMENTS_PATH" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
		echo "FATAL: attachments output must be empty: $DESKTOP_TEST_ATTACHMENTS_PATH" >&2
		exit 2
	}
	SWIFT_ARGS+=("--attachments-path=$DESKTOP_TEST_ATTACHMENTS_PATH")
fi

# Xcode Command Line Tools places Swift Testing outside default search paths.
DEVELOPER_DIR="$(xcode-select -p)"
TESTING_FRAMEWORKS="$DEVELOPER_DIR/Library/Developer/Frameworks"
TESTING_PLUGIN="$DEVELOPER_DIR/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
TESTING_INTEROP="$DEVELOPER_DIR/Library/Developer/usr/lib"

if [ -d "$TESTING_FRAMEWORKS/Testing.framework" ] && [ -f "$TESTING_PLUGIN" ]; then
	TESTING_ARGS=(
		-Xswiftc -F
		-Xswiftc "$TESTING_FRAMEWORKS"
		-Xswiftc -load-plugin-library
		-Xswiftc "$TESTING_PLUGIN"
		-Xlinker -F
		-Xlinker "$TESTING_FRAMEWORKS"
		-Xlinker -rpath
		-Xlinker "$TESTING_FRAMEWORKS"
		-Xlinker -rpath
		-Xlinker "$TESTING_INTEROP"
	)
	SWIFT_ARGS+=("${TESTING_ARGS[@]}")
	SWIFT_DISCOVERY_ARGS+=("${TESTING_ARGS[@]}")
	export DYLD_FRAMEWORK_PATH="$TESTING_FRAMEWORKS${DYLD_FRAMEWORK_PATH:+:$DYLD_FRAMEWORK_PATH}"
	export DYLD_LIBRARY_PATH="$TESTING_INTEROP${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi

if [ -n "${DESKTOP_TEST_FILTER:-}" ]; then
	SWIFT_ARGS+=(--filter "$DESKTOP_TEST_FILTER")
fi

if [ -n "${DESKTOP_TEST_EXPECTED_SWIFT_TEST_SPECIFIER:-}" ]; then
	[ -n "${DESKTOP_TEST_FILTER:-}" ] || {
		echo "FATAL: an expected Swift test specifier requires DESKTOP_TEST_FILTER" >&2
		exit 2
	}
	case "$DESKTOP_TEST_EXPECTED_SWIFT_TEST_SPECIFIER" in
		*$'\n'*)
			echo "FATAL: expected Swift test specifier must be one line" >&2
			exit 2
			;;
	esac
	SWIFT_DISCOVERY_ARGS+=(list)
	DISCOVERED_TESTS="$(swift "${SWIFT_DISCOVERY_ARGS[@]}" | tr -d '\r')"
	EXPECTED_DISCOVERY_COUNT="$(printf '%s\n' "$DISCOVERED_TESTS" | awk \
		-v expected="$DESKTOP_TEST_EXPECTED_SWIFT_TEST_SPECIFIER" \
		'$0 == expected { count++ } END { print count + 0 }')"
	[ "$EXPECTED_DISCOVERY_COUNT" = "1" ] || {
		echo "FATAL: compiled Swift discovery did not expose exactly one expected test: $DESKTOP_TEST_EXPECTED_SWIFT_TEST_SPECIFIER" >&2
		exit 2
	}
	set +e
	SELECTED_DISCOVERED_TESTS="$(printf '%s\n' "$DISCOVERED_TESTS" | \
		grep -E -- "$DESKTOP_TEST_FILTER")"
	FILTER_STATUS="$?"
	set -e
	[ "$FILTER_STATUS" -le 1 ] || {
		echo "FATAL: DESKTOP_TEST_FILTER is not a valid discovery regular expression" >&2
		exit 2
	}
	SELECTED_DISCOVERY_COUNT="$(printf '%s\n' "$SELECTED_DISCOVERED_TESTS" | \
		sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
	[ "$SELECTED_DISCOVERY_COUNT" = "1" ] \
		&& [ "$SELECTED_DISCOVERED_TESTS" = "$DESKTOP_TEST_EXPECTED_SWIFT_TEST_SPECIFIER" ] || {
		echo "FATAL: DESKTOP_TEST_FILTER must select exactly the expected compiled Swift test" >&2
		exit 2
	}
	SWIFT_ARGS+=(--skip-build)
fi

swift "${SWIFT_ARGS[@]}"
