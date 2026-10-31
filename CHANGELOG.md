# Changelog

All notable changes to AI Engineer Coach are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions are `major.minor.patch` only: even minor versions are stable releases and odd
minor versions are pre-releases.

## [Unreleased]

### Added

- The bottom of the dashboard sidebar shows which build is running: its version, commit and
  build time, marked **dev** unless it is a tagged release and `-dirty` when it was built
  from uncommitted changes. The activity-bar view, the `[extension] activate` line in
  `runtime.log`, and `dist/build-info.json` in the installed extension carry the same stamp
- **AI Engineer Coach: What's New** opens these release notes, also from a link in the
  activity-bar view. The first time a newer version runs, a notification offers them; turn
  it off with the `aiEngineerCoach.showReleaseNotesAfterUpdate` setting
- Release builds check GitHub Releases about once a day and offer a newer version once, at the
  bottom of the dashboard sidebar and in the activity-bar view too. **Update** downloads the VSIX,
  checks its SHA-256 checksum against the release, installs it, and offers **Reload Window**;
  nothing installs without a click. Remote windows open the release page instead.
  **AI Engineer Coach: Check for Updates** checks on demand, and the
  `aiEngineerCoach.updates.autoCheck` setting turns automatic checks off
- GitHub Releases take their notes from this changelog and attach a SHA-256 checksum
  next to the VSIX
- **Curiosity** page with question analytics and **Prompt Quality** checks (#284, #287)
- **GitHub App** productivity dashboard and issue-level AI credit estimates (#241, #242)
- The dashboard also runs as a canvas in the GitHub Copilot app, and Copilot app sessions are
  reported separately from Copilot CLI sessions (#139)
- `@aicoach` chat participant and language model tools that answer questions about your
  usage data (#16)
- **AI Engineer Coach: Export Summary** saves the dashboard summary as Markdown and JSON (#55)
- **Coding Moments** gallery of the images in your sessions, with a time-range filter (#6, #118)
- Context Files view for `skills/` and `AGENTS.md` (#90)
- Net new AI lines of code on the Output page (#131)
- Redesigned share card with social sharing buttons and a streak badge (#11)
- Live parse telemetry strip and a dismissible "skipped history" banner on the loading
  screen (#121)
- Session discovery for WSL, Remote SSH, and dev containers (`.vscode-server`) (#63)
- More complete Codex coverage, including the skills each session used (#51, #67)

### Changed

- Use GitHub Copilot's Auto model for all AI features instead of hard-coded model families. In VS Code,
  the Why? buttons, Skill Finder, and Level Up are hidden and the context review is disabled while
  GitHub Copilot isn't available; they come back on sign-in without reopening the dashboard (#301)
- Claude sessions are reported under a single "Claude" harness, and consumption analytics add
  a per-harness daily token breakdown (#5)
- Skills read from `SKILL.md` files count toward Claude skill usage, and agent mode metrics
  are more accurate (#10)
- The VSIX no longer ships development-only files (#307)

### Fixed

- Fix the anti-pattern **Why?** explanation getting stuck on "Asking AI for an explanation…" (#278):
  every explanation state now renders through Preact, empty or failed responses show an error,
  and timeouts, denied access, and quota errors fail fast instead of retrying for minutes
- Fix canvas mode intermittently loading with an empty content pane or a stuck
  loading screen (#269): the canvas bridge now subscribes to host events only
  after the dashboard signals it is listening, so the replayed `dataReady` is
  never dropped
- Fix Coding Moments image counting and loading across VS Code, Copilot CLI/App,
  Claude (including subagents), Codex, OpenCode JSON/SQLite, and Xcode (#292);
  extract images off-thread with bounded local reads and session-scoped caching
- Fix parse-worker out-of-memory on large log sets (#106): parsing now runs in a
  forked child process with a capped heap and streams results back in per-session
  chunks using ack-window backpressure to avoid native IPC buffer growth
- Sync no longer takes minutes on large JSONL logs (#161)
- Output no longer inflates lines of code from VS Code edit-session payloads (#131)
- Delivery funnel session and pull request counts (#245)
- Skill Finder finds the community catalog again (#294)
- Harness-injected context such as `AGENTS.md` instructions no longer counts as user prompts
  in workflow and skill analysis (#154)
- The dashboard loads when only Claude, Codex, or OpenCode logs exist (#53)
- Workspace roots for Claude and OpenCode sessions (#86)
- Rule calibration no longer depends on the system locale (#85)
- Learning Center quizzes reset the selected answer for each new question (#137)
- Navigation badges announce changes to screen readers (#190)
- `npm run package` failure (#36)

### Security

- Escape harness names in the sidebar to prevent cross-site scripting (#38)
- Replace the webview's `unsafe-inline` style policy with an external stylesheet (#39)
- Harden the webview message boundary, path handling, and log parsers (#94); bound log and
  cache reads, gate project rules on Workspace Trust, and redact secrets before language
  model calls (#120)

## [0.1.0] - 2026-05-06

### Added

- Dashboard with timeline, output, and consumption views
- Anti-pattern detection with 40+ built-in rules
- Skill Finder and context quality analysis
- Activity patterns (projects, work hours)

[Unreleased]: https://github.com/microsoft/AI-Engineering-Coach/commits/main
[0.1.0]: https://github.com/microsoft/AI-Engineering-Coach/tree/4b43880a50565a57d15c306a8d9de4724f8dc1e5
