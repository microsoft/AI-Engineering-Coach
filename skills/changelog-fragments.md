---
name: changelog-fragments
description: Write AI Engineer Coach changelog entries as changelog.d fragments; dates come from git when they merge — no versions, no manual stamping.
when_to_use: User asks to "update the changelog", "add release notes", "add a changelog entry", "date the
  changelog", "cut a release", or "bump the version".
---

# Changelog Fragments

There are no versioned releases, release tags, or GitHub Releases: the extension is built from
source, and CI uploads the VSIX of every run as the `vsix` artifact. Changes are grouped by the
date they reached `main`, newest first.

- [`CHANGELOG.md`](../CHANGELOG.md) holds the dated history (`## YYYY-MM-DD`). Don't add new
  entries to it.
- Each pull request adds one fragment, [`changelog.d/<PR number>.md`](../changelog.d/README.md).
- [`scripts/build-changelog.mjs`](../scripts/build-changelog.mjs) merges the fragments into the
  history under the UTC date of the `main` commit that added each file (the merge or squash
  commit). Fragments not on `main` yet go under `## [Unreleased]`. Nothing is committed after
  a merge, so the `main` rulesets need no bypass.

## Writing a fragment

```markdown
### Added

- **Prompt Cache** tab with cache efficiency per session (#412)
```

Use the Keep a Changelog types `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and
`Security`, with every entry under one of them. Write for users: say what changed and why it
matters, end with the pull request or issue number, mark breaking changes with `**Breaking:**`,
and leave out internal refactors and dependency bumps. Name the file after the pull request; use
the branch name until there is a number. Don't rename a fragment after it merges: the new path
gets a new date.

## Where the dates show

- `npm run changelog` prints the dated changelog; `npm run changelog -- --out <file>` writes it.
- `npm run package` packages it as the VSIX changelog, which **AI Engineer Coach: What's New** opens.
  What's New offers it once when a build's newest date is newer than the one the user last saw.

Dates need the history of `origin/main` (or `main`). CI checks out with `fetch-depth: 0`. In a
shallow clone or without a main branch, every fragment shows under `[Unreleased]` with a warning.

## Checks

`npm test` runs [`scripts/changelog.test.mjs`](../scripts/changelog.test.mjs) and
[`scripts/build-changelog.test.mjs`](../scripts/build-changelog.test.mjs): `CHANGELOG.md` must have
valid, unique, newest-first dates, every fragment must parse, and a real git repository checks merge
and squash dates. The packaged-VSIX suite checks that the installed changelog has a dated section.

## Anti-patterns

- Don't change `version` in `package.json`, push `v*` tags, or create GitHub Releases.
- Don't write dates into fragments or add new entries to `CHANGELOG.md`.
- Don't paste `git log` output into a fragment.
