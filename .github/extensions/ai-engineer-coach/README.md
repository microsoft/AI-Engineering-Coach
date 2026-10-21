# AI Engineer Coach — Canvas Extension

Runs the AI Engineer Coach dashboard as a canvas inside the GitHub Copilot app, reusing the exact webview bundle that ships in the VS Code extension.

## What it does

- Opens a side-panel canvas titled **AI Engineer Coach**.
- Serves the built dashboard (`dist/webview/app.js` + `dist/webview/styles.css`) over a loopback HTTP server.
- Parses your local AI coding session logs in the existing parse worker and answers the dashboard's RPC calls directly.

## Setup flow

The canvas needs Node.js on `PATH` and the project to be built first. It starts the parse and analytics workers with `node`, even when the canvas provider runs under the packaged Copilot CLI. The dashboard shows one progress screen until parsing and background analytics finish. If analytics fail, the canvas shows the error; reload the canvas to try again. When you open it on a fresh clone, it shows a setup card with one command:

```
npm install && npm run build
```

Run that in the repository root. The panel polls for a completed build and reloads itself into the full dashboard once `dist/canvas-host.cjs` and `dist/webview/app.js` exist. No manual reopen needed.

Background analytics have a two-minute limit in canvas mode. Large histories can
take more than a minute.

## Canvas vs VS Code differences

A few features depend on the local VS Code language model and are not available in canvas mode. They render read-only or greyed out:

- **Skill Finder** (generation and triage)
- **Learning Center** quizzes and resources
- **Context review** in Context Health

Everything driven purely by your on-disk logs — Dashboard, Timeline, Coding Moments, Output, Patterns, Curiosity, Anti-Patterns, Achievements — works the same as in VS Code.

Open with `{ "page": "curiosity" }` to start on the Curiosity page. Omit input to start on Dashboard.

## How it is wired

- `extension.mjs` owns build detection and a single `127.0.0.1` HTTP server, and declares the canvas via `createCanvas` / `joinSession`.
- `dist/canvas-host.cjs` (built from `src/canvas/host.ts`) provides the request handler: the dashboard shell, the asset routes, an SSE channel for parse progress, and the `/rpc` endpoint.
- The dashboard talks to the host through an injected `acquireVsCodeApi` shim, so the webview code is unchanged between VS Code and canvas.

The harness breakdown distinguishes **GitHub Copilot App** (desktop) from **GitHub Copilot CLI** (terminal) using the `remoteSteerable` marker present in app session logs.
