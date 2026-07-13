#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODE=${1:-core}

run_docs() {
  echo "==> documentation"
  node "$ROOT/scripts/check-docs.mjs"
  git -C "$ROOT" diff --check
  git -C "$ROOT" diff --cached --check
}

run_cli() {
  echo "==> root CLI"
  (
    cd "$ROOT"
    npm run build
    npm run test:cli
  )
}

run_dashboard() {
  echo "==> Dashboard renderer"
  (
    cd "$ROOT/app"
    npm run build
    npm run test:typecheck
    npm test
  )
}

run_rust() {
  echo "==> Tauri Rust"
  (
    cd "$ROOT/app/src-tauri"
    cargo fmt --check
    cargo check
    cargo test
  )
}

prepare_android_sdk() {
  if [ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ] || \
    [ -f "$ROOT/mobile/android/local.properties" ]; then
    return
  fi

  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME=$candidate
      return
    fi
  done

  echo "Android SDK not found; set ANDROID_HOME or mobile/android/local.properties" >&2
  exit 2
}

run_android() {
  echo "==> Android JVM, lint, and build"
  prepare_android_sdk
  "$ROOT/mobile/android/gradlew" -p "$ROOT/mobile/android" \
    :app:testDebugUnitTest \
    :app:lintDebug \
    :app:lintRelease \
    :app:assembleDebug \
    :app:assembleRelease
}

run_device() {
  echo "==> Android connected device"
  prepare_android_sdk
  "$ROOT/mobile/android/gradlew" -p "$ROOT/mobile/android" \
    :app:connectedDebugAndroidTest
}

case "$MODE" in
  docs)
    run_docs
    ;;
  core)
    run_cli
    run_dashboard
    run_rust
    run_docs
    ;;
  android)
    run_android
    run_docs
    ;;
  all)
    run_cli
    run_dashboard
    run_rust
    run_android
    run_docs
    ;;
  device)
    run_cli
    run_dashboard
    run_rust
    run_android
    run_device
    run_docs
    ;;
  *)
    echo "usage: $0 [docs|core|android|all|device]" >&2
    exit 2
    ;;
esac
