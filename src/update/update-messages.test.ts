/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { toUpdateCandidate, type UpdateCandidate } from './release-feed';
import { describeManualCheck } from './update-messages';
import { releaseJson } from './test-fixtures';

function release(version: string): UpdateCandidate {
  const result = toUpdateCandidate(releaseJson(version));
  if (!result.ok) throw new Error(result.reason);
  return result.candidate;
}

describe('describeManualCheck', () => {
  it('offers a newer release, including one confirmed by a 304', () => {
    const latest = release('0.4.0');
    expect(describeManualCheck({ kind: 'release', candidate: latest }, latest, '0.2.0')).toEqual({ kind: 'offer', release: latest });
    expect(describeManualCheck({ kind: 'not-modified' }, latest, '0.2.0')).toEqual({ kind: 'offer', release: latest });
  });

  it('confirms an up-to-date or newer build', () => {
    expect(describeManualCheck({ kind: 'not-modified' }, release('0.2.0'), '0.2.0'))
      .toEqual({ kind: 'info', message: 'AI Engineer Coach is up to date (v0.2.0).' });
    expect(describeManualCheck({ kind: 'not-modified' }, release('0.2.0'), '0.3.1'))
      .toEqual({ kind: 'info', message: 'This build (v0.3.1) is newer than the latest AI Engineer Coach release (v0.2.0).' });
  });

  it('explains that nothing has been released', () => {
    const expected = { kind: 'info', message: 'No AI Engineer Coach releases have been published yet.' };
    expect(describeManualCheck({ kind: 'no-release' }, undefined, '0.2.0')).toEqual(expected);
    expect(describeManualCheck({ kind: 'not-modified' }, undefined, '0.2.0')).toEqual(expected);
  });

  it('reports failures, offering the releases page where it can help', () => {
    expect(describeManualCheck({ kind: 'rate-limited', retryAt: 0 }, undefined, '0.2.0', () => '14:05')).toEqual({
      kind: 'warning', message: "GitHub's limit for anonymous requests was reached. Try again after 14:05.", offerReleasesPage: false,
    });
    expect(describeManualCheck({ kind: 'invalid', reason: 'the latest release tag is not vX.Y.Z' }, undefined, '0.2.0')).toEqual({
      kind: 'warning', message: "The latest AI Engineer Coach release can't be used: the latest release tag is not vX.Y.Z.", offerReleasesPage: true,
    });
    expect(describeManualCheck({ kind: 'error', message: 'the request timed out' }, undefined, '0.2.0')).toEqual({
      kind: 'warning', message: "Couldn't check for AI Engineer Coach updates: the request timed out.", offerReleasesPage: true,
    });
  });
});
