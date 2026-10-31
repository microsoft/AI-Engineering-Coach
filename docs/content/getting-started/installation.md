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

To go back to an older build after installing a newer version, add `--force`; `code --install-extension` refuses to downgrade without it.

## Which Build Is Installed?

Builds from different branches share the version in `package.json`, so every build is stamped with its version, commit, and build time:

- The bottom of the dashboard sidebar shows the stamp. It's marked **dev** unless the build is a tagged release, and the commit ends in `-dirty` when the build included uncommitted changes. Hover over it for the branch and build time.
- The `[extension] activate` line in `~/.copilot-analytics-cache/runtime.log` records `version=… commit=… dirty=… dev=… branch=… builtAt=…`.
- `dist/build-info.json` in the installed extension's folder holds the same values.

## What's New

Run **AI Engineer Coach: What's New** from the Command Palette, or select **What's new** in the activity-bar view, to open the release notes bundled with the extension. The first time a newer version runs, a notification offers them once. To turn the notification off, set `aiEngineerCoach.showReleaseNotesAfterUpdate` to `false`.

## Updates

Release builds, the ones installed from a [GitHub Release](https://github.com/microsoft/AI-Engineering-Coach/releases), check about once a day whether a newer release is out. Builds marked **dev** never check on their own. When a newer version is available, a notification offers it once, and the bottom of the dashboard sidebar and the activity-bar view show **v0.4.0 available** until you update or choose **Skip This Version**. Run **AI Engineer Coach: Check for Updates** to check at any time, from any build.

**Update** downloads the release's `.vsix`, checks its size and SHA-256 checksum against the release, installs it with VS Code's extension installer, and then offers **Reload Window**. Nothing is downloaded, installed, or reloaded until you click. One-click updates are offered only for releases that GitHub marks as immutable and whose package the release workflow uploaded, and only in local windows; for any other release, and in remote windows (WSL, Remote-SSH, Dev Containers, Codespaces), **Open Release Page** takes you to the download instead.

What the update check sends:

- At most one request a day to `api.github.com` (`GET /repos/microsoft/AI-Engineering-Coach/releases/latest`), with a fixed `User-Agent` and no version, machine, account, or usage data. GitHub sees your IP address, as with any download.
- Only after you click **Update**: a download from `github.com`, redirected to `release-assets.githubusercontent.com`. Like a manual download, it counts toward the release's public download count.

The check runs only after the extension activates, uses VS Code's proxy settings, and stays silent while you're offline or GitHub is unreachable; it tries again later. A new release is announced only once VS Code's `extensions.autoUpdateDelay` has passed since it was published (12 hours by default).

To turn automatic checks off, set `aiEngineerCoach.updates.autoCheck` to `false`, or turn off VS Code's `extensions.autoCheckUpdates`. Behind a firewall, allow `api.github.com`, `github.com`, and `release-assets.githubusercontent.com`, or turn the check off.

To check an immutable release yourself, use the GitHub CLI: `gh release verify-asset vX.Y.Z ai-engineer-coach-X.Y.Z.vsix -R microsoft/AI-Engineering-Coach`.

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

AI Engineer Coach works out of the box with sensible defaults. Optional settings under `aiEngineerCoach.*` in VS Code settings:

- `aiEngineerCoach.showReleaseNotesAfterUpdate`: offer the release notes after an update (see [What's New](#whats-new)).
- `aiEngineerCoach.updates.autoCheck`: check GitHub Releases for a newer version about once a day (see [Updates](#updates)).
