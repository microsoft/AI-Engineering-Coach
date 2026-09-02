# AI Engineer Coach — Canvas Extension

Runs the AI Engineer Coach dashboard as a canvas inside the GitHub Copilot app, reusing the exact webview bundle that ships in the VS Code extension.

This directory is the [`apm`](https://github.com/microsoft/apm) package source of truth for the
canvas (see the repo root [`apm.yml`](../../../apm.yml)). This repo loads it directly through a
one-line forwarding stub at [`.github/extensions/ai-engineer-coach/extension.mjs`](../../../.github/extensions/ai-engineer-coach/extension.mjs)
(the GitHub Copilot app only discovers canvases under `.github/extensions/`), so cloning and
building this repo works with no extra steps. Other projects can install the same canvas with
`apm install <repo> --target copilot --trust-canvas-extensions`, which deploys a copy of this
folder into their own `.github/extensions/ai-engineer-coach/`. Edit the canvas logic here, not
in the forwarding stub.

## What it does

- Opens a side-panel canvas titled **AI Engineer Coach**.
- Serves the built dashboard (`dist/webview/app.js` + `dist/webview/styles.css`) over a loopback HTTP server.
- Parses your local AI coding session logs in-process (the same parser the VS Code extension uses) and answers the dashboard's RPC calls directly.

## Setup flow

The canvas needs the project to be built first. When you open it on a fresh clone, it shows a setup card with one command:

```
npm install && npm run build
```

Run that in the repository root. The panel polls for a completed build and reloads itself into the full dashboard once `dist/canvas-host.cjs` and `dist/webview/app.js` exist. No manual reopen needed.

## Canvas vs VS Code differences

A few features depend on the local VS Code language model and are not available in canvas mode. They render read-only or greyed out:

- **Skill Finder** (generation and triage)
- **Learning Center** quizzes and resources
- **Context review** in Context Health

Everything driven purely by your on-disk logs — Dashboard, Timeline, Coding Moments, Output, Patterns, Anti-Patterns, Achievements — works the same as in VS Code.

## How it is wired

- `.github/extensions/ai-engineer-coach/extension.mjs` is a one-line forwarding stub (`import
  "../../../.apm/extensions/ai-engineer-coach/extension.mjs";`) so the GitHub Copilot app's
  project-canvas discovery — which only scans `.github/extensions/` — finds this package.
- `extension.mjs` (this directory) owns build detection and a single `127.0.0.1` HTTP server, and declares the canvas via `createCanvas` / `joinSession`.
- `dist/canvas-host.cjs` (built from `src/canvas/host.ts`) provides the request handler: the dashboard shell, the asset routes, an SSE channel for parse progress, and the `/rpc` endpoint.
- The dashboard talks to the host through an injected `acquireVsCodeApi` shim, so the webview code is unchanged between VS Code and canvas.

The harness breakdown distinguishes **GitHub Copilot App** (desktop) from **GitHub Copilot CLI** (terminal) using the `remoteSteerable` marker present in app session logs.
