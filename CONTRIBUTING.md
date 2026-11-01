# Contributing to AI Engineer Coach

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## How to Contribute

1. **Fork** the repository and create your branch from `main`.
2. **Install dependencies**: `npm install`
3. **Build**: `npm run build`
4. **Run tests**: `npm test`
5. **Lint**: `npm run lint`
6. If you've added code, add tests that cover your changes.
7. If users will notice the change, describe it under `## [Unreleased]` in
   [`CHANGELOG.md`](CHANGELOG.md). Don't change `version`; see [Releases](#releases).
8. Ensure the test suite passes and linting is clean.
9. Submit a **pull request**.

## Reporting Issues

Please use [GitHub Issues](https://github.com/microsoft/ai-engineer-coach/issues) to report bugs or
request features. Before filing a new issue, please check if one already exists.

## End-to-End Testing

Use Node 22 (the CI version) or a newer supported Node release. Install the locked dependencies
with `npm ci`. The existing database integration tests also require the `sqlite3` command on
your `PATH`. There are three complementary test layers:

| Layer | Command | What it verifies |
| --- | --- | --- |
| Unit and fixture tests | `npm test` | Parsers, rules, calculations, and synthetic-data invariants |
| Browser webview tests | `npm run build` then `npm run test:e2e` | Dashboard interactions with mocked host responses |
| Packaged VS Code tests | `npm run test:vscode` | Installation, activation, workers, real webview messaging, navigation, reload, and empty data |

Before the first browser run, install its browser with `npx playwright install chromium`.
On a Linux machine without a display, install the desktop dependencies with
`npx playwright install-deps chromium`, then run `xvfb-run -a npm run test:vscode`.
Windows and macOS run the same npm command without the virtual display.

### Testing the shipped extension

`npm run test:vscode` compiles the test code, packages the extension through the normal packaging
script, and installs that VSIX into a disposable VS Code installation. It never installs into
your normal editor. To test an already-built artifact without rebuilding it, use:

```sh
npm run test:vscode -- --vsix ai-engineer-coach-<version>.vsix
```

Use the file name that `npm run package` printed.
The runner records the package's SHA-256 hash and checks that the artifact did not change.
It also checks the build stamp: the installed `dist/build-info.json` must match the manifest
version (and `GITHUB_SHA` in CI), the packaged changelog must have a section for that version,
and the dashboard footer and the `runtime.log` activate line must show the same stamp.
CI and releases pass the exact package path this way; publishing happens only after the
browser and desktop suites pass, and the release uses that same VSIX.

By default, desktop tests use the minimum version in `package.json`'s `engines.vscode`.
Use `--vscode-version 1.125.0` to select an explicit compatible version, or
`--vscode-version latest` to check the current stable release. An incompatible pinned version
fails before launching. The [compatibility workflow](.github/workflows/vscode-compatibility.yml)
runs the minimum and latest versions on Linux, Windows, and macOS weekly, on manual dispatch,
and on PRs that change the desktop harness, its fixtures, or the shared E2E action.

The desktop runner uses [ExTester](https://github.com/redhat-developer/vscode-extension-tester).
Its actively tested editor-version window moves with new releases; older versions are
best-effort. Keep the minimum-version tests rather than silently increasing our public engine
requirement to accommodate the runner. Dependency updates use the existing Dependabot workflow.

### Synthetic data and isolation

The checked-in data is [`tests/vscode/data/projects.json`](tests/vscode/data/projects.json):
fictional project names, prompts, source code, tests, model IDs, and a seven-day activity schedule.
It is entirely synthetic, not sampled or anonymized from anyone's personal logs. Three projects
cover TypeScript (`inventory-api`), Python (`sensor-pipeline`), and Go (`release-worker`).

[`tests/vscode/fixtures.ts`](tests/vscode/fixtures.ts) materializes those definitions into raw
`chatSessions` and `chatEditingSessions` JSON in the platform's normal discovery layout,
entirely inside a fresh temporary home. Initially there are **21 sessions, 63 requests, 315 added
lines and 294 net lines** across seven active days, including weekday, weekend and evening activity.
Each session records file creation, a one-line correction, and test creation; the same code also
appears in responses to exercise edit/code-block deduplication. The reload test adds one session,
then verifies **22 sessions, 66 requests and 330 added lines**, including a second reload without
duplicates. The empty-data scenario starts a separate process with no session sources.

The data is varied but deterministic rather than randomly changing on every build. The most
recent activity day is the day before the run, with earlier days and local hours taken from the
schedule, so charts remain populated. The unit suite checks exact code totals, all seven heatmap
days, overlapping Timeline sessions, and the three project summaries through the real parser
and analyzers. Desktop tests do not replace the parser, workers, VS Code API, or message bridge.
They also check that input log files remain byte-for-byte unchanged except for the test's
explicit addition. Personal home, AppData, Copilot data, temporary directories, extension
directories, and VS Code profiles are isolated; no sign-in or live model call is required.

Only editor/driver download archives are cached under `.vscode-test/cache`. Each invocation
creates fresh profiles, fixtures, and application caches and removes them after the run.
Diagnostics remain under `test-results/vscode`, including runtime and driver logs, failure
screenshots, and a package-hash summary. Browser traces, screenshots, and the HTML report
are stored separately under `test-results/browser` and `test-results/browser-report`.
GitHub Actions uploads these diagnostics even when a test fails.

The pipeline logs the generated counts and includes a **Synthetic test data** section in its
summary and gallery. Downloaded artifacts include each suite's `dataset.json`, the checked-in
definitions under `fixtures/projects.json`, the actual initial input copies under
`fixtures/initial`, and the planned additional files under `fixtures/reload`. These are generated
test inputs, not user logs; the reload files are kept separate from the initial dataset.

Successful milestones also capture real VS Code screenshots: dashboard totals and activity, Timeline
session details, nonzero Output by project, Patterns Work Hours and Projects, reload, reopening,
and the expected empty-data state. In a GitHub Actions
run, open the **Summary** and follow **Download screenshots and test diagnostics**. Extract the
artifact, then open `vscode/<run>/gallery.html`; its images are embedded, so it works offline.
The gallery includes captions, suite outcomes, dataset counts, the editor target, and the tested VSIX hash.
Individual PNGs are in each suite's `snapshots` directory. Locally, the same gallery is under
`test-results/vscode/<run>/gallery.html`.

These screenshots document the synthetic-data run, not pixel-comparison baselines. The capture
helper waits for chart pixels to settle so it does not show an in-progress animation. Captures
are preserved even if a later assertion fails; the report still marks that suite as failed.
Existing automatic failure screenshots remain separate.

### Update check tests

Tests never contact GitHub. Unit tests inject `fetch` and fail if anything calls the global one.
The desktop `update.spec.ts` suite runs against a loopback stand-in for GitHub Releases
([`tests/vscode/update-server.ts`](tests/vscode/update-server.ts)): the runner packages the same
sources as the next patch version (with `vsce package <version> --no-update-package-json`, so
`package.json` is untouched, then rebuilds `dist` with the original stamp) and points the installed
extension at the server through the test-only `AI_ENGINEER_COACH_UPDATE_TEST_ORIGIN` variable. The
extension honors that variable only for a loopback origin with an explicit port. The suite checks
that a checksum mismatch installs nothing, then updates through **Update** and **Reload Window** and
expects the new version and What's New after the reload. Every other suite turns automatic checks
off and points the variable at a closed loopback port.

### Maintaining regression coverage

Add the regression test in the same PR as the feature or fix. Prefer the smallest layer that
can reproduce the behavior: parser/calculation changes belong in Vitest, dashboard interaction
changes in Playwright, and packaging or host/webview boundary changes in the desktop suite.
Do not duplicate every browser scenario in VS Code.

Add lowercase, hyphenated `*.spec.ts` files directly under
[`tests/vscode/suite`](tests/vscode/suite). The runner discovers new source suites automatically;
each file gets a separate process, profile, and baseline synthetic data. `empty.spec.ts` is the
no-data exception. Reuse the [`Dashboard`](tests/vscode/dashboard.ts) helper and small synthetic
fixtures. Keep selectors in the helper, wait for observable readiness instead of fixed sleeps,
and assert exact results.
After a meaningful assertion, use `await dashboard.snapshot('01-feature', 'What the screenshot demonstrates')`
to add a named milestone to the gallery. Use a unique lowercase, hyphenated name within each suite.
The desktop suite is sequential, has no automatic test retries, and rejects focused, skipped, or
empty test runs. Inherited `MOCHA_GREP` and `MOCHA_INVERT` filters are removed so a nonempty subset
cannot pass as the full suite. Reload replaces the webview's frames, so the dashboard helper waits
for a different document and reacquires detached frames within a single deadline, including
ExTester's wrapped stale-outer-frame error. It does not repeat the reload command or suppress
unexpected driver failures.
Its TypeScript and fixture tests are included in `npm run check`.

Use the shared [E2E action](.github/actions/e2e/action.yml) for pipeline changes so PR, release,
and compatibility runs do not acquire different setup procedures. Investigate failures using
the saved screenshots and logs; do not bypass the release gate or disable an operating-system
security feature globally to get a green run.

## Releases

Versions are `major.minor.patch` only, with even minor versions for stable releases and odd minor
versions for pre-releases. Feature pull requests add their notes under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md) and leave `version` alone. A maintainer cuts a release with
`npm run release:prepare` in a release pull request, then pushes the `v<version>` tag, which
publishes the GitHub Release with the VSIX, its SHA-256 checksum, and the notes. See
[`skills/cut-release.md`](skills/cut-release.md) for the steps.

Every build is stamped with its version, commit, and build time, so branch builds that share a
version can still be told apart. The bottom of the dashboard sidebar shows the stamp, marked
**dev** unless it's a tagged release, and so do the `[extension] activate` line in
`~/.copilot-analytics-cache/runtime.log` and `dist/build-info.json` in the installed extension.
`code --install-extension` refuses to replace a newer installed version with an older one; add
`--force` to go back to an older build.

## Security

If you discover a security vulnerability, please follow the instructions in [SECURITY.md](SECURITY.md).
**Do not** report security vulnerabilities through public GitHub issues.

## Creating Rules and Metrics

Detection rules and metrics are the primary extensibility surface of AI Engineer Coach. Each one is
a self-contained markdown file with YAML frontmatter and a small DSL — no code changes required to
ship a new one. Built-in rules live in [`src/core/rules/`](src/core/rules/) and metrics in
[`src/core/metrics/`](src/core/metrics/).

See [docs/AUTHORING_RULES.md](docs/AUTHORING_RULES.md) for the full authoring guide: file format,
annotated rule and metric examples, the local testing workflow, and links to the DSL reference.
