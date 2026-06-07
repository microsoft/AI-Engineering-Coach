#!/usr/bin/env bash
#
# Collect a LOCAL agent session log. The Copilot CLI itself is the "local agent"
# and writes events under ~/.copilot/session-state/<id>/events.jsonl, which the
# extension's Copilot CLI parser reads. (The VS Code in-editor agent writes to
# ~/.config/Code/User/workspaceStorage/.../chatSessions instead; drive that from
# the real VS Code UI in tests/vm/ui if you want that harness too.)
#
# Auth (login) is required and interactive — see _common.sh. Everything else is
# automated.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

dc_require_copilot_auth
SCRATCH="$(dc_prepare_scratch)"

dc_log "Running local Copilot CLI agent in $SCRATCH"
(
  cd "$SCRATCH"
  copilot --allow-all-tools -p "$COLLECT_PROMPT"
)

dc_log "Done. Local agent logs should now exist under \$HOME/.copilot/session-state/"
