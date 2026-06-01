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

The `--no-dependencies` flag is required because runtime dependencies are bundled into
`dist/extension.js` by esbuild; `node_modules/` is excluded via `.vscodeignore`.

## Output

- `ai-engineer-coach-<version>.vsix` at the repo root.
- `dist/extension.js` (the bundled entry point).

Install locally to smoke-test:

```bash
code --install-extension ai-engineer-coach-*.vsix
```

Then **AI Engineer Coach: Open Dashboard** from the command palette.

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

## Versioning

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, then commit before packaging so
the `.vsix` filename matches the released tag. Do not amend the commit after building — it's
fine to ship a `.vsix` whose embedded git SHA differs from the tag.

## Anti-patterns

- Don't run `vsce package` directly — you'll ship `README.md` (the GitHub one with screenshots
  and badges) instead of `README.extension.md`.
- Don't commit the `.vsix`; it's listed in `.gitignore` style via convention. Attach it to a
  GitHub Release instead.
- Don't disable `--no-dependencies` "to be safe" — it will bloat the package past the 5 MB
  budget and double-ship code that's already bundled.
