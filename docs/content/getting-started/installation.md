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

Every build has the same version, so to replace an installed build with a newer one, add `--force`; without it, `code --install-extension` reports the extension as already installed.

## Which Build Is Installed?

Builds share the version in `package.json`, so every build is stamped with its version, commit, branch, and build time:

- The bottom of the dashboard sidebar shows the stamp. The commit ends in `-dirty` when the build included uncommitted changes. Hover over it for the branch and build time.
- The `[extension] activate` line in `~/.copilot-analytics-cache/runtime.log` records `version=… commit=… dirty=… branch=… builtAt=…`.
- `dist/build-info.json` in the installed extension's folder holds the same values.

## What's New

Run **AI Engineer Coach: What's New** from the Command Palette, or select **What's new** in the activity-bar view, to open the changelog bundled with the extension. It groups changes by the date they were merged, newest first. The first time a build with newer dated changes runs, a notification offers it once. To turn the notification off, set `aiEngineerCoach.showReleaseNotesAfterUpdate` to `false`.

## Development

To run the extension in development mode instead, use `npm run build` and press `F5` in VS Code to launch the Extension Development Host.

## Opening the Dashboard

After installation, open the Command Palette and run:

```
AI Engineer Coach: Open Dashboard
```

You can also click the AI Engineer Coach icon in the Activity Bar (sidebar) if it appears there.

Session parsing and analytics run in separate background processes. One progress screen stays until both finish, and then all pages open. If analytics fail, the dashboard shows the error. Empty session folders without an events file do not count as skipped files.

## Configuration

AI Engineer Coach works out of the box with sensible defaults. Optional settings are available under `aiEngineerCoach.*` in VS Code settings to control cache behavior, date ranges, and workspace filtering.
