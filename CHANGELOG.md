# Changelog

## Unreleased

- Fix VS Code re-parsing every log on each launch: the parse worker is stopped as soon as it
  reports its result, which also killed the parse-cache write still in progress, so the cache was
  never saved. The worker now waits (up to 30 seconds) for the write to finish first, and the
  cache files are replaced atomically (temp file + rename), so an interrupted write never leaves a
  broken cache. Every load now returns sessions and workspaces in one canonical order, so a
  launch from the cache shows the same anti-pattern examples and rankings as a full parse. Unit
  tests now run against a temporary home directory and no longer delete the developer's real
  `~/.copilot-analytics-cache`
- Fix the anti-pattern **Why?** explanation getting stuck on "Asking AI for an explanation…" (#278):
  every explanation state now renders through Preact, empty or failed responses show an error,
  and timeouts, denied access, and quota errors fail fast instead of retrying for minutes
- Use GitHub Copilot's Auto model for all AI features instead of hard-coded model families. In VS Code,
  the Why? buttons, Skill Finder, and Level Up are hidden and the context review is disabled while
  GitHub Copilot isn't available; they come back on sign-in without reopening the dashboard
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
- Add live parse telemetry strip and a dismissible "skipped history" banner to the
  loading screen
- Extract streaming JSONL readers, worker-host, and skipped-banner modules with
  full unit-test coverage

## 0.1.0 — First Release

- Dashboard with timeline, output, and consumption views
- Anti-pattern detection with 40+ built-in rules
- Skill Finder and context quality analysis
- Activity patterns (projects, work hours)
