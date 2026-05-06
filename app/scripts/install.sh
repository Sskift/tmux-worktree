#!/usr/bin/env bash
# tw-dashboard one-line installer.
# Usage: curl -fsSL https://code.byted.org/jiangyunong/tmux-worktree/raw/feat/tauri-dashboard/app/scripts/install.sh | bash
set -euo pipefail

REPO_URL="https://code.byted.org/jiangyunong/tmux-worktree"
ASSET_NAME="tw-dashboard.dmg"
DMG_URL="${REPO_URL}/releases/permalink/latest/downloads/${ASSET_NAME}"
APP_NAME="tw-dashboard.app"
INSTALL_DIR="/Applications"

c_red()   { printf '\033[31m%s\033[0m' "$*"; }
c_green() { printf '\033[32m%s\033[0m' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m' "$*"; }
info()    { printf '%s %s\n' "$(c_dim '·')" "$*"; }
ok()      { printf '%s %s\n' "$(c_green '✓')" "$*"; }
die()     { printf '%s %s\n' "$(c_red '✗')" "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "tw-dashboard only supports macOS for now."

arch="$(uname -m)"
case "$arch" in
  arm64) ;;
  x86_64) die "Apple Silicon (arm64) only for now. Intel build pending — ping the maintainer." ;;
  *) die "Unsupported architecture: $arch" ;;
esac

for cmd in curl hdiutil xattr ditto; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

tmpdir="$(mktemp -d -t tw-dashboard-install)"
trap 'rm -rf "$tmpdir"; [[ -n "${MOUNT_POINT:-}" ]] && hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true' EXIT

dmg_path="$tmpdir/$ASSET_NAME"
info "downloading from $DMG_URL"
if ! curl -fL --progress-bar "$DMG_URL" -o "$dmg_path"; then
  die "download failed. check network / VPN, or open $DMG_URL in a browser to verify the asset exists."
fi
size_kb=$(( $(stat -f%z "$dmg_path") / 1024 ))
ok "downloaded ${size_kb} KiB"

info "mounting dmg"
mount_output="$(hdiutil attach -nobrowse -readonly "$dmg_path")"
MOUNT_POINT="$(printf '%s' "$mount_output" | awk -F'\t' '/\/Volumes\// { print $NF; exit }')"
[[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]] || die "could not determine mount point"
[[ -d "$MOUNT_POINT/$APP_NAME" ]] || die "$APP_NAME not found in dmg"

if [[ -d "$INSTALL_DIR/$APP_NAME" ]]; then
  info "removing existing $INSTALL_DIR/$APP_NAME"
  rm -rf "$INSTALL_DIR/$APP_NAME" 2>/dev/null \
    || die "failed to remove existing app — try: sudo rm -rf $INSTALL_DIR/$APP_NAME"
fi

info "copying to $INSTALL_DIR"
ditto "$MOUNT_POINT/$APP_NAME" "$INSTALL_DIR/$APP_NAME"

info "removing macOS quarantine attribute"
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

ok "installed to $INSTALL_DIR/$APP_NAME"
echo
echo "  Launch:  open -a tw-dashboard"
echo "  Or just double-click it in Finder."
echo
