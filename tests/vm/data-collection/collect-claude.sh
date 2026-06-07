#!/usr/bin/env bash
#
# Collect a CLAUDE session log by running the Claude agent via the Copilot CLI.
# Produces logs under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl, which the
# extension's Claude parser reads.
#
# Auth (login) is required and interactive — see _common.sh. Everything else is
# automated. This script is provided complete but is verified by the operator as
# the semi-automated second step.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

dc_require_copilot_auth
SCRATCH="$(dc_prepare_scratch)"

dc_log "Running Claude agent in $SCRATCH"
(
  cd "$SCRATCH"
  # --model selects the Claude family; adjust to an available Claude model id.
  copilot --model "${AEC_CLAUDE_MODEL:-claude-sonnet-4.5}" \
          --allow-all-tools \
          -p "$COLLECT_PROMPT"
)

dc_log "Done. Claude logs should now exist under \$HOME/.claude/projects/"
