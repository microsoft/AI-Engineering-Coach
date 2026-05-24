# Workers

- [warm-up-worker.ts](src/core/warm-up-worker.ts): `sessions` -> `antiPatterns` + `configHealth`.
- [parse-worker.ts](src/core/parse-worker.ts): `logsDirs` -> `progress` + `result`/`error`.
- [cache-write-worker.ts](src/core/cache-write-worker.ts): writes cache payload.

## Local Rule Trust Flow

Rules move pending→review→approve→reload; edits revoke trust. See [anti-patterns](docs/content/improve/anti-patterns.md) and [rule editor](docs/content/improve/rule-editor.md).
