# Changelog

## Unreleased

- Fix "LLM returned invalid JSON after 3 attempts" on all AI features (#91):
  model selection now prefers Copilot's built-in "Auto" router so requests are
  routed to a model actually enabled for the user's plan/org, instead of a
  hardcoded model family that can be selectable yet silently return empty
  responses. Empty responses are now detected and reported with an actionable
  message instead of being misreported as an "invalid JSON" parse failure
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
