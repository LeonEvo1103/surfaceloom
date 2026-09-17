#!/bin/sh
set -eu

fixture_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact_root=${SURFACELOOM_FIXTURE_ARTIFACT_ROOT:-"$fixture_root/build/artifacts"}
app_name=SurfaceLoomMacOSFixture.app
executable_name=SurfaceLoomMacOSFixture
plist_source="$fixture_root/AppBundle/Info.plist"
contract_source="$fixture_root/fixture-contract.v1.json"

if [ -z "$artifact_root" ]; then
    echo "artifact root must not be empty" >&2
    exit 2
fi

mkdir -p "$artifact_root"
artifact_root=$(CDPATH= cd -- "$artifact_root" && pwd)
final_app="$artifact_root/$app_name"
stage_root=$(mktemp -d "$artifact_root/.surfaceloom-fixture-stage.XXXXXX")
stage_app="$stage_root/$app_name"

cleanup() {
    rm -rf "$stage_root"
}
trap cleanup EXIT HUP INT TERM

swift build --package-path "$fixture_root" --configuration release
binary_root=$(swift build --package-path "$fixture_root" --configuration release --show-bin-path)
binary_source="$binary_root/$executable_name"

if [ ! -f "$binary_source" ] || [ ! -x "$binary_source" ]; then
    echo "release executable is missing or not executable: $binary_source" >&2
    exit 1
fi

mkdir -p "$stage_app/Contents/MacOS" "$stage_app/Contents/Resources"
cp "$binary_source" "$stage_app/Contents/MacOS/$executable_name"
chmod 755 "$stage_app/Contents/MacOS/$executable_name"
cp "$plist_source" "$stage_app/Contents/Info.plist"
cp "$contract_source" "$stage_app/Contents/Resources/fixture-contract.v1.json"
/usr/bin/plutil -lint "$stage_app/Contents/Info.plist" >/dev/null

case "$final_app" in
    "$artifact_root/$app_name") ;;
    *)
        echo "refusing to replace an unexpected artifact path: $final_app" >&2
        exit 2
        ;;
esac

rm -rf "$final_app"
mv "$stage_app" "$final_app"
echo "$final_app"
