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
  it('renders credit totals above 100 without invalid number options', async () => {
    const { renderGitHubAppIssueCredits } = await import('./page-github-app-issue-credits');
    const container = document.createElement('main');
    document.body.appendChild(container);

    expect(() => renderGitHubAppIssueCredits(container, {
      status: 'ready',
      metrics: {
        issues: [{
          repository: 'microsoft/AI-Engineering-Coach',
          issueNumber: 314,
          linkedSessionCount: 6,
          pricedSessionCount: 6,
          estimatedCredits: 184.72,
        }],
        linkedSessionCount: 6,
        pricedSessionCount: 6,
        estimatedCredits: 360.31,
      },
    })).not.toThrow();

    expect(container.textContent).toContain('360.3');
    expect(container.textContent).toContain('184.7');
    const avatar = container.querySelector<HTMLImageElement>('.gha-org-avatar img');
    expect(avatar?.src).toBe('https://github.com/microsoft.png?size=52');
    expect(avatar?.getAttribute('referrer' + 'policy')).toBe('no-referrer');
  });
});
