#!/usr/bin/env bash
set -euo pipefail

ROOT="${SURFACELOOM_ARCHITECTURE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FORBIDDEN='import[[:space:]]+SurfaceLoomMacOS|SurfaceLoom[.]WindowsHost|RequestDispatcher|HostProtocol|RpcRequest|kAX|CGEvent|virtualKey|AXLocator|AXUIElement|MacOSApplicationDriver|AutomationElement|ControlType|SendInput|screenCoordinate|CGPoint|UiaLocator|UiaSession|ElementSnapshot|WindowsHostSession|SendKeys|[.][Ss]ession([^[:alnum:]_]|$)|[.][Dd]river([^[:alnum:]_]|$)'
SEARCH_BACKEND="${SURFACELOOM_ARCHITECTURE_SEARCH_BACKEND:-auto}"
case "$SEARCH_BACKEND" in
	auto) [ -z "$(command -v rg 2>/dev/null)" ] && USE_RG=0 || USE_RG=1 ;;
	rg)
		command -v rg >/dev/null 2>&1 || {
			echo "FATAL: requested architecture search backend 'rg' is unavailable" >&2
			exit 2
		}
		USE_RG=1
		;;
	grep) USE_RG=0 ;;
	*)
		echo "FATAL: unknown architecture search backend: $SEARCH_BACKEND" >&2
		exit 2
		;;
esac

walk_source_tree() {
	find "$@" \
		\( -name .build -o -name .git -o -name artifacts -o -name bin \
			-o -name dist -o -name node_modules -o -name obj \) -prune -o \
		-print0
}

search_with_status() {
	local status
	if "$@"; then
		return 0
	else
		status=$?
	fi
	if [ "$status" -eq 1 ]; then
		return 1
	fi
	echo "FATAL: architecture search backend failed with exit status $status: $1" >&2
	exit 2
}

reject_source_symlink() {
	echo "FATAL: symbolic links are not allowed in architecture source trees: $1" >&2
	exit 2
}

SEARCH_PATHS=()
for path in "$ROOT/Tests" "$ROOT/projects"; do
	[ ! -d "$path" ] || SEARCH_PATHS+=("$path")
done

SCENARIO_FILES=()
if [ "${#SEARCH_PATHS[@]}" -gt 0 ]; then
	while IFS= read -r -d '' file; do
		if [ -L "$file" ]; then
			reject_source_symlink "$file"
		fi
		[ -f "$file" ] || continue
		case "$file" in
			*/Scenarios/*|"$ROOT"/projects/*/Tests/*) ;;
			*) continue ;;
		esac
		case "$file" in
			*/Support/*|*/Adapter/*|*/Contracts/*|*/contracts/*) continue ;;
		esac
		SCENARIO_FILES+=("$file")
	done < <(
		walk_source_tree "${SEARCH_PATHS[@]}"
	)
fi

if [ "${#SCENARIO_FILES[@]}" -gt 0 ]; then
	if [ "$USE_RG" -eq 1 ]; then
		if search_with_status rg -n --with-filename -e "$FORBIDDEN" -- "${SCENARIO_FILES[@]}"; then
			echo "FATAL: scenario tests must use components instead of raw Accessibility APIs" >&2
			exit 2
		fi
	elif search_with_status grep -EHn -- "$FORBIDDEN" "${SCENARIO_FILES[@]}"; then
		echo "FATAL: scenario tests must use components instead of raw Accessibility APIs" >&2
		exit 2
	fi
fi

SHARED_SOURCE_FILES=()
for path in "$ROOT/packages" "$ROOT/native"; do
	[ ! -d "$path" ] || while IFS= read -r -d '' file; do
		if [ -L "$file" ]; then reject_source_symlink "$file"; fi
		[ ! -f "$file" ] || SHARED_SOURCE_FILES+=("$file")
	done < <(walk_source_tree "$path")
done
for path in "$ROOT/Sources" "$ROOT/Tests" "$ROOT/Templates"; do
	[ ! -d "$path" ] || while IFS= read -r -d '' file; do
		if [ -L "$file" ]; then reject_source_symlink "$file"; fi
		[ ! -f "$file" ] || SHARED_SOURCE_FILES+=("$file")
	done < <(walk_source_tree "$path")
done
for file in "$ROOT/Package.swift" "$ROOT/Package.resolved"; do
	if [ -L "$file" ]; then reject_source_symlink "$file"; fi
	[ ! -f "$file" ] || SHARED_SOURCE_FILES+=("$file")
done
if [ -d "$ROOT/scripts" ]; then
	while IFS= read -r -d '' file; do
		if [ -L "$file" ]; then reject_source_symlink "$file"; fi
		[ ! -f "$file" ] || SHARED_SOURCE_FILES+=("$file")
	done < <(walk_source_tree "$ROOT/scripts")
fi

check_shared_pattern() {
	local pattern="$1"
	local mode="$2"
	[ "${#SHARED_SOURCE_FILES[@]}" -eq 0 ] && return 1
	if [ "$USE_RG" -eq 1 ]; then
		if [ "$mode" = fixed ]; then
			search_with_status rg -n --with-filename -i -F -e "$pattern" -- "${SHARED_SOURCE_FILES[@]}"
		elif [ "$mode" = insensitive-regex ]; then
			search_with_status rg -n --with-filename -i -e "$pattern" -- "${SHARED_SOURCE_FILES[@]}"
		else
			search_with_status rg -n --with-filename -e "$pattern" -- "${SHARED_SOURCE_FILES[@]}"
		fi
	elif [ "$mode" = fixed ]; then
		search_with_status grep -HinF -- "$pattern" "${SHARED_SOURCE_FILES[@]}"
	elif [ "$mode" = insensitive-regex ]; then
		search_with_status grep -EHin -- "$pattern" "${SHARED_SOURCE_FILES[@]}"
	else
		search_with_status grep -EHn -- "$pattern" "${SHARED_SOURCE_FILES[@]}"
	fi
}

shared_path_matches_product() {
	local product_pattern="$1"
	local mode="$2"
	local relative_path
	[ "${#SHARED_SOURCE_FILES[@]}" -eq 0 ] && return 1
	for file in "${SHARED_SOURCE_FILES[@]}"; do
		relative_path="${file#"$ROOT"/}"
		if [ "$mode" = fixed ]; then
			case "$(printf '%s' "$relative_path" | tr '[:upper:]' '[:lower:]')" in
				*"$product_pattern"*)
					printf '%s\n' "$file"
					return 0
					;;
			esac
		elif search_with_status grep -Eiq -- "$product_pattern" <<<"$relative_path"; then
				printf '%s\n' "$file"
				return 0
		fi
	done
	return 1
}

shared_product_identity_found() {
	local product_name="$1"
	local product_name_lower
	local compact_name
	product_name_lower="$(printf '%s' "$product_name" | tr '[:upper:]' '[:lower:]')"
	compact_name="$(printf '%s' "$product_name_lower" | tr -cd '[:alnum:]')"
	[ -n "$compact_name" ] || return 1
	if [ "$compact_name" != "$product_name_lower" ] \
		&& { check_shared_pattern "$product_name_lower" fixed \
			|| shared_path_matches_product "$product_name_lower" fixed; }; then
		return 0
	fi
	if [ "${#compact_name}" -le 3 ]; then
		local content_pattern="(^|[^[:alnum:]_])${compact_name}([^[:alnum:]_]|$)"
		local path_pattern="(^|[/_.-])${compact_name}([/_.-]|$)"
		check_shared_pattern "$content_pattern" insensitive-regex \
			|| shared_path_matches_product "$path_pattern" regex
		return
	fi
	local long_name="$product_name_lower"
	[ "$compact_name" = "$product_name_lower" ] || long_name="$compact_name"
	if check_shared_pattern "$long_name" fixed \
		|| shared_path_matches_product "$long_name" fixed; then
		return 0
	fi
	return 1
}

if check_shared_pattern 'projects[/\\][[:alnum:]_.-]+' regex; then
	echo "FATAL: shared sources/tests must not reference product project paths" >&2
	exit 2
fi

if [ -d "$ROOT/projects" ]; then
	while IFS= read -r -d '' product_dir; do
		product_name="$(basename "$product_dir")"
		if shared_product_identity_found "$product_name"; then
			echo "FATAL: shared sources/tests must not contain product name '$product_name'" >&2
			exit 2
		fi
	done < <(find "$ROOT/projects" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -print0)
fi

echo "Architecture check passed: scenarios use semantic components and shared layers are product-neutral"
