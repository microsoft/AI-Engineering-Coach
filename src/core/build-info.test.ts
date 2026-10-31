/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
  BUILD_INFO,
  compareVersions,
  formatBuildDetails,
  formatBuildLogFields,
  formatBuildTime,
  formatBuildTooltip,
  formatCommit,
  formatVersionLabel,
  parseVersion,
  type BuildInfo,
} from './build-info';

const RELEASE: BuildInfo = { version: '0.2.0', commit: 'abc1234', dirty: false, branch: '', builtAt: '2026-11-03T09:30:12.345Z', dev: false };
const DEV: BuildInfo = { version: '0.2.0', commit: 'def5678', dirty: true, branch: 'feat/stamp', builtAt: '2026-10-31T11:15:02.000Z', dev: true };

describe('BUILD_INFO', () => {
  it('falls back to a frozen placeholder when esbuild did not inject a stamp', () => {
    expect(BUILD_INFO).toEqual({ version: '0.0.0', commit: 'unknown', dirty: false, branch: '', builtAt: '', dev: true });
    expect(Object.isFrozen(BUILD_INFO)).toBe(true);
  });
});

describe('version comparison', () => {
  it('parses major.minor.patch with an optional v prefix and suffix', () => {
    expect(parseVersion('0.2.0')).toEqual([0, 2, 0]);
    expect(parseVersion(' v1.10.3 ')).toEqual([1, 10, 3]);
    expect(parseVersion('0.3.0-beta.1')).toEqual([0, 3, 0]);
    expect(parseVersion('0.3.0+abc1234')).toEqual([0, 3, 0]);
  });

  it('rejects anything else', () => {
    for (const value of ['', '1.2', 'latest', '1.2.3.4', 'v1.2.x']) expect(parseVersion(value)).toBeUndefined();
  });

  it('compares numerically rather than lexically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.2.0', 'v0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(() => compareVersions('0.2.0', 'next')).toThrow('Cannot compare');
  });
});

describe('build labels', () => {
  it('marks dev builds and dirty commits', () => {
    expect(formatVersionLabel(RELEASE)).toBe('v0.2.0');
    expect(formatVersionLabel(DEV)).toBe('v0.2.0 (dev)');
    expect(formatCommit(RELEASE)).toBe('abc1234');
    expect(formatCommit(DEV)).toBe('def5678-dirty');
  });

  it('formats the build time in UTC without depending on the locale', () => {
    expect(formatBuildTime('2026-10-31T11:15:02.000Z')).toBe('2026-10-31 11:15 UTC');
    expect(formatBuildTime('')).toBe('');
  });

  it('summarizes the build on one line', () => {
    expect(formatBuildDetails(RELEASE)).toBe('v0.2.0 · abc1234 · built 2026-11-03 09:30 UTC');
    expect(formatBuildDetails(DEV)).toBe('v0.2.0 (dev) · def5678-dirty · feat/stamp · built 2026-10-31 11:15 UTC');
    expect(formatBuildDetails(BUILD_INFO)).toBe('v0.0.0 (dev) · unknown');
  });

  it('describes the build for tooltips', () => {
    expect(formatBuildTooltip(DEV)).toBe(
      'AI Engineer Coach 0.2.0 (dev build)\nCommit def5678 with uncommitted changes\nBranch feat/stamp\nBuilt 2026-10-31 11:15 UTC');
    expect(formatBuildTooltip(RELEASE)).toBe('AI Engineer Coach 0.2.0 (release build)\nCommit abc1234\nBuilt 2026-11-03 09:30 UTC');
  });

  it('writes parseable key=value fields for runtime.log', () => {
    expect(formatBuildLogFields(DEV)).toBe(
      'version=0.2.0 commit=def5678 dirty=true dev=true branch=feat/stamp builtAt=2026-10-31T11:15:02.000Z');
    expect(formatBuildLogFields(BUILD_INFO)).toBe('version=0.0.0 commit=unknown dirty=false dev=true branch=- builtAt=-');
  });
});
