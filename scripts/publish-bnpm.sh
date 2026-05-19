#!/bin/bash
# Publish to bnpm (ByteDance internal npm registry) under @byted-codebase scope
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

# Build first
npm run build

# Temporarily modify package.json for internal publish
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.name = '@byted-codebase/tmux-worktree';
pkg.publishConfig = { registry: 'https://bnpm.byted.org' };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Publish
npm publish --access public --registry=https://bnpm.byted.org

# Restore package.json
git checkout package.json

echo "Published to bnpm successfully."
