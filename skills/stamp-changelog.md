---
name: stamp-changelog
description: Write AI Engineer Coach changelog entries and date them before merge — CHANGELOG.md is grouped by merge date, not by version.
when_to_use: User asks to "update the changelog", "add release notes", "date the changelog", "stamp the
  changelog", "cut a release", or "bump the version".
---

# Stamp the Changelog

[`CHANGELOG.md`](../CHANGELOG.md) follows [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/),
but groups changes by the date they reached `main` (`## YYYY-MM-DD`, newest first) instead of by
version. There are no versioned releases, release tags, or GitHub Releases: the extension is built
from source, and CI uploads the VSIX of every run as the `vsix` artifact. **AI Engineer Coach:
What's New** shows this file and offers it once when a build has a newer dated section.

## Writing entries

A pull request with a user-visible change adds a bullet under `## [Unreleased]`, in `### Added`,
`### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, or `### Security`, with the pull
request or issue number. Write for users: say what changed and why it matters, mark breaking
changes with `**Breaking:**`, and leave out internal refactors and dependency bumps that don't
affect users. Machines can draft notes; a person curates them.

## Dating them before merge

When the pull request is approved and about to merge, update it from `main` and stamp the entries:

```bash
npm run changelog:stamp                      # today's UTC date
npm run changelog:stamp -- --date 2026-11-21 # or an explicit date
git commit -am "docs: date the changelog entries"
```

The script moves everything under `## [Unreleased]` into `## <date>` and leaves an empty
`## [Unreleased]` on top. When that date already has a section, the entries join it type by type,
so several pull requests merged on the same day share one section. Empty `### Type` headings are
dropped. It changes only `CHANGELOG.md` and does not commit.

If a pull request merged with entries still under `## [Unreleased]`, stamp them in a follow-up
pull request with the date it merged.

## Checks

`npm test` runs [`scripts/changelog.test.mjs`](../scripts/changelog.test.mjs), which requires a
`## [Unreleased]` section and dated sections that are valid `YYYY-MM-DD` dates, each used once,
newest first. The packaged-VSIX suite checks that the installed changelog has a dated section.

## Troubleshooting

- **`Nothing to stamp`** — `## [Unreleased]` has no entries. Add them first, or skip stamping for a
  change users won't notice.
- **`<date> is older than the newest section`** — another pull request already stamped a later
  date. Update from `main` and stamp again without `--date`.
- **`Expected "## YYYY-MM-DD" or "## [Unreleased]"`** — a heading was added by hand in another
  format. Use the script, or fix the heading.

## Anti-patterns

- Don't change `version` in `package.json`, push `v*` tags, or create GitHub Releases.
- Don't write entries straight under a date heading by hand; the merge date isn't known until merge.
- Don't paste `git log` output into the changelog.
