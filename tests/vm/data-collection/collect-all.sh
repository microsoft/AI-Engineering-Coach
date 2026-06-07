#!/usr/bin/env bash
#
# Run every collector in sequence to produce a full multi-harness dataset
# (Claude + Codex + local agent). After this completes, the collected logs live
# in the standard locations under $HOME and can be verified end-to-end with the
# auth UI suite:
#
#     AEC_AUTH_DATA=1 docker compose -f tests/vm/docker-compose.yml run --rm e2e
#
# The single manual step is the one-time `copilot auth login` (see _common.sh).

set -euo pipefail
DC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$DC_ROOT/collect-claude.sh"
bash "$DC_ROOT/collect-codex.sh"
bash "$DC_ROOT/collect-local.sh"

printf '\n\033[1;32mAll collectors finished. Real session logs are now under $HOME.\033[0m\n'
