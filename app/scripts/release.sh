#!/usr/bin/env bash
# Build the macOS Dashboard assets consumed by tw-dashboard-install.
#
# Run from anywhere: ./app/scripts/release.sh [--no-build] [--dry-run]
#
# The npm package intentionally contains no DMG. The installer reads its own
# package.version and downloads these two exact assets from GitHub Release
# v<version>, verifying the checksum before it mounts the image:
#   tw-dashboard-<version>-<arm64|x64>.dmg
#   tw-dashboard-<version>-<arm64|x64>.dmg.sha256
#
# This script stages the assets; uploading/publishing remains an explicit
# action in the release channel.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/app"
INSTALLER_DIR="$APP_DIR/installer"
TAURI_CONF="$APP_DIR/src-tauri/tauri.conf.json"
CARGO_TOML="$APP_DIR/src-tauri/Cargo.toml"

c_red()   { printf '\033[31m%s\033[0m' "$*"; }
c_green() { printf '\033[32m%s\033[0m' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m' "$*"; }
info()    { printf '%s %s\n' "$(c_dim '·')" "$*"; }
ok()      { printf '%s %s\n' "$(c_green '✓')" "$*"; }
die()     { printf '%s %s\n' "$(c_red '✗')" "$*" >&2; exit 1; }

skip_build=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --no-build) skip_build=1 ;;
    --dry-run)  dry_run=1 ;;
    -h|--help)  sed -n '2,13p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

[[ -f "$TAURI_CONF" ]] || die "tauri.conf.json not found at $TAURI_CONF"
[[ -f "$CARGO_TOML" ]] || die "Cargo.toml not found at $CARGO_TOML"

package_version=$(node -p "require('$REPO_ROOT/package.json').version")
app_package_version=$(node -p "require('$APP_DIR/package.json').version")
tauri_version=$(node -p "require('$TAURI_CONF').version")
cargo_version=$(awk '
  $0 == "[package]" { in_package = 1; next }
  /^\[/ { in_package = 0 }
  in_package && $1 == "version" {
    value = $3
    gsub(/"/, "", value)
    print value
    exit
  }
' "$CARGO_TOML")

[[ -n "$package_version" && "$package_version" != "undefined" ]] \
  || die "could not read version from package.json"
[[ "$app_package_version" == "$package_version" ]] \
  || die "version mismatch: root=$package_version app=$app_package_version"
[[ "$tauri_version" == "$package_version" ]] \
  || die "version mismatch: root=$package_version tauri=$tauri_version"
[[ "$cargo_version" == "$package_version" ]] \
  || die "version mismatch: root=$package_version cargo=$cargo_version"
info "validated release version across npm, app, Tauri, and Cargo: $package_version"

machine_arch=$(uname -m)
case "$machine_arch" in
  arm64)
    release_arch="arm64"
    tauri_arch="aarch64"
    ;;
  x86_64)
    release_arch="x64"
    tauri_arch="x64"
    ;;
  *)
    die "unsupported release architecture: $machine_arch"
    ;;
esac

dmg_src="$APP_DIR/src-tauri/target/release/bundle/dmg/tw-dashboard_${package_version}_${tauri_arch}.dmg"
if [[ "$skip_build" -eq 0 ]]; then
  info "running tauri build (--no-build to use existing artifacts)"
  # Stable local signing preserves keychain/TCC grants across local rebuilds.
  # Release automation may override this with its distribution identity.
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-tmux-worktree Local Dashboard Signing}"
  ( cd "$APP_DIR" && npm run tauri build )
fi
[[ -f "$dmg_src" ]] \
  || die "DMG not found at $dmg_src — drop --no-build, or check the Tauri output"

app_bundle="$APP_DIR/src-tauri/target/release/bundle/macos/tw-dashboard.app"
[[ -d "$app_bundle" ]] || die "app bundle not found at $app_bundle"
codesign --verify --deep --strict "$app_bundle" \
  || die "app bundle signature or sealed resources are invalid"
ok "verified app bundle signature and sealed resources"

asset_name="tw-dashboard-${package_version}-${release_arch}.dmg"
dmg_dst="$INSTALLER_DIR/dmg/$asset_name"
checksum_dst="$dmg_dst.sha256"
mkdir -p "$INSTALLER_DIR/dmg"
cp -f "$dmg_src" "$dmg_dst"

checksum=$(shasum -a 256 "$dmg_dst" | awk '{print $1}' | tr 'A-F' 'a-f')
[[ ${#checksum} -eq 64 && "$checksum" != *[!0-9a-f]* ]] \
  || die "could not calculate DMG SHA-256"
printf '%s  %s\n' "$checksum" "$asset_name" > "$checksum_dst"
( cd "$(dirname "$dmg_dst")" && shasum -a 256 -c "$(basename "$checksum_dst")" ) \
  || die "generated DMG checksum does not verify"
ok "staged $asset_name ($(du -h "$dmg_dst" | awk '{print $1}'))"
ok "staged $(basename "$checksum_dst")"

release_url="https://github.com/Sskift/tmux-worktree/releases/download/v${package_version}"
if [[ "$dry_run" -eq 1 ]]; then
  info "dry run — assets are ready; no upload was attempted"
fi

echo
echo "  GitHub Release: v$package_version"
echo "  Assets:"
echo "    $dmg_dst"
echo "    $checksum_dst"
echo "  Installer URLs:"
echo "    $release_url/$asset_name"
echo "    $release_url/$asset_name.sha256"
echo
