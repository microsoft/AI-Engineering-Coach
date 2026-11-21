/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* Decides when to announce new changelog entries after an update. CHANGELOG.md groups changes
 * under "## YYYY-MM-DD" headings, newest first. VS Code glue: src/whats-new-vscode.ts. */

/** The first changelog date, from before the extension recorded which changes a user had seen. */
export const DATE_BEFORE_TRACKING = '2026-05-06';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a YYYY-MM-DD changelog date. */
export function isChangelogDate(value: string): boolean {
  return DATE.test(value);
}

/** The newest "## YYYY-MM-DD" section of a changelog, or undefined when it has none. */
export function latestChangelogDate(markdown: string): string | undefined {
  let latest: string | undefined;
  for (const match of markdown.matchAll(/^## (\d{4}-\d{2}-\d{2})[ \t]*\r?$/gm)) {
    if (latest === undefined || match[1] > latest) latest = match[1];
  }
  return latest;
}

/**
 * Announce only newer changes: never on a fresh install, for an older build, or for a build with
 * the same changes. Without a recorded date, earlier use of the dashboard (`hasPriorUse`)
 * means the user last saw the changes of {@link DATE_BEFORE_TRACKING}.
 */
export function shouldAnnounceUpdate(previous: string | undefined, current: string | undefined, hasPriorUse: boolean): boolean {
  const baseline = previous ?? (hasPriorUse ? DATE_BEFORE_TRACKING : undefined);
  if (baseline === undefined || current === undefined || !DATE.test(baseline) || !DATE.test(current)) return false;
  return current > baseline;
}

/** VS Code finds an extension's changelog case-insensitively, and vsce packages it as `changelog.md`. */
export function findChangelogName(names: readonly string[]): string | undefined {
  return names.find(name => /^changelog\.md$/i.test(name));
}
