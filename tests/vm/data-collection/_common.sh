#!/usr/bin/env bash
#
# Shared helpers for the data-collection scripts.
#
# These scripts drive REAL coding agents through the GitHub Copilot CLI so the
# agents write their native session logs to disk (~/.claude, ~/.codex,
# ~/.copilot, ~/.config/Code, ...). Those logs are exactly what the extension
# parses. Producing them requires an authenticated (logged-in) Copilot session,
# so the login step is interactive and is NOT automated here.
#
# Everything *after* login is automated: each collector sends a fixed prompt to
# a throwaway scratch workspace and waits for the agent to finish.

set -euo pipefail

DC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH_DIR="${AEC_SCRATCH_DIR:-$DC_ROOT/.collected/scratch}"

# A small, self-contained task that makes the agent read, reason and WRITE code
# (fenced code blocks → the parser attributes AI lines-of-code).
read -r -d '' COLLECT_PROMPT <<'PROMPT' || true
Create a file called greeter.ts that exports a function `greet(name: string): string`
returning "Hello, <name>!". Then add a second function `farewell(name: string): string`
returning "Goodbye, <name>!". Show the full file contents in your response.
PROMPT

dc_log() { printf '\n\033[1;35m[data-collection] %s\033[0m\n' "$*"; }

dc_require() {
  local bin="$1" hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: required command '$bin' not found. $hint" >&2
    exit 127
  fi
}

dc_prepare_scratch() {
  rm -rf "$SCRATCH_DIR"
  mkdir -p "$SCRATCH_DIR"
  ( cd "$SCRATCH_DIR" && git init -q 2>/dev/null || true )
  echo "$SCRATCH_DIR"
}

# Verify the Copilot CLI is logged in; instruct the operator if not. This is the
# ONLY manual step in the whole pipeline.
dc_require_copilot_auth() {
  dc_require copilot "Install the GitHub Copilot CLI: https://github.com/github/copilot-cli"
  if ! copilot auth status >/dev/null 2>&1; then
    cat >&2 <<'MSG'
==============================================================================
 GitHub Copilot CLI is not authenticated.

 Run the interactive login once, then re-run this collector:

     copilot auth login

 (This is the deliberate, human-in-the-loop auth step. Everything after it is
  fully automated.)
==============================================================================
MSG
    exit 10
  fi
}
