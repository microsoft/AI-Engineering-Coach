#!/usr/bin/env bash
#
# Collect a CODEX session log by running the Codex (GPT) agent via the Copilot
# CLI. Produces logs under ~/.codex/sessions/Y/MM/DD/rollout-*.jsonl, which the
# extension's Codex parser reads.
#
# Auth (login) is required and interactive — see _common.sh. Everything else is
# automated.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

dc_require_copilot_auth
SCRATCH="$(dc_prepare_scratch)"

dc_log "Running Codex/GPT agent in $SCRATCH"
(
  cd "$SCRATCH"
  copilot --model "${AEC_CODEX_MODEL:-gpt-5-codex}" \
          --allow-all-tools \
          -p "$COLLECT_PROMPT"
)

dc_log "Done. Codex logs should now exist under \$HOME/.codex/sessions/"
