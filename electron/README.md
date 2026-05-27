# AI Engineer Coach — Desktop App (Electron port)

A standalone macOS desktop port of [microsoft/AI-Engineering-Coach](https://github.com/microsoft/AI-Engineering-Coach), wrapping the same analyzer + dashboard in an Electron shell so it runs without VS Code.

## Why this exists

The upstream project is a VS Code extension. That's the right home for it if you live in VS Code. But if your day-to-day is Claude Code CLI, Codex CLI, OpenCode, or any other terminal-based AI coding tool — you still have rich session logs on disk, and you still want the coaching dashboard. This port unwraps the dashboard from the VS Code panel and runs it as a normal `.app`.

**Nothing is sent off your machine.** All log parsing and analytics happen locally, same as the upstream.

## Status

This is a **proof-of-concept**, not a polished product. See [`ROADMAP.md`](./ROADMAP.md) for the honest current state — what works, what doesn't, what would need to be built for a v1.0 release.

What works today:
- App launches as a sandboxed Electron window with proper security defaults
- Parses Claude Code / Codex / OpenCode / VS Code Copilot / Xcode session logs
- Renders the full dashboard: Dashboard, Timeline, Output, Patterns, Anti-Patterns, Context Health, Skill Finder, Level Up, Coding Moments
- Built-in i18n: English / Русский / Українська (switchable from View → Language)
- Persists state (model budgets, language, webview state) to `~/Library/Application Support/AI Engineer Coach/`

What's intentionally stubbed (requires VS Code APIs we don't have):
- Skill generation, learning quizzes, code comparison — anything that calls `vscode.lm` (Language Model API)
- GitHub SDLC sync — needs `vscode.authentication.getSession('github')`

These features show a clear "not available in desktop build" message rather than crashing.

## Building from source

```bash
# Prerequisites: Node 22+, npm, macOS arm64
git clone https://github.com/hii24/ai-coach-desktop.git
cd ai-coach-desktop
npm install

# Dev launch (rebuilds + opens with devtools)
npm run start:electron

# Package an unsigned .app to out/mac-arm64/
npm run package:app
```

The `.app` is unsigned — on first launch macOS will warn about an unidentified developer. Right-click → Open to bypass Gatekeeper, or sign with your own Apple Developer ID by setting `identity` in `electron-builder.yml`.

## Architecture

```
electron/
├── main.ts              # Electron host: window, IPC, menu, fork shim
├── preload.ts           # contextBridge bridge (acquireVsCodeApi + i18n)
├── index.html           # webview shell (CSP, sidebar, drag region)
├── vscode-stub.ts       # minimal `vscode` API shim so panel-rpc.ts can be reused as-is
├── i18n.ts              # i18next setup + IPC for language switching
├── locales/{en,ru,uk}.json
├── esbuild-electron.mjs # bundler (main + preload + copies dist/webview)
├── ROADMAP.md
└── README.md            # this file
```

The core analyzer (`src/core/`) and webview (`src/webview/`) are reused from upstream **unmodified**. The Electron port lives entirely in `electron/`. This makes upstream sync via `git merge upstream/main` straightforward — only the `electron/` tree and a few `package.json` script entries need conflict resolution.

## Attribution

This is a fork of [microsoft/AI-Engineering-Coach](https://github.com/microsoft/AI-Engineering-Coach), maintained by Microsoft employees Sanjay Singh, Joy Distelbrink, Tamas Boncz, and Aymen Furter. **All credit for the analyzer logic, rule engine, and dashboard UI goes to the upstream authors.**

Original project license: MIT (Copyright © Microsoft Corporation). See [`LICENSE`](../LICENSE).
The Electron port code in `electron/` is also MIT-licensed and contributed back to the same license.

If you want VS Code analytics and you're a VS Code user, install [the upstream extension](https://github.com/microsoft/AI-Engineering-Coach) directly — that's the canonical version.

## Contributing

PRs welcome. Before submitting:
- Run `npm run start:electron` and confirm the dashboard loads against your real `~/.claude/projects/` (or other harness) data
- Check the relevant section of `ROADMAP.md` to see if your fix is already known
- For changes that touch `src/`, please open the equivalent PR upstream first — this fork should stay as thin a layer as possible
