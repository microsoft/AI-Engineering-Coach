/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { findChangelogName, shouldAnnounceUpdate, VERSION_BEFORE_TRACKING } from './whats-new';

describe('shouldAnnounceUpdate', () => {
  it('announces an upgrade from the recorded version', () => {
    expect(shouldAnnounceUpdate('0.2.0', '0.2.1', false)).toBe(true);
    expect(shouldAnnounceUpdate('0.9.0', '0.10.0', false)).toBe(true);
  });

  it('stays quiet for rebuilds of the same version and for downgrades', () => {
    expect(shouldAnnounceUpdate('0.2.0', '0.2.0', true)).toBe(false);
    expect(shouldAnnounceUpdate('0.4.0', '0.2.0', true)).toBe(false);
  });

  it('stays quiet on a fresh install', () => {
    expect(shouldAnnounceUpdate(undefined, '0.2.0', false)).toBe(false);
  });

  it('treats earlier dashboard use without a recorded version as an upgrade from the untracked release', () => {
    expect(VERSION_BEFORE_TRACKING).toBe('0.1.0');
    expect(shouldAnnounceUpdate(undefined, '0.2.0', true)).toBe(true);
    expect(shouldAnnounceUpdate(undefined, '0.1.0', true)).toBe(false);
  });

  it('ignores versions it cannot parse', () => {
    expect(shouldAnnounceUpdate('garbage', '0.2.0', true)).toBe(false);
    expect(shouldAnnounceUpdate('0.1.0', 'next', true)).toBe(false);
  });
});

describe('findChangelogName', () => {
  it('matches the packaged and the repository spelling', () => {
    expect(findChangelogName(['package.json', 'changelog.md', 'readme.md'])).toBe('changelog.md');
    expect(findChangelogName(['CHANGELOG.md', 'README.md'])).toBe('CHANGELOG.md');
  });

  it('returns undefined when there is no Markdown changelog', () => {
    expect(findChangelogName(['CHANGELOG.txt', 'changelog.md.bak', 'dist'])).toBeUndefined();
  });
});
