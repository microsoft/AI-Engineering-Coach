## Workers

- [warm-up-worker.ts](src/core/warm-up-worker.ts): `sessions` -> `antiPatterns` + `configHealth`.
- [parse-worker.ts](src/core/parse-worker.ts): `logsDirs` -> `progress` + `result`/`error`.
- [cache-write-worker.ts](src/core/cache-write-worker.ts): writes cache payload.

## Local Rule Trust Flow

Rules move pending→review→approve→reload; edits revoke trust. See [anti-patterns](docs/content/improve/anti-patterns.md) and [rule editor](docs/content/improve/rule-editor.md).

## Documentation Index

This is a quick map of the docs tree so readers and agents can see the available pages at a glance.

- [Features](/features/)
- [Getting Started](/getting-started/)
  - [Installation](/getting-started/installation/)
  - [Supported Tools](/getting-started/supported-tools/)
- [Improve](/improve/)
  - [Anti-Patterns](/improve/anti-patterns/)
  - [Context Health](/improve/context-health/)
  - [Data Explorer](/improve/data-explorer/)
  - [Rule Editor](/improve/rule-editor/)
  - [Rule Playground](/improve/rule-playground/)
  - [Skill Finder](/improve/skill-finder/)
- [Level Up](/level-up/)
  - [Achievements](/level-up/achievements/)
  - [Learning Center](/level-up/learning/)
  - [Agentic SDLC](/level-up/sdlc/)
  - [Share](/level-up/share/)
- [Measure](/measure/)
  - [Burndown](/measure/burndown/)
  - [Output](/measure/output/)
  - [Activity Patterns](/measure/patterns/)
- [Observe](/observe/)
  - [Dashboard](/observe/dashboard/)
  - [Timeline](/observe/timeline/)
