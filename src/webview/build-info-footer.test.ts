/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo } from '../core/build-info';
import { mountBuildInfoFooter, setBuildInfoStatus } from './build-info-footer';

const DEV: BuildInfo = { version: '0.2.0', commit: 'def5678', dirty: true, branch: 'feat/stamp', builtAt: '2026-10-31T11:15:02.000Z', dev: true };
const RELEASE: BuildInfo = { version: '0.2.0', commit: 'abc1234', dirty: false, branch: '', builtAt: '2026-11-03T09:30:12.345Z', dev: false };

let sidebar: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<nav id="sidebar"><ul class="nav-links"></ul><div class="sidebar-filters"></div></nav>';
  sidebar = document.getElementById('sidebar')!;
});

describe('mountBuildInfoFooter', () => {
  it('appends the stamp after the filters with the full details in its tooltip', () => {
    const footer = mountBuildInfoFooter(sidebar, DEV);
    expect(sidebar.lastElementChild).toBe(footer);
    expect(footer.id).toBe('build-info');
    expect(footer.querySelector('.build-info-version')?.textContent).toBe('v0.2.0 dev');
    expect(footer.querySelector('.build-info-dev')?.textContent).toBe('dev');
    expect(footer.querySelector('.build-info-meta')?.textContent).toBe('def5678-dirty · 2026-10-31 11:15 UTC');
    expect(footer.title).toBe(
      'AI Engineer Coach 0.2.0 (dev build)\nCommit def5678 with uncommitted changes\nBranch feat/stamp\nBuilt 2026-10-31 11:15 UTC');
    expect(document.getElementById('build-info-status')?.hidden).toBe(true);
  });

  it('shows release builds without the dev badge', () => {
    const footer = mountBuildInfoFooter(sidebar, RELEASE);
    expect(footer.querySelector('.build-info-version')?.textContent).toBe('v0.2.0');
    expect(footer.querySelector('.build-info-dev')).toBeNull();
    expect(footer.querySelector('.build-info-meta')?.textContent).toBe('abc1234 · 2026-11-03 09:30 UTC');
  });

  it('replaces an existing footer instead of stacking another one', () => {
    mountBuildInfoFooter(sidebar, DEV);
    mountBuildInfoFooter(sidebar, RELEASE);
    expect(sidebar.querySelectorAll('#build-info')).toHaveLength(1);
    expect(sidebar.querySelector('.build-info-meta')?.textContent).toContain('abc1234');
  });

  it('renders untrusted values as text', () => {
    const footer = mountBuildInfoFooter(sidebar, { ...DEV, version: '<img src=x onerror=alert(1)>', commit: '<b>x</b>' });
    expect(footer.querySelector('img, b')).toBeNull();
    expect(footer.querySelector('.build-info-version')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('setBuildInfoStatus', () => {
  it('shows a notice with one action and hides it again', () => {
    mountBuildInfoFooter(sidebar, RELEASE);
    const onAction = vi.fn();
    setBuildInfoStatus({ text: 'v0.4.0 is available', title: 'Released 2026-12-01', actionLabel: 'Install', onAction });
    const slot = document.getElementById('build-info-status')!;
    expect(slot.hidden).toBe(false);
    expect(slot.title).toBe('Released 2026-12-01');
    expect(slot.querySelector('.build-info-status-text')?.textContent).toBe('v0.4.0 is available');
    const action = slot.querySelector<HTMLButtonElement>('button.build-info-action')!;
    expect(action.textContent).toBe('Install');
    action.click();
    expect(onAction).toHaveBeenCalledOnce();

    setBuildInfoStatus({ text: 'Checking for updates…' });
    expect(slot.querySelector('button')).toBeNull();
    expect(slot.textContent).toBe('Checking for updates…');

    setBuildInfoStatus(null);
    expect(slot.hidden).toBe(true);
    expect(slot.childElementCount).toBe(0);
  });

  it('does nothing before the footer is mounted', () => {
    expect(() => setBuildInfoStatus({ text: 'ignored' })).not.toThrow();
  });
});
