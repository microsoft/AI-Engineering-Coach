/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { describe, expect, it } from 'vitest';
import {
  BUILD_INFO,
  formatBuildDetails,
  formatBuildLogFields,
  formatBuildTime,
  formatBuildTooltip,
  formatCommit,
  type BuildInfo,
} from './build-info';

const CLEAN: BuildInfo = { version: '0.2.0', commit: 'abc1234', dirty: false, branch: 'main', builtAt: '2026-11-03T09:30:12.345Z' };
const EDITED: BuildInfo = { version: '0.2.0', commit: 'def5678', dirty: true, branch: 'feat/stamp', builtAt: '2026-10-31T11:15:02.000Z' };

describe('BUILD_INFO', () => {
  it('falls back to a frozen placeholder when esbuild did not inject a stamp', () => {
    expect(BUILD_INFO).toEqual({ version: '0.0.0', commit: 'unknown', dirty: false, branch: '', builtAt: '' });
    expect(Object.isFrozen(BUILD_INFO)).toBe(true);
  });
});

describe('build labels', () => {
  it('marks dirty commits', () => {
    expect(formatCommit(CLEAN)).toBe('abc1234');
    expect(formatCommit(EDITED)).toBe('def5678-dirty');
  });

  it('formats the build time in UTC without depending on the locale', () => {
    expect(formatBuildTime('2026-10-31T11:15:02.000Z')).toBe('2026-10-31 11:15 UTC');
    expect(formatBuildTime('')).toBe('');
  });

  it('summarizes the build on one line', () => {
    expect(formatBuildDetails(CLEAN)).toBe('v0.2.0 · abc1234 · main · built 2026-11-03 09:30 UTC');
    expect(formatBuildDetails(EDITED)).toBe('v0.2.0 · def5678-dirty · feat/stamp · built 2026-10-31 11:15 UTC');
    expect(formatBuildDetails(BUILD_INFO)).toBe('v0.0.0 · unknown');
  });

  it('describes the build for tooltips', () => {
    expect(formatBuildTooltip(EDITED)).toBe(
      'AI Engineer Coach 0.2.0\nCommit def5678 with uncommitted changes\nBranch feat/stamp\nBuilt 2026-10-31 11:15 UTC');
    expect(formatBuildTooltip({ ...CLEAN, branch: '' })).toBe('AI Engineer Coach 0.2.0\nCommit abc1234\nBuilt 2026-11-03 09:30 UTC');
  });

  it('writes parseable key=value fields for runtime.log', () => {
    expect(formatBuildLogFields(EDITED)).toBe(
      'version=0.2.0 commit=def5678 dirty=true branch=feat/stamp builtAt=2026-10-31T11:15:02.000Z');
    expect(formatBuildLogFields(BUILD_INFO)).toBe('version=0.0.0 commit=unknown dirty=false branch=- builtAt=-');
  });
});
