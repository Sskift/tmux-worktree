#!/usr/bin/env bash
# Release tw-dashboard via npm.
# Bundled into the tmux-worktree package alongside the tw CLI.
#
# Run from anywhere:  ./app/scripts/release.sh
#
# Steps:
#   1. Read tauri.conf.json version → locate dmg
#   2. Build (skip with --no-build). Tauri beforeBuild also builds root dist
#      so the Dashboard bundle includes the tw serve backend.
#   3. Copy dmg into app/installer/dmg/tw-dashboard-arm64.dmg
#   4. Read root package.json version (user bumps this manually)
#   5. npm publish from repo root

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/app"
INSTALLER_DIR="$APP_DIR/installer"
TAURI_CONF="$APP_DIR/src-tauri/tauri.conf.json"
ROOT_PKG="$REPO_ROOT/package.json"
REGISTRY="https://registry.npmjs.org"

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
    -h|--help)  sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

[[ -f "$TAURI_CONF" ]] || die "tauri.conf.json not found at $TAURI_CONF"
[[ -f "$ROOT_PKG" ]]   || die "root package.json not found at $ROOT_PKG"
tauri_version=$(node -p "require('$TAURI_CONF').version")
pkg_version=$(node -p "require('$ROOT_PKG').version")
[[ -n "$tauri_version" && "$tauri_version" != "undefined" ]] || die "could not read version from tauri.conf.json"
[[ -n "$pkg_version"   && "$pkg_version"   != "undefined" ]] || die "could not read version from root package.json"
info "tauri build version (dmg name): $tauri_version"
info "npm package version (publish):  $pkg_version"

arch=$(uname -m)
[[ "$arch" == "arm64" ]] || die "release.sh currently only handles arm64 builds (running on $arch)"

dmg_src="$APP_DIR/src-tauri/target/release/bundle/dmg/tw-dashboard_${tauri_version}_aarch64.dmg"
if [[ "$skip_build" -eq 0 ]]; then
  info "running tauri build (--no-build to skip)"
  ( cd "$APP_DIR" && npm run tauri build )
fi
[[ -f "$dmg_src" ]] || die "dmg not found at $dmg_src — drop --no-build, or check the build output"

dmg_dst="$INSTALLER_DIR/dmg/tw-dashboard-arm64.dmg"
mkdir -p "$INSTALLER_DIR/dmg"
cp -f "$dmg_src" "$dmg_dst"
ok "copied dmg → $dmg_dst ($(du -h "$dmg_dst" | awk '{print $1}'))"

if [[ "$dry_run" -eq 1 ]]; then
  info "dry run — would now: cd $REPO_ROOT && npm publish --registry=$REGISTRY"
  info "tarball preview:"
  ( cd "$REPO_ROOT" && npm pack --dry-run 2>&1 | sed 's/^/    /' )
  exit 0
fi

info "publishing to $REGISTRY"
( cd "$REPO_ROOT" && npm publish --registry="$REGISTRY" )
ok "published tmux-worktree@$pkg_version"

echo
echo "  Verify install:"
echo "    npx -y --registry=$REGISTRY -p tmux-worktree tw-dashboard-install"
echo
