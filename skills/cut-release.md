---
name: cut-release
description: Prepare and publish an AI Engineer Coach release — version bump, release notes, tag, and GitHub Release.
when_to_use: User asks to "cut a release", "bump the version", "prepare release notes", "release 0.2.0",
  "publish a new VSIX", or asks which version comes next.
---

# Cut a Release

Releases are cut from [`CHANGELOG.md`](../CHANGELOG.md), which follows
[Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/). A release pull request moves the
`## [Unreleased]` notes into a dated section and bumps the version. Pushing the `v<version>` tag
then runs [`release.yml`](../.github/workflows/release.yml), which builds, tests, and publishes the
GitHub Release. Nothing is published to the VS Code Marketplace.

## Version policy

- `major.minor.patch` only. The Marketplace and `vsce publish` reject pre-release suffixes such as
  `-beta`, and the commit SHA belongs in the build stamp, not the version.
- Stay on `0.x` until the extension is published to the Marketplace. In `0.x`, bump the **minor**
  version for new features or behavior changes (including breaking ones) and the **patch** version
  for fix-only releases.
- Even minor versions are stable releases (`0.2.x`, `0.4.x`). Odd minor versions are pre-releases
  (`0.3.x`), the VS Code convention: `release.yml` marks them as GitHub pre-releases, so they never
  become the latest release.
- Feature pull requests never change `version`; they add notes under `## [Unreleased]`.

## Writing notes

A pull request with a user-visible change adds a bullet under `## [Unreleased]`, in `### Added`,
`### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, or `### Security`, with the pull
request or issue number. Write for users: say what changed and why it matters, mark breaking
changes with `**Breaking:**`, and leave out internal refactors and dependency bumps that don't
affect users. Machines can draft notes; a person curates them.

## Steps

1. Branch from an up-to-date `main` with a clean working tree:

   ```bash
   git fetch origin
   git switch -c release/v0.2.0 origin/main
   ```

2. Check `## [Unreleased]` against everything merged since the last release. Use
   `git log --first-parent --oneline v<previous>..HEAD` (the whole history before the first tag)
   or the pull requests merged since then, and add any user-visible change that is missing.

3. Bump the version and roll the notes:

   ```bash
   npm run release:prepare -- minor   # or patch, major, or an explicit version such as 0.2.0
   ```

   It refuses to run with uncommitted changes, an empty `## [Unreleased]`, or a version that is not
   greater than the current one. It updates `package.json`, `package-lock.json`, and
   `CHANGELOG.md`, including the link references at the bottom, and does not commit or tag. Pass
   `--date YYYY-MM-DD` to set the release date.

4. Read the notes exactly as the GitHub Release will show them, then commit and open a pull
   request:

   ```bash
   npm run release:notes -- 0.2.0
   git commit -am "chore(release): v0.2.0"
   ```

   CI packages `ai-engineer-coach-0.2.0.vsix` and runs the browser and packaged-VSIX suites. The
   packaged suite checks that the installed changelog has a section for the packaged version.

5. After the pull request merges, tag the merge commit on `main` and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

   The tag push runs `release.yml`. It checks that the tag matches `package.json`, extracts the
   notes with `release:notes`, runs `npm run check`, packages and tests the VSIX, and publishes the
   GitHub Release with:

   - `ai-engineer-coach-<version>.vsix`
   - `ai-engineer-coach-<version>.vsix.sha256` (`sha256sum` format)
   - the CHANGELOG section as the release body, followed by GitHub's generated list of pull
     requests (grouped by [`.github/release.yml`](../.github/release.yml))

   A build of the tag shows no **dev** badge in the dashboard.

## After the first release

`README.md` and `docs/content/getting-started/installation.md` still say there is no Releases
page. Add the download from GitHub Releases next to building from source, with checksum
verification: `sha256sum -c ai-engineer-coach-<version>.vsix.sha256`, or compare
`Get-FileHash ai-engineer-coach-<version>.vsix` on Windows.

## Dry run

Run **Release** from the Actions tab (`workflow_dispatch`) on a branch to exercise the whole
workflow without publishing. It uploads the VSIX and its checksum as an artifact and shows the
release notes in the run summary.

## Troubleshooting

- **`Nothing to release`** — `## [Unreleased]` has no entries. Add the notes first.
- **`Tag version … does not match package.json version`** — tag the commit that contains the
  merged release pull request.
- **`CHANGELOG.md has no "## [x.y.z]" section`** in `release.yml` — the version was bumped without
  `release:prepare`. Add the section in a pull request, then delete and recreate the unpublished
  tag.

## Anti-patterns

- Don't create the release in the GitHub UI, and don't push tags from a workflow using
  `GITHUB_TOKEN`: tags pushed with `GITHUB_TOKEN` don't start `release.yml`.
- Don't bump `version` in feature pull requests, and don't use `vsce package <version>`,
  `vsce publish minor`, or plain `npm version`: they skip the changelog, `npm version` rewrites
  the whole of `package.json`, and in a git repository both create a commit and tag.
- Don't move or delete a published tag. Fix forward with a patch release.
- Don't paste `git log` output into the changelog.
