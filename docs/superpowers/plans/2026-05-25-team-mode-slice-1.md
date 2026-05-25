# Team Mode Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the privacy-safe Team Mode foundation so the extension can optionally publish only aggregated developer stats to a shared backend after each local analysis.

**Architecture:** Keep the existing local analytics pipeline unchanged when Team Mode is off. When enabled, the extension will build a compact numeric snapshot from already-computed analysis results, queue it locally, and sync it to the backend with a minimal transport layer that never touches raw session content.

**Tech Stack:** TypeScript, VS Code extension APIs, existing analyzer outputs, existing webview lifecycle, fetch/HTTP, local state storage, Vitest.

---

### Task 1: Define the Team Mode settings and persisted state

**Files:**
- Modify: `package.json`
- Modify: `src/core/types/config-types.ts`
- Modify: `src/extension.ts`
- Test: `src/core/analyzer-config.test.ts`

- [ ] Add the new Team Mode setting surface to the extension manifest so users can enable or disable sync, provide a server URL, and store a unique developer ID locally.
- [ ] Extend the configuration types to represent the Team Mode shape in one place so the rest of the codebase can read the feature state without guessing at raw settings keys.
- [ ] Update extension startup to read the Team Mode configuration once and keep it isolated from the local-only path when the feature is disabled.
- [ ] Add coverage that verifies the new configuration values are present, optional by default, and do not change any existing local analytics behavior.

### Task 2: Introduce a compact Team Mode snapshot model

**Files:**
- Create: `src/core/types/team-mode-types.ts`
- Modify: `src/core/types/rpc-types.ts`
- Modify: `src/core/types/analytics-types.ts`
- Test: `src/core/team-mode-types.test.ts`

- [ ] Define a dedicated snapshot type that contains only aggregate numbers: developer ID, timestamps, five practice-group scores, token totals, anti-pattern counts, severity counts, and week-over-week deltas.
- [ ] Keep the snapshot deliberately narrow so no raw prompt text, file names, workspace names, or session-level event data can be serialized into the sync payload.
- [ ] Extend any typed contracts that need to reference the new snapshot or sync result so the extension and backend integration stay type-safe.
- [ ] Add tests that confirm the snapshot schema accepts only numeric summaries and rejects string-heavy fields that would violate the privacy boundary.

### Task 3: Build the local snapshot assembler

**Files:**
- Create: `src/core/team-mode.ts`
- Modify: `src/core/analyzer-dashboard.ts`
- Modify: `src/core/analyzer-patterns.ts`
- Modify: `src/core/analyzer-context.ts`
- Modify: `src/core/analyzer-consumption.ts`
- Modify: `src/core/analyzer-flow.ts`
- Test: `src/core/team-mode.test.ts`

- [ ] Create a dedicated helper that converts existing analyzer outputs into one sanitized Team Mode snapshot.
- [ ] Pull the five practice-group scores from the same anti-pattern data the dashboard already uses so the team report stays aligned with the individual experience.
- [ ] Derive token totals from existing consumption or token-coverage data, but reduce them to counts and totals only.
- [ ] Summarize anti-pattern violations by rule and severity using counts, not examples.
- [ ] Compute week-over-week deltas from already-available time-bucketed aggregates so the snapshot can show improvement trends without exposing request text.
- [ ] Add tests for the happy path and for privacy regressions, especially ensuring the assembler never includes message text, file paths, or workspace identifiers.

### Task 4: Add the secure sync client and queue

**Files:**
- Create: `src/core/team-sync.ts`
- Modify: `src/extension.ts`
- Modify: `src/core/runtime-debug.ts`
- Test: `src/core/team-sync.test.ts`

- [ ] Build a small sync client that reads the Team Mode settings, posts the snapshot to the configured backend, and only runs when Team Mode is enabled.
- [ ] Add a local queue or retry buffer so failed uploads are retried quietly instead of blocking the user experience.
- [ ] Make the transport strictly one-way for analytics snapshots and ensure request bodies contain only the approved aggregate fields.
- [ ] Add lightweight runtime logging that records success, failure, and retry state without printing the snapshot contents.
- [ ] Add tests for disabled mode, successful sync, transient failure retry, and hard failure behavior with the raw payload inspected to prove privacy boundaries are preserved.

### Task 5: Trigger sync after analysis completes

**Files:**
- Modify: `src/webview/panel.ts`
- Modify: `src/webview/panel-rpc.ts`
- Modify: `src/core/cache.ts`
- Test: `src/webview/panel-rpc.test.ts`

- [ ] Hook the sync client into the analysis completion path so the snapshot is generated only after local parsing and scoring are already finished.
- [ ] Keep the sync step asynchronous and non-blocking so dashboard rendering is never delayed by backend availability.
- [ ] Make sure reloads, cache hits, and repeated panel opens do not cause duplicate uploads for the same completed analysis window.
- [ ] Add tests that verify sync is invoked after successful analysis, skipped when Team Mode is off, and skipped when no new analysis result exists.

### Task 6: Document the privacy contract for Slice 1

**Files:**
- Modify: `README.extension.md`
- Modify: `docs/content/getting-started/_index.md`
- Modify: `docs/content/features/_index.md`

- [ ] Add a short user-facing description of Team Mode that explains the opt-in nature, the required server URL, and the local developer ID.
- [ ] Document the privacy guarantee in plain language: only aggregate numeric stats are sent, and raw prompts, code, and file names remain local.
- [ ] Note that the local-only experience is unchanged when Team Mode is off.

### Task 7: Verify the slice end-to-end

**Files:**
- Modify: none
- Test: `src/core/team-mode.test.ts`
- Test: `src/core/team-sync.test.ts`
- Test: `src/core/analyzer-config.test.ts`
- Test: `src/webview/panel-rpc.test.ts`

- [ ] Run the focused unit tests for the settings, snapshot assembler, sync client, and panel integration.
- [ ] Run the extension typecheck to confirm the new types thread cleanly through the existing analyzer and webview code.
- [ ] Check for any accidental references to session text, filenames, or workspace paths in the sync payload or logging paths.
- [ ] Commit the slice only after the privacy boundary and the off-by-default behavior are both proven in tests.

---

### Coverage Check

- Team Mode settings and persisted state: Task 1.
- Local snapshot builder with privacy-safe aggregates: Tasks 2 and 3.
- Secure sync client and retry behavior: Task 4.
- Triggering sync after analysis completes: Task 5.
- Documentation and user-facing privacy guarantees: Task 6.
- Verification and regression testing: Task 7.

### Out of Scope For This Slice

- Backend API and storage schema.
- Admin and invite-code flows.
- Team Dashboard UI and PDF export.
- Identity providers or external login.

