---
title: "Installation"
weight: 10
description: "Build and install the extension from source"
---

# Installation

The extension is not yet published on the VS Code Marketplace. Install it by building a `.vsix` package from source.

## Package from Source

```bash
git clone https://github.com/microsoft/ai-engineering-coach.git
cd ai-engineering-coach
npm install
npm run package
```

This produces a `.vsix` file in the project root.

## Install the .vsix

From the command line:

```bash
code --install-extension ai-engineer-coach-*.vsix
```

Or open the Extensions panel in VS Code, click the `...` menu, choose **Install from VSIX...**, and select the file.

## Development

To run the extension in development mode instead, use `npm run build` and press `F5` in VS Code to launch the Extension Development Host.

## Opening the Dashboard

After installation, open the Command Palette and run:

```
AI Engineer Coach: Open Dashboard
```

You can also click the AI Engineer Coach icon in the Activity Bar (sidebar) if it appears there.

## Configuration

AI Engineer Coach works out of the box with sensible defaults. Optional settings are available under `aiEngineerCoach.*` in VS Code settings to control cache behavior, date ranges, and workspace filtering.

By default, Claude session discovery scans `CLAUDE_CONFIG_DIR` and `~/.claude`. To scan only specific Claude profiles, add config roots to `aiEngineerCoach.claudeConfigDirs`:

```json
{
  "aiEngineerCoach.claudeConfigDirs": ["~/.claude-home", "~/.claude-work"]
}
```

When this setting is non-empty, it replaces automatic Claude discovery.
