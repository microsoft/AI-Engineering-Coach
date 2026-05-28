/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, beforeAll, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('./shared', async () => {
  const actual = await vi.importActual<typeof import('./shared')>('./shared');
  return {
    ...actual,
    rpc: rpcMock,
  };
});

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
    rpcMock.mockResolvedValue({
      filters: {},
      selectedCategory: 'all',
      aggregation: {
        granularity: 'weekly',
        detailLevel: 'category-only',
        label: 'Weekly rollup',
        bucketCount: 1,
      },
      totalDevelopers: 0,
      totalSnapshots: 0,
      importedSnapshots: 0,
      availableDevelopers: [],
      developers: [],
      hasSnapshots: false,
      lastImportedAtMs: null,
    });
    renderTeamDashboard(host);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector('.team-dashboard-title')?.textContent).toBe('Team Dashboard');
    expect(host.querySelector('[data-action="export-pdf"]')).not.toBeNull();
    expect(host.querySelector('.team-dashboard-filters')).not.toBeNull();
    expect(host.querySelector('.team-dashboard-mode-chip')?.textContent).toBe('Weekly rollup');

    window.dispatchEvent(new CustomEvent('aiEngineerCoach:teamModeSettingsChanged'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });
});
