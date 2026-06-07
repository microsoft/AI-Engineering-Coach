# Data collection (auth required)

These scripts drive **real** coding agents through the GitHub Copilot CLI so the
agents write their native session logs to disk. Those logs are exactly what the
AI Engineer Coach extension parses, so collecting them lets you verify the
extension against genuine data.

> **Auth is the one manual step.** Producing real logs requires a logged-in
> Copilot session. The login (`copilot auth login`) is interactive and is **not**
> automated. Everything after login is fully scripted.

## Prerequisites

- [GitHub Copilot CLI](https://github.com/github/copilot-cli) installed (`copilot`)
- A one-time interactive login:

  ```bash
  copilot auth login
  ```

## Collectors

| Script              | Agent          | Logs written to                                  |
| ------------------- | -------------- | ------------------------------------------------ |
| `collect-claude.sh` | Claude family  | `~/.claude/projects/<cwd>/<uuid>.jsonl`          |
| `collect-codex.sh`  | Codex / GPT    | `~/.codex/sessions/Y/MM/DD/rollout-*.jsonl`      |
| `collect-local.sh`  | Local (CLI)    | `~/.copilot/session-state/<id>/events.jsonl`     |
| `collect-all.sh`    | all of the above | —                                              |

Each collector sends the same small, self-contained coding task to a throwaway
scratch workspace (`.collected/scratch`) and waits for the agent to finish. The
model ids are overridable, e.g.:

```bash
AEC_CLAUDE_MODEL=claude-sonnet-4.5 bash collect-claude.sh
AEC_CODEX_MODEL=gpt-5-codex        bash collect-codex.sh
```

## Run everything

```bash
bash tests/vm/data-collection/collect-all.sh
```

## Verify against the real data (semi-automated second step)

Once logs exist under `$HOME`, run the **auth** UI suite — it installs the VSIX
into a real VS Code and checks that the dashboard surfaces the real analytics:

```bash
AEC_AUTH_DATA=1 docker compose -f tests/vm/docker-compose.yml run --rm e2e
```

The auth suite (`tests/vm/ui/src/specs/auth.test.ts`) is skipped unless
`AEC_AUTH_DATA=1`, because it depends on the collected logs being present.

## What is and isn't verified by CI

- The **authless** suites (synthetic fixtures, no login) are fully automated and
  run in CI / the container.
- The collectors and the **auth** suite are coded and ready, but the underlying
  data requires the manual login, so they are verified by a human as the
  second, semi-automated step.
