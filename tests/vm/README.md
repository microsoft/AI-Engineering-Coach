# `tests/vm` — fully automated, isolated end-to-end testing

This directory contains a **container-based, end-to-end test solution** for the
AI Engineer Coach extension. It replaces manual testing with two phases that can
run in full isolation (a Docker container with a virtual display), so nothing on
the host is required beyond Docker.

There are two clearly separated tracks, split by whether a **login** is needed:

| Track        | Needs login? | Data source                    | Verified by CI / this PR? |
| ------------ | ------------ | ------------------------------ | ------------------------- |
| **Authless** | No           | Synthetic fixtures on disk     | ✅ Yes — fully verified    |
| **Auth**     | Yes          | Real agent runs (collected)    | ⚠️ Coded, human-verified   |

The authless track answers *"does the UX work — does the extension install, do
all the views load, can I click around?"* without any account. The auth track
adds the real-session-data analytics; it is fully coded but its data depends on
an interactive login, so it is the **semi-automated second step** a human runs.

---

## Layout

```
tests/vm/
├── lib/                     # Authless data engine (no login)
│   ├── generate-fixtures.ts #   synthetic logs for all 5 harness families
│   ├── build-rpc-fixtures.ts#   real parser+analyzer → real RPC responses
│   ├── run-pipeline.ts      #   standalone verifier (assertions + artifacts)
│   └── seed-home.ts         #   seed fixtures into a real $HOME for VS Code
├── specs/                   # Headless authless webview walkthrough (Playwright)
│   └── authless-ui.spec.ts
├── harness.html             #   static page that boots the REAL webview bundle
├── playwright.vm.config.ts  #   port 3998, global-setup wired
├── global-setup.ts          #   regenerates fixtures + asserts before UI tests
├── ui/                      # Real-VS-Code UI tests (ExTester) — own package
│   ├── package.json         #   isolated deps (vscode-extension-tester, mocha…)
│   └── src/specs/
│       ├── authless.test.ts #   install VSIX, open dashboard, all views (no login)
│       └── auth.test.ts     #   real-data assertions (skipped unless AEC_AUTH_DATA=1)
├── data-collection/         # Drive REAL agents to produce logs (login required)
│   ├── collect-claude.sh / collect-codex.sh / collect-local.sh / collect-all.sh
│   └── README.md
├── Dockerfile               # isolated environment (VS Code + xvfb)
├── docker-compose.yml       # one-command runner
└── run.sh                   # phase orchestrator (build → pipeline → UI)
```

---

## How the authless track works (no login, no real data)

With **no** session data the dashboard intentionally shows a "no logs found"
error page, so authless UI testing needs *some* logs on disk — but **logs are
just files; writing them needs no login**. The pipeline is:

1. **Generate** synthetic logs for all five harness families the extension
   understands — Claude, Codex, GitHub Copilot CLI, VS Code Local Agent and
   OpenCode — into a throwaway `HOME` (`generate-fixtures.ts`).
2. **Parse + analyze** them with the **real** extension code (`findLogsDirs` →
   `parseAllLogs` → `Analyzer`) and assert the analytics are sane
   (`run-pipeline.ts`).
3. **Precompute RPC responses** by driving the **real production RPC handlers**
   (`getRpcHandler`), so a static harness serves the exact bytes the extension
   would return (`build-rpc-fixtures.ts`).
4. **Drive the real webview bundle** (`dist/webview/app.js`) over that real data
   with Playwright, clicking through every top-level view and asserting none
   render an error boundary or get stuck on a spinner; a screenshot of each view
   is saved to `.artifacts/screenshots` (`specs/authless-ui.spec.ts`).

This exercises the production parser, analyzer, RPC contract and rendering code
— the whole stack except the VS Code shell and login.

The **ExTester** layer (`ui/`) then closes the last gap: it installs the actual
VSIX into a **real VS Code** under a virtual display, runs the
`AI Engineer Coach: Open Dashboard` command and walks the same views in the real
webview — still authless, because the fixtures are seeded into `HOME` first.

---

## Running it

### Everything, isolated, in one command

```bash
docker compose -f tests/vm/docker-compose.yml run --rm e2e
```

This builds the extension, runs the authless data-pipeline assertions, runs the
headless authless webview walkthrough, packages the VSIX, then downloads a real
VS Code and runs the real-VS-Code authless UI suite — all inside the container.

Headless-only (skip the real-VS-Code download/UI phase):

```bash
SKIP_VSCODE_UI=1 docker compose -f tests/vm/docker-compose.yml run --rm e2e
```

### Individual phases on the host

```bash
npm run vm:pipeline   # authless data pipeline assertions (real parser+analyzer)
npm run vm:ui         # authless headless webview walkthrough (Playwright)
npm run vm:e2e        # full orchestrator (tests/vm/run.sh)
npm run vm:docker     # full orchestrator inside the container
```

### Auth track (second, semi-automated step)

1. Collect real logs (one-time interactive `copilot auth login`):

   ```bash
   bash tests/vm/data-collection/collect-all.sh
   ```

2. Verify the extension against the real data:

   ```bash
   AEC_AUTH_DATA=1 docker compose -f tests/vm/docker-compose.yml run --rm e2e
   ```

See [`data-collection/README.md`](./data-collection/README.md) for details.

---

## What was verified for this PR vs. left to the operator

- ✅ **Authless data pipeline** — runs the real parser + analyzer over the
  synthetic fixtures; all structural assertions pass (35 sessions, 19
  workspaces, all 5 harness families, AI lines-of-code attributed, anti-patterns
  and context-management present, 30+ RPC methods precomputed).
- ✅ **Authless headless webview walkthrough** — all top-level views render with
  no error boundary or stuck spinner; screenshots captured. Verified green.
- ⚠️ **Real-VS-Code ExTester suites** — fully coded and type-checked. They are
  **not** executed in this PR's sandbox because it cannot reach
  `update.code.visualstudio.com` to download VS Code. They run in the container
  / CI where that download is available.
- ⚠️ **Auth / data-collection** — fully coded. The underlying data needs an
  interactive login, so it is verified by a human as the semi-automated second
  step.

## Notes

- The authless code lives entirely outside `src/` so it never affects the
  shipped extension build, and `ui/` carries its own `package.json` so the heavy
  browser-automation dependencies stay isolated from the extension.
- Generated output (`.artifacts/`, screenshots, `ui/out/`, `ui/node_modules/`,
  collected logs) is git-ignored.
