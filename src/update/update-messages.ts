/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* What "Check for Updates" tells the user about each outcome. Automatic checks never show
 * these: they stay silent unless a newer release can be offered. */

import type { FeedResult, UpdateCandidate } from './release-feed';
import { isNewerVersion } from './update-policy';

export type CheckReport =
  /** A newer release exists: show the update notification. */
  | { kind: 'offer'; release: UpdateCandidate }
  | { kind: 'info'; message: string }
  /** Something went wrong; `Open Release Page` is offered next to the message. */
  | { kind: 'warning'; message: string; offerReleasesPage: boolean };

const NOTHING_RELEASED = 'No AI Engineer Coach releases have been published yet.';

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** `release` is the cached release after the check, for 304 responses that carry no body. */
export function describeManualCheck(
  result: FeedResult,
  release: UpdateCandidate | undefined,
  current: string,
  formatTime: (epochMs: number) => string = formatClockTime,
): CheckReport {
  switch (result.kind) {
    case 'release':
    case 'not-modified':
      if (!release) return { kind: 'info', message: NOTHING_RELEASED };
      if (isNewerVersion(release.version, current)) return { kind: 'offer', release };
      if (isNewerVersion(current, release.version)) {
        return { kind: 'info', message: `This build (v${current}) is newer than the latest AI Engineer Coach release (v${release.version}).` };
      }
      return { kind: 'info', message: `AI Engineer Coach is up to date (v${current}).` };
    case 'no-release':
      return { kind: 'info', message: NOTHING_RELEASED };
    case 'rate-limited':
      return {
        kind: 'warning',
        message: `GitHub's limit for anonymous requests was reached. Try again after ${formatTime(result.retryAt)}.`,
        offerReleasesPage: false,
      };
    case 'invalid':
      return { kind: 'warning', message: `The latest AI Engineer Coach release can't be used: ${result.reason}.`, offerReleasesPage: true };
    case 'error':
      return { kind: 'warning', message: `Couldn't check for AI Engineer Coach updates: ${result.message}.`, offerReleasesPage: true };
  }
}
