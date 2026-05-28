# Configurable Aggregation Granularity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each developer choose local Team Mode aggregation granularity and detail level so the dashboard can switch between daily, weekly, and monthly rollups, plus category-only versus more granular breakdowns, without rerunning analysis or sending any data off the machine.

**Architecture:** Add a small local aggregation preference model to the existing Team Mode settings, thread it through the Team Dashboard RPC and export path, and keep the underlying analysis cache untouched. The dashboard will re-request already-local data when settings change, then regroup and re-render from stored snapshots and metadata instead of re-parsing logs.

**Tech Stack:** VS Code extension settings, TypeScript, local JSON snapshot files, the existing Team Dashboard webview, Vitest, and the repo’s current local storage helpers.

---

### Task 1: Define the new Team Mode settings and defaults

**Files:**
- Modify `package.json`
- Modify `src/core/types/config-types.ts`
- Modify `src/core/team-mode.ts`
- Modify `src/core/team-mode.test.ts`

**Steps:**
- [ ] Add two new extension settings under `aiEngineerCoach.teamMode`: one for aggregation granularity and one for detail level. Keep the existing Team Mode enable switch unchanged.
- [ ] Make the default granularity `weekly` so current users see no change unless they opt in to a different setting.
- [ ] Make the default detail level the category-only view so the current dashboard shape remains the baseline.
- [ ] Extend `TeamModeSettings` and `normalizeTeamModeSettings()` so unknown or invalid values fall back to the safe defaults.
- [ ] Update `readTeamModeSettings()` so it reads the new keys from `workspace.getConfiguration('aiEngineerCoach')`.
- [ ] Add tests that prove `normalizeTeamModeSettings()` and `readTeamModeSettings()` return the new defaults when the keys are missing and preserve valid values when present.
- [ ] Run `npm test -- --run src/core/team-mode.test.ts` and expect the new test cases to fail before implementation and pass after.

### Task 2: Extend the Team Mode snapshot model for preference-aware exports

**Files:**
- Modify `src/core/types/team-mode-types.ts`
- Modify `src/core/team-mode.ts`
- Modify `src/core/team-mode-local.ts`
- Modify `src/core/team-mode-types.test.ts`

**Steps:**
- [ ] Add snapshot metadata that records the selected aggregation granularity and detail level used at export time.
- [ ] Add a compact per-practice-group breakdown structure so the dashboard can show more than just one score tile per category when the user chooses the finer detail view.
- [ ] Bump the snapshot schema version and keep the sanitizer backward compatible so older `schemaVersion: 1` files still import cleanly with safe defaults.
- [ ] Make the normalizer ignore malformed or partial preference metadata instead of rejecting the whole snapshot.
- [ ] Update the empty snapshot factory to include the new fields with zero-risk defaults.
- [ ] Expand the model tests so they verify the new empty shape and the old shape still round-trips.
- [ ] Run `npm test -- --run src/core/team-mode-types.test.ts src/core/team-mode.test.ts` and expect compatibility failures until the schema and sanitizer are updated.

### Task 3: Add the aggregation logic that groups already-local data by day, week, or month

**Files:**
- Modify `src/core/team-mode-local.ts`
- Create `src/core/team-mode-local.test.ts`

**Steps:**
- [ ] Introduce a local bucketing helper that can group imported snapshots by day, ISO week, or calendar month using their existing timestamps.
- [ ] Make the Team Dashboard response builder accept the current aggregation settings and compute the visible developer rows from those buckets instead of from a fixed weekly view.
- [ ] Keep the underlying imported snapshot records unchanged so the dashboard can regroup them later when the setting changes.
- [ ] Preserve the current category-only response shape when detail level is category-only, and include the extra per-category breakdown data when detail level is expanded.
- [ ] Make the snapshot export helper write the chosen aggregation metadata into the exported JSON without forcing a new analysis pass.
- [ ] Add targeted tests for daily, weekly, and monthly grouping, plus a test that verifies changing settings only changes grouping and not the stored raw records.
- [ ] Run `npm test -- --run src/core/team-mode-local.test.ts` and expect bucket-specific assertions to fail until the helper exists.

### Task 4: Wire the dashboard and settings-change refresh path

**Files:**
- Modify `src/extension.ts`
- Modify `src/webview/panel.ts`
- Modify `src/webview/shared.ts`
- Modify `src/webview/app.ts`
- Modify `src/webview/page-team-dashboard.ts`
- Modify `src/webview/styles.css`
- Modify `src/webview/page-team-dashboard.test.ts`

**Steps:**
- [ ] Add a configuration-change listener in the extension so updates to the new Team Mode settings notify the active panel immediately.
- [ ] Add a lightweight panel method or message path that tells the webview to refresh Team Dashboard data without reloading the full extension or rerunning analysis.
- [ ] Extend the shared message listener so the webview can receive a dedicated `teamModeSettingsChanged` event.
- [ ] Update the Team Dashboard page so it re-requests `getTeamDashboard` when that event arrives and then re-renders in place.
- [ ] Update the Team Dashboard header copy to reflect the active granularity and detail level, and add a subtle settings affordance that feels native to the existing dashboard instead of a new standalone tool.
- [ ] Change the trend labels and supporting text so they read naturally for daily, weekly, or monthly rollups instead of always implying week-over-week behavior.
- [ ] Add or adjust CSS only where needed so the new settings badge or chip matches the current dashboard style.
- [ ] Extend the webview test so it proves the shell still renders, the new settings affordance exists, and the page reacts to a simulated settings-change event.
- [ ] Run `npm test -- --run src/webview/page-team-dashboard.test.ts src/webview/panel-rpc.test.ts` and expect the refresh-path assertions to fail before the message wiring exists.

### Task 5: Integrate snapshot export and import compatibility

**Files:**
- Modify `src/webview/panel.ts`
- Modify `src/core/team-mode-local.ts`
- Modify `src/core/team-mode.test.ts`
- Modify `src/core/team-mode-types.test.ts`

**Steps:**
- [ ] Read the current Team Mode settings at export time so the snapshot file always captures the active granularity preference the developer chose in VS Code settings.
- [ ] Pass those settings into the snapshot builder/export helper so the exported JSON reflects the selected granularity and detail level.
- [ ] Keep the import path tolerant of both the old snapshot format and the new preference-aware format so existing exports do not break.
- [ ] Make sure import reconciliation still deduplicates by file path and does not reinterpret old snapshots as malformed simply because the new metadata is absent.
- [ ] Add a regression test that exports a snapshot under each granularity, then imports it and confirms the file remains local, valid, and preference-aware.
- [ ] Run `npm test -- --run src/core/team-mode.test.ts src/core/team-mode-types.test.ts src/core/team-mode-local.test.ts` and expect compatibility failures until export and import both understand the new metadata.

### Task 6: Update docs and user-facing guidance

**Files:**
- Modify `README.extension.md`
- Modify `docs/content/getting-started/_index.md`
- Modify `docs/content/getting-started/installation.md`
- Modify `docs/content/features/_index.md`
- Modify `docs/content/observe/dashboard.md`
- Optionally modify `CHANGELOG.md` if the repo expects release notes there

**Steps:**
- [ ] Document the new Team Mode settings names, defaults, and local-only behavior.
- [ ] Explain that weekly remains the sensible default, and that changing the setting only changes how already-local data is grouped and displayed.
- [ ] Call out that snapshot exports now preserve the chosen granularity preference in the JSON file while staying privacy-safe and machine-local.
- [ ] Update the dashboard docs so readers know the Team Dashboard can show category-only or expanded breakdowns, and that the display updates immediately when the setting changes.
- [ ] Keep the wording aligned with the rest of the extension docs so this feels like a native addition, not a bolt-on feature.
- [ ] Re-run the markdown checks used by the repo, plus any docs-specific validation the project already uses, and expect only text changes from this slice.

### Task 7: Full verification and cleanup

**Files:**
- No new files expected

**Steps:**
- [ ] Run the targeted Vitest files from Tasks 1 through 5 together and confirm the new settings, grouping, export, and webview tests all pass.
- [ ] Run the repo’s broader checks that are practical for the change set, starting with `npm test` and then `npm run typecheck` if the test suite passes cleanly.
- [ ] Do one final manual pass through the Team Dashboard flow: change the setting, confirm the dashboard refreshes immediately, export a snapshot, and verify the JSON contains the chosen preference.
- [ ] If any backward-compatibility edge appears, fix it before merging rather than shipping a one-way schema change.

### Coverage Check

- Settings definition: Task 1
- Aggregation logic changes: Task 3
- Dashboard rendering updates: Task 4
- Snapshot export integration: Tasks 2 and 5
- Tests: Tasks 1 through 5, plus Task 7 verification
- Docs: Task 6

