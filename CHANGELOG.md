# Changelog

## Unreleased

- Fix the anti-pattern **Why?** explanation getting stuck on "Asking AI for an explanation…" (#278):
  every explanation state now renders through Preact, empty or failed responses show an error,
  and timeouts, denied access, and quota errors fail fast instead of retrying for minutes
- Use GitHub Copilot's Auto model for all AI features instead of hard-coded model families, and
  hide AI features in VS Code while GitHub Copilot isn't available, showing them again on sign-in
  without reopening the dashboard
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
