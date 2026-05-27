# 01 Questions Round 1 - OpenCode SQLite parser

Please answer each question below (select one or more options, or add your own notes). Feel free to add additional context under any question.

## 1. OpenCode storage formats in scope

Which OpenCode data formats should we support?

- [ ] (A) SQLite only (`~/.local/share/opencode/opencode.db`)
- [ ] (B) Legacy JSON-only (`~/.local/share/opencode/storage/session/global/*.json` etc.)
- [x] (C) Both SQLite (preferred) and legacy JSON (fallback)
- [ ] (D) Other (describe)

**Recommended answer(s):** [(C)]

**Why these are recommended:**

- `(C)` prevents regressions for users on older OpenCode versions while fixing the current “no sessions loaded” issue for users on SQLite.
- `(C)` keeps discovery logic simple (try SQLite first, fall back to JSON).

## 2. Supported platforms

Which platforms should the SQLite-based OpenCode parsing support?

- [ ] (A) macOS + Linux only
- [x] (B) macOS + Linux + Windows (if OpenCode has an equivalent DB location)
- [ ] (C) macOS only
- [ ] (D) Other (describe)

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- The current OpenCode directory discovery in this repo only targets `~/.local/share/...` (macOS/Linux).
- Expanding to Windows is valuable, but it requires confirming OpenCode’s Windows storage location(s).

## 3. SQLite access strategy (dependency choice)

How should the extension read the SQLite database?

- [ ] (A) Use a pure-JS/WASM SQLite library bundled with the extension (no native deps)
- [x] (B) Use a native Node SQLite package (may require platform-specific binaries)
- [ ] (C) Shell out to the `sqlite3` CLI (requires it to be installed on the user machine)
- [ ] (D) Use Node’s built-in SQLite API (if available in the VS Code extension host)
- [ ] (E) Other (describe)

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` is the most reliable for VS Code extensions: no reliance on the user having `sqlite3` installed, and avoids native binary distribution friction.
- `(B)` can work but increases packaging complexity and can break on uncommon platforms/architectures.
- `(C)` is simplest to code but least reliable across machines.

## 4. Performance expectations

OpenCode DBs can be large (you have ~700 sessions). What should the first version optimize for?

- [ ] (A) Fast initial load (limit sessions/messages, paginate later)
- [x] (B) Completeness (load everything, even if it takes longer)
- [ ] (C) Adaptive (load recent sessions first, lazily load older)
- [ ] (D) Other (describe)

**Recommended answer(s):** [(C)]

**Why these are recommended:**

- `(C)` keeps the dashboard responsive while still allowing full history over time.
- It maps well to the existing “progress” reporting patterns in parse workers.

## 5. Privacy / data minimization

When parsing SQLite, should we read all message/part JSON blobs, or only what we need?

- [x] (A) Minimum required fields only (role, timestamps, model, tokens, text/tool parts)
- [ ] (B) Parse and store everything OpenCode provides
- [ ] (C) Other (describe)

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` matches the extension’s “read-only, zero telemetry” posture while reducing memory and CPU.
- `(B)` increases risk of schema drift causing breakage and can bloat caches.
