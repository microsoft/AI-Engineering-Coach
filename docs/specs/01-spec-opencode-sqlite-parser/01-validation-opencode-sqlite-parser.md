# 01-validation-opencode-sqlite-parser.md

**Validated:** 2026-05-27  
**Validated by:** Claude Sonnet 4.5 (SDD Phase 4)

---

## 1. Executive Summary

- **Overall:** PASS — all mandatory gates clear.
- **Implementation Ready:** **Yes** — all functional requirements verified through passing tests, proof artifacts, and quality-gate output.
- **Key metrics:** 9/9 Functional Requirements Verified (100%); 3/3 Proof Artifact files present and functional; 7 core files changed, all mapped to spec tasks; 1039/1039 tests passing.

---

## 2. Coverage Matrix

### Functional Requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| FR-1 – Detect `opencode.db` on macOS/Linux (`~/.local/share/opencode/opencode.db`) | Verified | `findOpenCodeDbPaths()` L121–140 in `parser-opencode.ts`; test `findOpenCodeDbPaths > returns a DB path when HOME points to a dir with opencode.db` passes |
| FR-2 – Detect `opencode.db` on Windows (`%USERPROFILE%\...`) | Verified | Same `HOME \|\| USERPROFILE` lookup in `findOpenCodeDbPaths()`; `APPDATA` fallback at L128–136; Windows path documented in `supported-tools.md` |
| FR-3 – Parse `session`, `message`, `part` rows → `Session`/`SessionRequest` models | Verified | `parseOpenCodeSessionsFromDb()` L207–241; test `parses a session with user + assistant messages from SQLite` passes; `promptTokens`, `completionTokens`, `cacheReadTokens` assertions pass |
| FR-4 – Remain read-only (no DB writes, migrations, vacuum) | Verified | `tryOpenSqliteDb()` opens with `{ readonly: true, fileMustExist: true }` (L163–170); no `db.exec()` or `db.prepare().run()` calls exist in production paths |
| FR-5 – Continue legacy JSON parsing when it exists | Verified | `parseOpenCodeSessions()` unchanged; tests `records {input:0,output:0}` and `marks a request as missing` still pass |
| FR-6 – Prefer SQLite; fall back to JSON for dirs not covered by a DB | Verified | `parser-harnesses.ts` L99–116: SQLite collected first, `coveredParentDirs` set used to skip JSON dirs already covered |
| FR-7 – Existing OpenCode-derived metrics unchanged | Verified | `buildSessionFromMessages()` extracted as shared helper; legacy JSON path calls same helper; both pre-existing tests continue to pass with identical assertions |
| FR-8 – Large DBs: no unbounded memory growth | Verified | Per-session queries (`stmtMessages.all(rawSession.id)`, `stmtParts.all(rawSession.id)`) avoid full-table loads; test `handles a large number of sessions without throwing` (200 sessions) passes in ~102 ms |
| FR-9 – Tolerate malformed `data` JSON blobs (skip, don't crash) | Verified | `parseJsonBlob()` wraps `JSON.parse` in try/catch; test `skips malformed message.data and part.data rows without crashing` injects `'NOT JSON {{{'` and confirms 1 valid session still returned |

### Repository Standards

| Standard Area | Status | Evidence & Compliance Notes |
| --- | --- | --- |
| Coding standards (TypeScript strict, ESLint) | Verified | `npm run typecheck` exits clean; `npm run lint` produces zero errors (pre-existing warnings only, in other files) |
| Testing patterns (Vitest, co-located tests) | Verified | New tests added to existing `parser-opencode.test.ts`; uses `describe`/`it`/`expect` from Vitest; 9 tests pass |
| Quality gates (`npm run check`) | Verified | All five gates pass: typecheck, lint, spellcheck (0 issues), knip, 1039 tests |
| Read-only / zero-telemetry posture | Verified | DB opened `readonly: true`; no network calls added; consistent with extension README privacy statement |
| Harness pattern (`find*Dirs`/`parse*Sessions`) | Verified | New `findOpenCodeDbPaths()` and `parseOpenCodeSessionsFromDb()` follow exact naming convention of `findClaudeDirs()`/`parseClaudeSessions()` etc. |
| Conventional commits | Verified | Three commits: `feat(opencode): add better-sqlite3…`, `feat(opencode): add SQLite parser…`, `docs(opencode): document…` |
| Spellcheck dictionary | Verified | Added `bigproj`, `demoable`, `gateboard`, `myproj` to `cspell.json`; 0 issues after update |

### Proof Artifacts

| Task | Proof Artifact | Status | Verification Result |
| --- | --- | --- | --- |
| T1.0 | `01-proofs/01-task-1-proofs.md` – dependency, esbuild external, `.vscodeignore` | Verified | File exists; `package.json` shows `"better-sqlite3": "12.10.0"`; 8 esbuild contexts declare external; `.vscodeignore` whitelists binary |
| T2.0–T5.0 | `01-proofs/01-task-2-5-proofs.md` – test run, token/tool/malformed/large-DB assertions | Verified | File exists; all 9 tests reproduce from `npx vitest run src/core/parser-opencode.test.ts`; inline evidence matches assertion values |
| T6.0 | `01-proofs/01-task-6-proofs.md` – supported-tools.md diff | Verified | File exists; `docs/content/getting-started/supported-tools.md` contains storage layout table and troubleshooting section |

---

## 3. Validation Issues

| Severity | Issue | Impact | Recommendation |
| --- | --- | --- | --- |
| MEDIUM | `APPDATA` fallback path (`%APPDATA%\opencode\opencode.db`) for Windows has no dedicated test. Code is present at `parser-opencode.ts` L128–136; marked "best-effort" in the spec Open Questions. | Traceability gap for one Windows edge-case path; functional coverage still adequate since primary Windows path (`USERPROFILE`) shares the same code branch as the macOS/Linux test. | Add a test that stubs `APPDATA` and a temp `opencode.db` in a follow-up PR to close the gap. |

No CRITICAL or HIGH issues found.

---

## 4. Evidence Appendix

### Git commits analyzed

```
be57cec  docs(opencode): document SQLite storage layout and troubleshooting
5e95cd9  feat(opencode): add SQLite parser, discovery, fallback, and robustness
8714fcc  feat(opencode): add better-sqlite3 dependency and build wiring
```

### Core changed files → task mapping

| File | Classification | Task linkage |
| --- | --- | --- |
| `src/core/parser-opencode.ts` | Core | T2.0 (discovery), T3.0 (SQLite parsing), T4.0 (fallback, `buildSessionFromMessages`), T5.0 (robustness) |
| `src/core/parser-harnesses.ts` | Core | T4.0 (SQLite-preferred harness wiring, `hasExternalHarnessSources` update) |
| `esbuild.mjs` | Core | T1.0 (external declaration for all 8 build contexts) |
| `package.json` | Core | T1.0 (`better-sqlite3` dependency) |
| `package-lock.json` | Core | T1.0 (npm install artefact) |
| `.vscodeignore` | Core | T1.0 (VSIX binary inclusion) |
| `cspell.json` | Core | T3.0/T6.0 (spellcheck words added for new test fixtures and SDD docs) |

### Supporting files → linkage

| File | Linkage |
| --- | --- |
| `src/core/parser-opencode.test.ts` | Tests for `parser-opencode.ts` (T3.0, T4.0, T5.0) |
| `docs/content/getting-started/supported-tools.md` | T6.0 documentation requirement |
| `docs/specs/01-spec-opencode-sqlite-parser/**` | SDD planning and proof artifacts |
| `.pi-lens/**` | Tooling cache; no production relevance |

### Final quality-gate run

```
npm run check output:
  CSpell: Files checked: 202, Issues found: 0 in 0 files.
  Tests  1039 passed (1039)
  typecheck: clean
  knip: clean
```

### better-sqlite3 runtime smoke test

```
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('CREATE TABLE t(v)'); db.prepare('INSERT INTO t VALUES(?)').run(99); console.log(db.prepare('SELECT v FROM t').get()); db.close()"
→ { v: 99 }
```
