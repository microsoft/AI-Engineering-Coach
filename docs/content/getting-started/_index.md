---
title: "Getting Started"
weight: 10
---

AI Engineer Coach is a VS Code extension that analyzes your AI-assisted coding sessions. It reads local log files from VS Code, GitHub Copilot for Xcode, Claude, Codex, OpenCode, and GitHub Copilot CLI, then presents detailed analytics in an interactive webview panel.

## Requirements

- **VS Code** 1.85 or later (or VS Code Insiders) — harness shown as "Local Agent"
- At least one supported AI coding tool with existing session logs

No API keys, accounts, or external services required for the default local experience. Team Mode is optional: if you enable it, you provide a server URL and developer ID so the extension can send only aggregate numeric stats to a shared backend. If you are hosting the backend, the first bootstrap call creates the admin account and invite codes can be used to add teammates without any external login system.

## Quick Start

1. [Install AI Engineer Coach]({{< ref "getting-started/installation" >}}) by building the `.vsix` from source
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run **AI Engineer Coach: Open Dashboard**
4. The extension scans your local log directories and displays your analytics
5. If your team uses Team Mode, turn it on in settings and keep the sync data limited to aggregated scores, token usage, anti-pattern counts, and trends.
6. If you are the person setting up the Team Mode server, bootstrap it first, then generate invite codes for the rest of the team.

The dashboard opens as a webview panel inside VS Code. Use the sidebar to navigate between views.
