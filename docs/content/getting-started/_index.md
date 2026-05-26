---
title: "Getting Started"
weight: 10
---

AI Engineer Coach is a VS Code extension that analyzes your AI-assisted coding sessions. It reads local log files from VS Code, GitHub Copilot for Xcode, Claude, Codex, OpenCode, and GitHub Copilot CLI, then presents detailed analytics in an interactive webview panel.

## Requirements

- **VS Code** 1.85 or later (or VS Code Insiders) — harness shown as "Local Agent"
- At least one supported AI coding tool with existing session logs

No API keys, accounts, or external services required for the default local experience. Team Mode is optional: if you enable it, the extension exports privacy-safe snapshots locally after analysis finishes and lets you import teammate snapshots on demand inside VS Code.

## Quick Start

1. [Install AI Engineer Coach]({{< ref "getting-started/installation" >}}) by building the `.vsix` from source
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run **AI Engineer Coach: Open Dashboard**
4. The extension scans your local log directories and displays your analytics
5. If your team uses Team Mode, turn it on in settings and use the Team Dashboard to export or import privacy-safe snapshots.
6. Share the exported snapshot files with teammates however your team prefers, then import them locally in VS Code.

The dashboard opens as a webview panel inside VS Code. Use the sidebar to navigate between views.
