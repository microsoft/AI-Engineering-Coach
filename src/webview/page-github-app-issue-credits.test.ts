/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* noop */ },
    getState: () => null,
    setState: () => { /* noop */ },
  });
});

describe('GitHub App issue credits page', () => {
  it('renders rough relative percentages without absolute credit figures', async () => {
    const { renderGitHubAppIssueCredits } = await import('./page-github-app-issue-credits');
    const container = document.createElement('main');
    document.body.appendChild(container);

    expect(() => renderGitHubAppIssueCredits(container, {
      status: 'ready',
      metrics: {
        issues: [
          {
            repository: 'microsoft/AI-Engineering-Coach',
            issueNumber: 314,
            linkedSessionCount: 6,
            pricedSessionCount: 6,
            estimatedCredits: 180,
          },
          {
            repository: 'microsoft/AI-Engineering-Coach',
            issueNumber: 287,
            linkedSessionCount: 2,
            pricedSessionCount: 2,
            estimatedCredits: 60,
          },
        ],
        linkedSessionCount: 8,
        pricedSessionCount: 8,
        estimatedCredits: 240,
      },
    })).not.toThrow();

    expect(container.textContent).toContain('75.0%');
    expect(container.textContent).toContain('25.0%');
    expect(container.textContent).toContain('not accurate AI Credit or billing figures');
    expect(container.textContent).not.toContain('180');
    expect(container.textContent).not.toContain('240');
    const avatar = container.querySelector<HTMLImageElement>('.gha-org-avatar img');
    expect(avatar?.src).toBe('https://github.com/microsoft.png?size=52');
    expect(avatar?.getAttribute('referrer' + 'policy')).toBe('no-referrer');
  });
});
