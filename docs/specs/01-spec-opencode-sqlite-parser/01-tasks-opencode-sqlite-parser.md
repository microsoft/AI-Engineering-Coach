# 01-tasks-opencode-sqlite-parser.md

## Relevant Files

| File                                                               | Why It Is Relevant                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/core/parser-opencode.ts`                                      | Main OpenCode parsing logic; will add SQLite path + parsing while preserving legacy JSON behavior.          |
| `src/core/parser-harnesses.ts`                                     | Orchestrates external harness parsing; may need adjustment if OpenCode discovery/parsing interface changes. |
| `src/core/parser-opencode.test.ts`                                 | Primary unit tests for OpenCode parsing; will add DB fixtures + regression coverage.                        |
| `src/core/parser-main.test.ts`                                     | Integration-style parsing tests; may need updates if harness discovery behavior changes.                    |
| `package.json`                                                     | Add SQLite dependency and ensure scripts/packaging remain valid.                                            |
| `README.md` (or `docs/content/getting-started/supported-tools/**`) | Document OpenCode `opencode.db` support + troubleshooting.                                                  |

### Notes

- Use `npm test` / `npm run check` as the primary quality gates.
- Keep parsing read-only and tolerate malformed rows by skipping them.
- **Assumptions to resolve spec open questions:**
  - No new user-facing warning UI in v1; failures fall back to legacy JSON when available.
  - Windows paths: support `%USERPROFILE%\\.local\\share\\opencode` primarily, and also probe `%APPDATA%\\opencode` as a best-effort fallback.

## Tasks

### [x] 1.0 Add SQLite dependency + DB access shim

#### 1.0 Proof Artifact(s)

- Diff: `package.json` includes chosen SQLite dependency demonstrates packaging intent
- Test: `npm test` passes demonstrates dependency integration does not break build

#### 1.0 Tasks

- [x] 1.1 Evaluate SQLite dependency options for VS Code extension host; select one (planned: `@vscode/sqlite3`).
- [x] 1.2 Add dependency to `package.json` and ensure it is included in the packaged VSIX (no devDependency-only usage).
- [x] 1.3 Add a small wrapper module/function (in `parser-opencode.ts` or a new `src/core/sqlite.ts`) that:
  - opens a DB read-only
  - runs parameterized queries
  - closes the DB reliably
- [x] 1.4 Add a focused unit test that can open a fixture DB file and run a simple query (smoke test for dependency/runtime compatibility).

### [ ] 2.0 Implement OpenCode SQLite discovery (macOS/Linux/Windows)

#### 2.0 Proof Artifact(s)

- Test: `src/core/parser-opencode.test.ts` covers path discovery inputs and passes demonstrates correct directory detection

#### 2.0 Tasks

- [ ] 2.1 Update `findOpenCodeDirs()` (or replace with `findOpenCodeSources()` if needed) to discover:
  - macOS/Linux: `~/.local/share/opencode/opencode.db`
  - Windows: `%USERPROFILE%\\.local\\share\\opencode\\opencode.db`
  - Windows fallback: `%APPDATA%\\opencode\\opencode.db` (best-effort)
- [ ] 2.2 Preserve legacy discovery of `~/.local/share/opencode/storage` for JSON fallback.
- [ ] 2.3 Add unit tests for discovery logic by stubbing `HOME`/`USERPROFILE`/`APPDATA` and using temp directories.

### [ ] 3.0 Parse sessions/messages/parts from opencode.db

#### 3.0 Proof Artifact(s)

- Test: `src/core/parser-opencode.test.ts` parses a fixture `opencode.db` and passes demonstrates SQLite sessions are loaded
- CLI: `npm test` passes demonstrates harness pipeline compatibility

#### 3.0 Tasks

- [ ] 3.1 Implement `parseOpenCodeSessionsFromSqlite(dbPath: string): Session[]` that:
  - reads `session` rows
  - reads `message` rows filtered by `session_id`
  - reads `part` rows filtered by `message_id` (or `session_id` + grouping)
- [ ] 3.2 Implement JSON parsing helpers for `message.data` and `part.data` with try/catch and minimal-field extraction.
- [ ] 3.3 Map SQLite records into the existing request/session shapes:
  - user message text from message/part JSON
  - assistant response text from text parts
  - tool usage + edited/referenced files from tool parts
  - timestamps, model IDs, tokens/cost (when available)
- [ ] 3.4 Add a fixture `opencode.db` (small, representative) under test fixtures and ensure tests do not rely on the developer’s local DB.
- [ ] 3.5 Add unit tests asserting:
  - parsed session count > 0
  - workspace IDs use `opencode-<session.id>`
  - at least one request has assistant text and toolsUsed populated (when fixture contains them)

### [ ] 4.0 Preserve legacy JSON parsing + enforce SQLite-preferred fallback

#### 4.0 Proof Artifact(s)

- Test: legacy JSON fixture continues to parse with unchanged assertions demonstrates no regression
- Test: when both DB and JSON fixtures are present, SQLite is selected demonstrates preference ordering

#### 4.0 Tasks

- [ ] 4.1 Refactor `parseOpenCodeSessions()` to:
  - attempt SQLite parsing when a DB path exists and is readable
  - fall back to legacy JSON parsing when SQLite is missing or throws
- [ ] 4.2 Keep legacy JSON parsing behavior intact (including token mapping and tool classification).
- [ ] 4.3 Add fixtures for legacy JSON (or reuse existing) and assert exact or near-exact output stability.
- [ ] 4.4 Add a test covering the “both present” scenario (SQLite preferred).

### [ ] 5.0 Robustness for large DBs and malformed rows

#### 5.0 Proof Artifact(s)

- Test: synthetic fixture with many sessions/messages completes parsing demonstrates large-DB robustness
- Test: fixture with malformed `message.data` / `part.data` rows does not crash demonstrates graceful skipping behavior

#### 5.0 Tasks

- [ ] 5.1 Ensure DB parsing iterates row-by-row (or in bounded batches) instead of loading all rows into memory when possible.
- [ ] 5.2 Add tests that inject malformed JSON into `message.data` / `part.data` and assert the parser skips those rows while still returning other sessions.
- [ ] 5.3 Add a synthetic “large-ish” fixture generator in tests (or prebuilt fixture) to validate runtime does not blow up on volume.

### [ ] 6.0 Document the OpenCode storage change + troubleshooting guidance

#### 6.0 Proof Artifact(s)

- Diff: README/docs mention `opencode.db` support and where it is detected demonstrates user-facing clarity

#### 6.0 Tasks

- [ ] 6.1 Update documentation to explain why OpenCode may not load (DB vs legacy JSON) and what paths are checked.
- [ ] 6.2 Add a short troubleshooting note: if OpenCode sessions don’t appear, verify `opencode.db` exists in the expected directory.
