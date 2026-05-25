/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* noop */ },
    getState: () => null,
    setState: () => { /* noop */ },
  });
});

describe('team dashboard page scaffold', () => {
  it('renders the team dashboard shell and export action', async () => {
    const { renderTeamDashboard } = await import('./page-team-dashboard');
    const host = document.createElement('div');
    renderTeamDashboard(host);

    expect(host.querySelector('.team-dashboard-title')?.textContent).toBe('Team Dashboard');
    expect(host.querySelector('[data-action="export-pdf"]')).not.toBeNull();
    expect(host.querySelector('.team-dashboard-filters')).not.toBeNull();
  });
});

