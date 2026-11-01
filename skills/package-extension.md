---
name: package-extension
description: Build the AI Engineer Coach VS Code extension into an installable .vsix.
when_to_use: User asks to "package the extension", "build a vsix", "make a release artifact",
  or wants to test a local build in VS Code.
---

# Package Extension

Produces `ai-engineer-coach-<version>.vsix` at the repo root, suitable for
`code --install-extension`.

## Prerequisites

- Node.js (matches `engines.vscode` of `^1.120.0` from `package.json`; any recent LTS works).
- `npm ci` to install dependencies — do **not** use `npm install` for a packaging build, since
  the lockfile is the source of truth.
- `vsce` is invoked through `npx`; no global install needed.

## Steps

```bash
npm ci
npm run package
```

`npm run package` runs [`scripts/package-readme-swap.mjs`](../scripts/package-readme-swap.mjs),
which:

1. Renames the GitHub-facing `README.md` to `README.github.md`.
2. Copies `README.extension.md` into `README.md` (this is the README the Marketplace shows).
3. Runs `vsce package --allow-missing-repository --no-dependencies`, which itself triggers the
   `vscode:prepublish` script → `npm run build` → `node esbuild.mjs` to bundle into
   `dist/extension.js`.
4. Restores the original `README.md` regardless of build success.

Before step 1 it computes the build stamp and hands it to the nested build through the
`AIC_BUILD_INFO` environment variable, so the temporary README swap doesn't mark the package as
built from uncommitted changes.

The `--no-dependencies` flag is required because runtime dependencies are bundled into
`dist/extension.js` by esbuild; `node_modules/` is excluded via `.vscodeignore`.

## Output

- `ai-engineer-coach-<version>.vsix` at the repo root.
- `dist/extension.js` (the bundled entry point).
- `dist/build-info.json`, the build stamp (see [Versioning and build stamps](#versioning-and-build-stamps)).
- `CHANGELOG.md`, which vsce packages as `extension/changelog.md`: VS Code's **Changelog** tab and
  **AI Engineer Coach: What's New** show it.

Install locally to smoke-test:

```bash
code --install-extension ai-engineer-coach-*.vsix
```

Then **AI Engineer Coach: Open Dashboard** from the command palette.

`code --install-extension` refuses to replace an installed extension with an older version. Add
`--force` when you go back to an older build, for example one from a branch that predates a
version bump.

## Size budgets

[`scripts/check-bundle-size.mjs`](../scripts/check-bundle-size.mjs) enforces:

- `dist/extension.js` ≤ 2 MB
- Any `*.vsix` at the repo root ≤ 5 MB

Run it after packaging:

```bash
npm run check-size
```

## Troubleshooting

- **`README.github.md` left behind** — the swap script aborted before its `finally` could rename
  the file back. Manually `mv README.github.md README.md` before re-running.
- **`vsce: command not found`** — `npx vsce` should resolve through `node_modules/.bin/`; run
  `npm ci` if it doesn't, since `vsce` is a transitive dev dependency.
- **`Missing publisher name`** — the `publisher` field in `package.json` is required; do not
  remove it when bumping the version.
- **Bundle over budget** — usually a new dependency that wasn't tree-shaken. Check
  `npm run analyze:data-inventory` and the esbuild output, then either drop the dep or split it
  into a dynamic import.
- **Spellcheck or lint fails first** — `npm run check` (typecheck + lint + spellcheck + knip +
  test) is what CI runs; fix those before packaging if the goal is a release.

## Versioning and build stamps

Don't change `version` when packaging. It changes only in a release pull request made with
`npm run release:prepare` (see [cut-release](cut-release.md)), so every branch packages the same
file name. Each build is identified by its stamp instead:

- [`scripts/build-info.mjs`](../scripts/build-info.mjs) records `version`, the short `commit`,
  `dirty` (uncommitted changes to tracked files), the `branch` of a dev build, `builtAt`, and
  `dev`, which is false only for a clean build of the `v<version>` tag.
- `esbuild.mjs` gives every bundle the stamp as the global `__AIC_BUILD_INFO__` (read through
  [`src/core/build-info.ts`](../src/core/build-info.ts)) and writes `dist/build-info.json`. A
  plugin injects it as a virtual module, so `npm run watch` restamps after each change and brings
  every bundle and `dist/build-info.json` up to the same stamp.

To find out which build is installed, look at the bottom of the dashboard sidebar or the
activity-bar view, the `[extension] activate` line in `~/.copilot-analytics-cache/runtime.log`
(`version=… commit=… dirty=… dev=… branch=… builtAt=…`), or `dist/build-info.json` in the
installed extension's folder.

## Anti-patterns

- Don't run `vsce package` directly — you'll ship `README.md` (the GitHub one with screenshots
  and badges) instead of `README.extension.md`.
- Don't commit the `.vsix`; it's listed in `.gitignore` style via convention. Attach it to a
  GitHub Release instead.
- Don't disable `--no-dependencies` "to be safe" — it will bloat the package past the 5 MB
  budget and double-ship code that's already bundled.
- Don't pass a version to vsce (`vsce package 0.2.0`, `vsce package minor`) to tell builds apart:
  it rewrites `package.json` and, in a git repository, creates a version commit and tag. The build
  stamp already identifies every build.
- Don't put `-beta`, `-dev`, or a commit SHA in `version`: the Marketplace accepts only
  `major.minor.patch`.
