# Changelog

All notable changes to AI Engineer Coach are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), but changes are
grouped by the date they reached `main`, newest first, instead of by release: the extension is
built from source and has no versioned releases. Pull requests add entries under
`## [Unreleased]`, and `npm run changelog:stamp` moves them under the merge date (see
[skills/stamp-changelog.md](skills/stamp-changelog.md)).

## [Unreleased]

### Added

- The bottom of the dashboard sidebar shows which build is running: its version, commit, branch,
  and build time, with `-dirty` when it was built from uncommitted changes. The activity-bar
  view, the `[extension] activate` line in `runtime.log`, and `dist/build-info.json` in the
  installed extension carry the same stamp
- **AI Engineer Coach: What's New** opens this changelog, also from a link in the activity-bar
  view. The first time a build with newer dated changes runs, a notification offers it; turn it
  off with the `aiEngineerCoach.showReleaseNotesAfterUpdate` setting

## 2026-11-01

### Fixed

- Fix VS Code re-parsing every log on each launch (#320): the parse worker is stopped as soon as it
  reports its result, which also killed the parse-cache write still in progress, so the cache was
  never saved. The worker now waits (up to 30 seconds) for the write to finish first, and the
  cache files are replaced atomically (temp file + rename), so an interrupted write never leaves a
  broken cache. Every load now returns sessions and workspaces in one canonical order, so a
  launch from the cache shows the same anti-pattern examples and rankings as a full parse. Unit
  tests now run against a temporary home directory and no longer delete the developer's real
  `~/.copilot-analytics-cache`

## 2026-10-30

### Changed

- Use GitHub Copilot's Auto model for all AI features instead of hard-coded model families. In VS Code,
  the Why? buttons, Skill Finder, and Level Up are hidden and the context review is disabled while
  GitHub Copilot isn't available; they come back on sign-in without reopening the dashboard (#301)
- The VSIX no longer ships development-only files (#307)

### Fixed

- Fix the anti-pattern **Why?** explanation getting stuck on "Asking AI for an explanation…" (#278):
  every explanation state now renders through Preact, empty or failed responses show an error,
  and timeouts, denied access, and quota errors fail fast instead of retrying for minutes
- Fix canvas mode intermittently loading with an empty content pane or a stuck
  loading screen (#269): the canvas bridge now subscribes to host events only
  after the dashboard signals it is listening, so the replayed `dataReady` is
  never dropped

## 2026-10-21

### Fixed

- Fix Coding Moments image counting and loading across VS Code, Copilot CLI/App,
  Claude (including subagents), Codex, OpenCode JSON/SQLite, and Xcode (#292);
  extract images off-thread with bounded local reads and session-scoped caching
- Skill Finder finds the community catalog again (#294)

## 2026-10-16

### Added

- **Curiosity** page with question analytics and **Prompt Quality** checks (#284, #287)

## 2026-08-26

### Added

- **GitHub App** productivity dashboard and issue-level AI credit estimates (#241, #242)
- Net new AI lines of code on the Output page (#131)

### Fixed

- Output no longer inflates lines of code from VS Code edit-session payloads (#131)
- Delivery funnel session and pull request counts (#245)

## 2026-08-21

### Fixed

- Harness-injected context such as `AGENTS.md` instructions no longer counts as user prompts
  in workflow and skill analysis (#154)
- Navigation badges announce changes to screen readers (#190)

## 2026-07-03

### Fixed

- Sync no longer takes minutes on large JSONL logs (#161)

## 2026-06-24

### Added

- Live parse telemetry strip and a dismissible "skipped history" banner on the loading
  screen (#121)

### Fixed

- Fix parse-worker out-of-memory on large log sets (#106): parsing now runs in a
  forked child process with a capped heap and streams results back in per-session
  chunks using ack-window backpressure to avoid native IPC buffer growth

## 2026-06-20

### Added

- **Coding Moments** gallery of the images in your sessions, with a time-range filter (#6, #118)
- Context Files view for `skills/` and `AGENTS.md` (#90)

### Fixed

- Learning Center quizzes reset the selected answer for each new question (#137)

## 2026-06-19

### Added

- The dashboard also runs as a canvas in the GitHub Copilot app, and Copilot app sessions are
  reported separately from Copilot CLI sessions (#139)

### Security

- Bound log and cache reads, gate project rules on Workspace Trust, and redact secrets before
  language model calls (#120)

## 2026-06-02

### Added

- Session discovery for WSL, Remote SSH, and dev containers (`.vscode-server`) (#63)

### Security

- Harden the webview message boundary, path handling, and log parsers (#94)

## 2026-05-30

### Fixed

- Workspace roots for Claude and OpenCode sessions (#86)
- Rule calibration no longer depends on the system locale (#85)

## 2026-05-27

### Added

- `@aicoach` chat participant and language model tools that answer questions about your
  usage data (#16)
- More complete Codex coverage, including the skills each session used (#51, #67)

### Fixed

- The dashboard loads when only Claude, Codex, or OpenCode logs exist (#53)

## 2026-05-25

### Added

- **AI Engineer Coach: Export Summary** saves the dashboard summary as Markdown and JSON (#55)

## 2026-05-24

### Security

- Escape harness names in the sidebar to prevent cross-site scripting (#38)
- Replace the webview's `unsafe-inline` style policy with an external stylesheet (#39)

## 2026-05-21

### Fixed

- `npm run package` failure (#36)

## 2026-05-17

### Added

- Redesigned share card with social sharing buttons and a streak badge (#11)

## 2026-05-15

### Changed

- Skills read from `SKILL.md` files count toward Claude skill usage, and agent mode metrics
  are more accurate (#10)

## 2026-05-08

### Changed

- Claude sessions are reported under a single "Claude" harness, and consumption analytics add
  a per-harness daily token breakdown (#5)

## 2026-05-06

### Added

- First version (0.1.0): dashboard with timeline, output, and consumption views
- Anti-pattern detection with 40+ built-in rules
- Skill Finder and context quality analysis
- Activity patterns (projects, work hours)

[Unreleased]: https://github.com/microsoft/AI-Engineering-Coach/commits/main
