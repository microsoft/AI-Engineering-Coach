/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { toUpdateCandidate, type UpdateCandidate } from './release-feed';
import { automaticChecksEnabled, cooldownFromSetting, evaluateUpdate, isNewerVersion, type EvaluateInput } from './update-policy';
import { releaseJson } from './test-fixtures';

const HOUR = 60 * 60 * 1000;
const PUBLISHED = Date.parse('2026-10-01T12:00:00Z');

function candidate(version: string, options: Parameters<typeof releaseJson>[1] = {}): UpdateCandidate {
  const result = toUpdateCandidate(releaseJson(version, options));
  if (!result.ok) throw new Error(result.reason);
  return result.candidate;
}

function input(patch: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    candidate: candidate('0.4.0'),
    current: '0.2.0',
    markers: {},
    automatic: true,
    cooldownMs: 12 * HOUR,
    now: PUBLISHED + 13 * HOUR,
    ...patch,
  };
}

const available = {
  state: 'available', current: '0.2.0', latest: '0.4.0', publishedAt: '2026-10-01T12:00:00.000Z', canInstall: true,
};

describe('automaticChecksEnabled', () => {
  const on = { production: true, dev: false, autoCheck: true, vscodeAutoCheck: true };

  it('checks only release builds in production with both settings on', () => {
    expect(automaticChecksEnabled(on)).toBe(true);
    expect(automaticChecksEnabled({ ...on, production: false })).toBe(false);
    expect(automaticChecksEnabled({ ...on, dev: true })).toBe(false);
    expect(automaticChecksEnabled({ ...on, autoCheck: false })).toBe(false);
    expect(automaticChecksEnabled({ ...on, vscodeAutoCheck: false })).toBe(false);
  });
});

describe('evaluateUpdate', () => {
  it('offers a newer release once', () => {
    expect(evaluateUpdate(input())).toEqual({ status: available, notify: true });
    expect(evaluateUpdate(input({ markers: { notifiedVersion: '0.4.0' } }))).toEqual({ status: available, notify: false });
    expect(evaluateUpdate(input({ markers: { notifiedVersion: '0.3.0' } })).notify).toBe(true);
  });

  it('shows nothing without a newer stable release', () => {
    const none = { status: { state: 'none' }, notify: false };
    expect(evaluateUpdate(input({ candidate: undefined }))).toEqual(none);
    expect(evaluateUpdate(input({ current: '0.4.0' }))).toEqual(none);
    expect(evaluateUpdate(input({ current: '0.5.1' }))).toEqual(none);
    expect(evaluateUpdate(input({ current: 'unknown' }))).toEqual(none);
  });

  it('waits for VS Code\'s extension update delay before announcing a release', () => {
    expect(evaluateUpdate(input({ now: PUBLISHED + HOUR }))).toEqual({ status: { state: 'none' }, notify: false });
    expect(evaluateUpdate(input({ now: PUBLISHED + HOUR, cooldownMs: 0 })).notify).toBe(true);
  });

  it('respects Skip This Version until a newer release appears', () => {
    expect(evaluateUpdate(input({ markers: { skippedVersion: '0.4.0' } })).status).toEqual({ state: 'none' });
    expect(evaluateUpdate(input({ markers: { skippedVersion: '0.3.0' } })).status).toEqual(available);
  });

  it('shows cached results only while automatic checks are on, unless a manual check revealed them', () => {
    expect(evaluateUpdate(input({ automatic: false })).status).toEqual({ state: 'none' });
    const revealed = evaluateUpdate(input({
      automatic: false, revealedVersion: '0.4.0', now: PUBLISHED + HOUR, markers: { skippedVersion: '0.4.0' },
    }));
    expect(revealed).toEqual({ status: available, notify: false });
  });

  it('reports a pending reload after an install', () => {
    expect(evaluateUpdate(input({ markers: { installedVersion: '0.4.0' } })))
      .toEqual({ status: { state: 'installed', latest: '0.4.0' }, notify: false });
    expect(evaluateUpdate(input({ current: '0.4.0', candidate: undefined, markers: { installedVersion: '0.4.0' } })).status)
      .toEqual({ state: 'none' });
  });

  it('marks releases that need a manual download', () => {
    expect(evaluateUpdate(input({ candidate: candidate('0.4.0', { immutable: false }) })).status)
      .toEqual({ ...available, canInstall: false });
  });
});

describe('isNewerVersion', () => {
  it('compares X.Y.Z numerically and never throws', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('garbage', '0.2.0')).toBe(false);
  });
});

describe('cooldownFromSetting', () => {
  it('reads extensions.autoUpdateDelay hours', () => {
    expect(cooldownFromSetting(undefined)).toBe(12 * HOUR);
    expect(cooldownFromSetting('6')).toBe(12 * HOUR);
    expect(cooldownFromSetting(0)).toBe(0);
    expect(cooldownFromSetting(-3)).toBe(0);
    expect(cooldownFromSetting(1.5)).toBe(1.5 * HOUR);
    expect(cooldownFromSetting(Number.POSITIVE_INFINITY)).toBe(12 * HOUR);
    expect(cooldownFromSetting(10_000)).toBe(24 * 30 * HOUR);
  });
});
