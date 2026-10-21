# Changelog

## Unreleased

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
