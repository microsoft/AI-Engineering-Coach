import { describe, expect, it, vi } from 'vitest';
import { TeamDashboardClient } from './team-dashboard-client';

describe('TeamDashboardClient', () => {
  it('throws when no auth state is available', async () => {
    const client = new TeamDashboardClient({
      fetchImpl: vi.fn(),
      getAuthState: () => null,
    });

    await expect(client.fetchDashboard({ category: 'prompt-quality' })).rejects.toThrow('Team Mode auth is not configured');
  });

  it('loads dashboard data with the current auth token and filters', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://team.example/dashboard?developerId=dev-123&from=1709395200000&to=1710000000000&category=prompt-quality');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer token-abc',
        'content-type': 'application/json',
      });
      return new Response(JSON.stringify({
        access: { role: 'admin', developerId: 'admin', canExportPdf: true },
        filters: { developerId: 'dev-123', fromMs: 1709395200000, toMs: 1710000000000, category: 'prompt-quality' },
        selectedCategory: 'prompt-quality',
        totalDevelopers: 1,
        developers: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new TeamDashboardClient({
      fetchImpl: fetchImpl as typeof fetch,
      getAuthState: () => ({
        serverUrl: 'https://team.example',
        serverId: 'server-123',
        developerId: 'admin',
        accessToken: 'token-abc',
        role: 'admin',
        savedAt: Date.now(),
      }),
    });

    const result = await client.fetchDashboard({
      developerId: 'dev-123',
      fromMs: 1709395200000,
      toMs: 1710000000000,
      category: 'prompt-quality',
    });

    expect(result.access.role).toBe('admin');
    expect(result.selectedCategory).toBe('prompt-quality');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

