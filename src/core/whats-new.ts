/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Decides when to announce release notes after an update. VS Code glue: src/whats-new-vscode.ts. */

import { compareVersions, parseVersion } from './build-info';

/** The last release before the extension recorded which version a user had seen. */
export const VERSION_BEFORE_TRACKING = '0.1.0';

/**
 * Announce only real upgrades: never on a fresh install, a downgrade, or a rebuild of the
 * same version. Without a recorded version, earlier use of the dashboard (`hasPriorUse`)
 * means the user upgraded from {@link VERSION_BEFORE_TRACKING}.
 */
export function shouldAnnounceUpdate(previous: string | undefined, current: string, hasPriorUse: boolean): boolean {
  const baseline = previous ?? (hasPriorUse ? VERSION_BEFORE_TRACKING : undefined);
  if (baseline === undefined || !parseVersion(baseline) || !parseVersion(current)) return false;
  return compareVersions(current, baseline) > 0;
}

/** VS Code finds an extension's changelog case-insensitively, and vsce packages it as `changelog.md`. */
export function findChangelogName(names: readonly string[]): string | undefined {
  return names.find(name => /^changelog\.md$/i.test(name));
}
