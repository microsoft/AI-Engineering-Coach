# Task 1 Proofs — SQLite dependency added and wired into build

## Task Summary

This task adds `better-sqlite3` as a production dependency, marks it external in
all esbuild bundles so it is not bundled (native `.node` binaries cannot be
bundled), and updates `.vscodeignore` to include the native module in the packaged
VSIX. A thin read-only DB wrapper is implemented inline in `parser-opencode.ts`.

## What This Task Proves

- `better-sqlite3` is present in `package.json` dependencies (not devDependencies).
- All esbuild build contexts declare `better-sqlite3` as external.
- `.vscodeignore` whitelists `better-sqlite3` and its runtime deps so the binary
  ships in the VSIX.
- The wrapper opens, queries, and closes a DB without error in the current Node
  runtime (validated by the test suite smoke test in Task 3's tests).
- `npm run check` (typecheck + lint + spellcheck + knip + tests) passes cleanly.

## Artifact: package.json dependency entry

**What it proves:** `better-sqlite3` is a production runtime dependency.

**Command:**

```bash
node -e "const p=require('./package.json'); console.log('better-sqlite3:', p.dependencies['better-sqlite3'])"
```

**Result summary:** Dependency is present.

```
better-sqlite3: ^12.10.0
```

## Artifact: esbuild.mjs external declarations

**What it proves:** Native module is excluded from all bundles (required for `.node` binaries).

**Command:**

```bash
grep "better-sqlite3" esbuild.mjs
```

**Result summary:** All 8 build contexts declare `better-sqlite3` as external.

```
  external: ['vscode', 'better-sqlite3'],
  external: ['vscode', 'better-sqlite3'],
  external: ['vscode', 'better-sqlite3'],
  external: ['vscode', 'better-sqlite3'],
    external: ['vscode', 'better-sqlite3'],
    external: ['vscode', 'better-sqlite3'],
    external: ['vscode', 'better-sqlite3'],
    external: ['vscode', 'better-sqlite3'],
```

## Artifact: .vscodeignore inclusion

**What it proves:** Native module binary will be included in the published VSIX.

**Command:**

```bash
grep -A3 "Exception: better-sqlite3" .vscodeignore
```

**Result summary:** Three lines whitelist the module and its runtime dependencies.

```
!node_modules/better-sqlite3/**
!node_modules/bindings/**
!node_modules/file-uri-to-path/**
```

## Artifact: npm run check passes

**What it proves:** The new dependency does not break typecheck, lint, spellcheck, knip, or tests.

**Command:**

```bash
npm run check 2>&1 | grep -E "CSpell.*Issues|Tests.*passed"
```

**Result summary:** Zero spellcheck issues; all 1039 tests pass.

```
CSpell: Files checked: 199, Issues found: 0 in 0 files.
      Tests  1039 passed (1039)
```

## Reviewer Conclusion

`better-sqlite3` is correctly installed as a runtime dependency, excluded from
esbuild bundles, and included in the VSIX packaging. The build and all tests
remain clean.
