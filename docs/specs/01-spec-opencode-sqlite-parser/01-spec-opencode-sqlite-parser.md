# 01-spec-opencode-sqlite-parser.md

## Introduction/Overview

OpenCode session data is no longer loaded for many users because OpenCode migrated from JSON files under `~/.local/share/opencode/storage/**` to a SQLite database at `~/.local/share/opencode/opencode.db`. This feature adds SQLite-based OpenCode parsing (with legacy JSON fallback) so OpenCode sessions appear in the AI Engineer Coach dashboard again.

## Goals

- Load OpenCode sessions from `opencode.db` (SQLite) when present.
- Preserve compatibility by continuing to support the legacy JSON layout when it exists.
- Support macOS, Linux, and Windows (when OpenCode data is located under `%USERPROFILE%\.local\share\opencode`).
- Keep parsing read-only and data-minimized: extract only fields needed for existing analytics.
- Handle large databases (hundreds+ sessions) without crashing; parsing may be slower but must complete reliably.

## User Stories

- **As a user of OpenCode**, I want my OpenCode sessions to appear in the dashboard so that my tool usage analytics are complete.
- **As a user with an older OpenCode version**, I want OpenCode sessions to continue loading from JSON so that updates to the extension don’t break my existing data.
- **As a Windows user**, I want OpenCode sessions to load from the standard OpenCode data directory so that I can use the dashboard cross-platform.

## Demoable Units of Work

### Unit 1: SQLite-based discovery and parsing

**Purpose:** Load OpenCode sessions when OpenCode stores data in `opencode.db`.

**Functional Requirements:**

- The system shall detect an OpenCode SQLite database at the OpenCode data directory (macOS/Linux: `~/.local/share/opencode/opencode.db`; Windows: `%USERPROFILE%\.local\share\opencode\opencode.db`).
- The system shall parse sessions, messages, and parts from the SQLite schema (`session`, `message`, `part`) and produce the existing internal `Session` / `SessionRequest` models.
- The system shall remain read-only (no writes, migrations, or vacuum operations).

**Proof Artifacts:**

- Test: `src/core/parser-opencode.test.ts` includes a fixture DB and passes, demonstrating SQLite sessions are parsed.
- CLI/Test output: `npm test` passes, demonstrating the parser integrates with the existing harness pipeline.

### Unit 2: Legacy JSON fallback and zero-regression behavior

**Purpose:** Ensure OpenCode parsing continues to work for users on the old JSON storage format.

**Functional Requirements:**

- The system shall continue to parse OpenCode sessions from the legacy JSON layout when the expected JSON directories exist.
- The system shall prefer SQLite when both formats are present, and fall back to legacy JSON when SQLite is absent/unreadable.
- The system shall not change the meaning of existing OpenCode-derived metrics (tokens, cache tokens, tool usage, edited/referenced files) compared to legacy JSON parsing.

**Proof Artifacts:**

- Test: a legacy JSON fixture continues to parse and assertions remain unchanged.
- Test: when both DB and JSON fixtures are present, SQLite is selected, demonstrating preference ordering.

### Unit 3: Large-DB robustness

**Purpose:** Ensure parsing large OpenCode DBs completes reliably.

**Functional Requirements:**

- The system shall parse large DBs without unbounded memory growth (e.g., avoid loading all rows into memory when not necessary).
- The system shall tolerate missing or malformed `data` JSON blobs in `message.data` / `part.data` by skipping malformed entries rather than failing the entire parse.

**Proof Artifacts:**

- Test: a synthetic fixture (or generated DB) with many sessions/messages completes parsing under the test runner.

## Non-Goals (Out of Scope)

1. **OpenCode UI state or non-session data**: parsing `todo`, `event`, `permission`, `workspace` tables beyond what is needed to build session/workspace IDs.
2. **Realtime/streaming updates**: watching the DB for changes or incremental refresh while OpenCode is running.
3. **Perfect performance optimization**: the first version prioritizes correctness and completeness over fastest load times.

## Design Considerations

No specific design requirements identified.

## Repository Standards

- Follow existing harness architecture: `find*Dirs()` + `parse*Sessions()` wired through `src/core/parser-harnesses.ts`.
- Keep parsing logic in `src/core/parser-opencode.ts` and tests alongside existing parser tests.
- Use the repository’s existing tooling: TypeScript, Vitest, ESLint.
- Maintain the extension’s posture: read-only parsing, no telemetry.

## Technical Considerations

- **Storage location (Windows):** OpenCode’s troubleshooting docs indicate Windows uses `%USERPROFILE%\.local\share\opencode` for storage, including `opencode.db`.
- **SQLite access (native dependency):** Use a VS Code-compatible SQLite native package to reduce Node ABI mismatch issues (e.g., `@vscode/sqlite3` is published specifically for VS Code extension hosts).
- **Schema mapping:**
  - `session` rows provide session metadata (id, slug, directory, title, time_created/time_updated, tokens/cache fields).
  - `message.data` is JSON; extract role, time.created/completed, agent, model.providerID/modelID/variant, tokens/cost (when present).
  - `part.data` is JSON; extract text parts and tool parts (tool name, state.input, state.output).
- **Minimized parsing:** Parse only the subset of JSON fields that the current `createRequest()`/analytics pipeline consumes.
- **Fallback order:** Discovery should return both the DB path (or a marker that indicates DB parsing) and legacy `storage/` paths; the harness should attempt SQLite first.

## Security Considerations

- Treat the OpenCode data directory and DB path as untrusted input: keep existing trusted-path checks and avoid following symlinks outside expected directories.
- Do not log or export raw message bodies by default outside of the existing analytics pipeline.
- Do not require users to install external tools (e.g., `sqlite3` CLI) for parsing.

## Success Metrics

1. **Session loading:** OpenCode sessions appear in the dashboard for users with only `opencode.db` present.
2. **No regressions:** Existing legacy JSON OpenCode parsing tests (and real-world users) continue to work.
3. **Stability:** Parsing a large DB (hundreds of sessions) completes without crashing the extension host.

## Open Questions

1. Should we expose a user-facing warning when SQLite parsing fails (vs silently falling back to JSON or showing no sessions)?
2. Do we need additional Windows paths (e.g., older docs suggesting `%APPDATA%`) or is `%USERPROFILE%\.local\share\opencode` sufficient?
