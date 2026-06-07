#!/usr/bin/env bash
#
# End-to-end test orchestrator for the AI Engineer Coach extension.
#
# Designed to run inside the container defined by tests/vm/Dockerfile, but it
# works on any Linux host that has Node, npm, xvfb and the usual Electron
# libraries available.
#
# Phases:
#   1. build      — compile the extension bundle
#   2. pipeline   — authless data pipeline assertions (real parser + analyzer)
#   3. webview    — authless headless webview walkthrough (Playwright)
#   4. package    — produce the VSIX
#   5. vscode-ui  — install the VSIX into a real VS Code and drive every view
#                   (authless; the auth suite is skipped unless AEC_AUTH_DATA=1)
#
# Set SKIP_VSCODE_UI=1 to stop after the headless phases (useful where a real
# VS Code download is not available).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }

log "1/5 Building the extension"
npm run build

log "2/5 Authless data pipeline assertions"
npx -y tsx tests/vm/lib/run-pipeline.ts

log "3/5 Authless headless webview walkthrough (Playwright)"
npx playwright test --config=tests/vm/playwright.vm.config.ts

if [ "${SKIP_VSCODE_UI:-0}" = "1" ]; then
  log "SKIP_VSCODE_UI=1 — stopping after headless phases"
  exit 0
fi

log "4/5 Packaging the VSIX"
npm run package
VSIX_PATH="$(ls -t "$REPO_ROOT"/*.vsix | head -n1)"
echo "Packaged: $VSIX_PATH"

log "5/5 Real-VS-Code UI suite (ExTester under xvfb)"
cd "$REPO_ROOT/tests/vm/ui"
npm install --no-audit --no-fund

export VSIX_PATH
export CODE_VERSION="${CODE_VERSION:-stable}"

# Seed synthetic fixtures into the HOME the VS Code process will run as.
SEED_HOME="${HOME}" npx -y tsx "$REPO_ROOT/tests/vm/lib/seed-home.ts"

# ExTester drives a real (non-headless) VS Code; run it under a virtual display.
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run --auto-servernum --server-args='-screen 0 1600x1200x24' npm run e2e
else
  npm run e2e
fi

log "All phases complete"
