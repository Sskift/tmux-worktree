#!/usr/bin/env bash
# Release tw-dashboard via bnpm.
# Run from anywhere:  ./app/scripts/release.sh
#
# Steps:
#   1. Read version from app/src-tauri/tauri.conf.json
#   2. Build the dmg (skip with --no-build if already built)
#   3. Copy dmg into app/installer/dmg/tw-dashboard-arm64.dmg
#   4. Sync app/installer/package.json version
#   5. npm publish from app/installer/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/app"
INSTALLER_DIR="$APP_DIR/installer"
TAURI_CONF="$APP_DIR/src-tauri/tauri.conf.json"
REGISTRY="https://bnpm.byted.org"

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
    -h|--help)  sed -n '2,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

[[ -f "$TAURI_CONF" ]] || die "tauri.conf.json not found at $TAURI_CONF"
version=$(node -p "require('$TAURI_CONF').version")
[[ -n "$version" && "$version" != "undefined" ]] || die "could not read version from tauri.conf.json"
info "version: $version"

arch=$(uname -m)
[[ "$arch" == "arm64" ]] || die "release.sh currently only handles arm64 builds (running on $arch)"

dmg_src="$APP_DIR/src-tauri/target/release/bundle/dmg/tw-dashboard_${version}_aarch64.dmg"
if [[ "$skip_build" -eq 0 ]]; then
  info "running tauri build (use --no-build to skip)"
  ( cd "$APP_DIR" && npm run tauri build )
fi
[[ -f "$dmg_src" ]] || die "dmg not found at $dmg_src — run without --no-build, or check the build output"

dmg_dst="$INSTALLER_DIR/dmg/tw-dashboard-arm64.dmg"
mkdir -p "$INSTALLER_DIR/dmg"
cp -f "$dmg_src" "$dmg_dst"
ok "copied dmg → $dmg_dst ($(du -h "$dmg_dst" | awk '{print $1}'))"

# Sync installer package.json version
node - <<NODE
const fs = require('node:fs');
const path = '$INSTALLER_DIR/package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = '$version';
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
NODE
ok "synced installer/package.json version → $version"

if [[ "$dry_run" -eq 1 ]]; then
  info "dry run — would now: cd $INSTALLER_DIR && npm publish --registry=$REGISTRY"
  info "tarball preview:"
  ( cd "$INSTALLER_DIR" && npm pack --dry-run 2>&1 | sed 's/^/    /' )
  exit 0
fi

info "publishing to $REGISTRY"
( cd "$INSTALLER_DIR" && npm publish --registry="$REGISTRY" )
ok "published @byted-codebase/tw-dashboard-installer@$version"

echo
echo "  Verify install:"
echo "    npx -y --registry=$REGISTRY @byted-codebase/tw-dashboard-installer"
echo
