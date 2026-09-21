#!/usr/bin/env bash
# Container-only workaround: when `pnpm install` cannot run (no registry access),
# link globally-installed toolchain packages into the workspace root node_modules so
# `tsc`, `tsx` and Node's test runner can resolve them. This is NOT part of the product
# build; CI and developer machines use `pnpm install`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GLOBAL="${NPM_GLOBAL_MODULES:-$(npm root -g)}"
EXTRA_TYPES="${EXTRA_TYPES_DIR:-/opt/node-tools/node_modules/@types}"
mkdir -p "$ROOT/node_modules/@types" "$ROOT/node_modules/.bin"
link() { # name source
  local name="$1" src="$2"
  if [ -e "$src" ] && [ ! -e "$ROOT/node_modules/$name" ]; then ln -s "$src" "$ROOT/node_modules/$name"; echo "linked $name -> $src"; fi
}
link typescript "$GLOBAL/typescript"
link tsx "$GLOBAL/tsx"
link react "$GLOBAL/react"
link react-dom "$GLOBAL/react-dom"
link @types/node "$EXTRA_TYPES/node"
[ -e "$ROOT/node_modules/.bin/tsc" ] || ln -s "$GLOBAL/typescript/bin/tsc" "$ROOT/node_modules/.bin/tsc"
[ -e "$ROOT/node_modules/.bin/tsx" ] || ln -s "$GLOBAL/tsx/dist/cli.mjs" "$ROOT/node_modules/.bin/tsx"
echo "local toolchain linked (workaround; run 'pnpm install' when registry access exists)"
