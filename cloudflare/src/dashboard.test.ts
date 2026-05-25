import { describe, expect, it } from 'vitest';
import { createTeamModeApp } from './worker';

function makeSnapshot(developerId: string, promptQuality: number, totalTokens: number) {
  return {
    snapshot: {
      schemaVersion: 1 as const,
      developerId,
      capturedAtMs: 1710000000000,
      windowStartMs: 1709395200000,
      windowEndMs: 1710000000000,
      categoryScores: {
        promptQuality,
        sessionHygiene: 76,
        codeReview: 71,
        toolMastery: 88,
        contextManagement: 79,
      },
      tokenUsage: {
        inputTokens: Math.floor(totalTokens * 0.66),
        outputTokens: Math.floor(totalTokens * 0.34),
        totalTokens,
      },
      antiPatterns: {
        total: 4,
        bySeverity: { low: 1, medium: 2, high: 1 },
        byGroup: {},
        topViolations: [
          { key: 'no-file-context', label: 'No file context', count: 2, severity: 'medium' as const },
        ],
      },
      weeklyTrend: {
        weekStartsOn: ['2026-05-11', '2026-05-18'],
        promptQuality: [promptQuality - 1, promptQuality],
        sessionHygiene: [74, 77],
        codeReview: [69, 72],
        toolMastery: [87, 89],
        contextManagement: [78, 80],
      },
    },
  };
}

describe('team mode dashboard read contract', () => {
  it('rejects dashboard reads without a token', async () => {
    const app = createTeamModeApp({
      env: {
        TEAM_MODE_BOOTSTRAP_SECRET: 'bootstrap-secret',
      },
    });

    const response = await app.fetch('https://team.example/dashboard', { method: 'GET' });
    expect(response.status).toBe(401);
  });

  it('returns all developers for admin and self-only results for members', async () => {
    const app = createTeamModeApp({
      env: {
        TEAM_MODE_BOOTSTRAP_SECRET: 'bootstrap-secret',
      },
    });

    const bootstrapResponse = await app.fetch('https://team.example/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverName: 'Platform Team',
        adminLabel: 'Lead',
      }),
    });
    const bootstrapBody = await bootstrapResponse.json() as { token: string };

    const inviteResponse = await app.fetch('https://team.example/invite', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrapBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        label: 'Mobile Dev',
        expiresInHours: 72,
      }),
    });
    const inviteBody = await inviteResponse.json() as { inviteCode: string };

    const joinResponse = await app.fetch('https://team.example/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteCode: inviteBody.inviteCode,
        developerId: 'dev-123',
      }),
    });
    const joinBody = await joinResponse.json() as { token: string };

    await app.fetch('https://team.example/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrapBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(makeSnapshot('admin', 90, 4200)),
    });

    await app.fetch('https://team.example/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${joinBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(makeSnapshot('dev-123', 73, 2100)),
    });

    const adminResponse = await app.fetch('https://team.example/dashboard?category=prompt-quality&from=1709395200000&to=1710000000000', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${bootstrapBody.token}`,
      },
    });

    expect(adminResponse.status).toBe(200);
    const adminBody = await adminResponse.json() as {
      access: { role: string; developerId: string; canExportPdf: boolean };
      filters: { category: string; fromMs: number; toMs: number };
      developers: Array<{ developerId: string; categoryScores: { promptQuality: number } }>;
    };
    expect(adminBody.access).toEqual({
      role: 'admin',
      developerId: 'admin',
      canExportPdf: true,
    });
    expect(adminBody.filters).toEqual({
      category: 'prompt-quality',
      fromMs: 1709395200000,
      toMs: 1710000000000,
    });
    expect(adminBody.developers).toHaveLength(2);
    expect(adminBody.developers.map((row) => row.developerId)).toEqual(['admin', 'dev-123']);

    const memberResponse = await app.fetch('https://team.example/dashboard?developerId=dev-123', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${joinBody.token}`,
      },
    });

    expect(memberResponse.status).toBe(200);
    const memberBody = await memberResponse.json() as {
      access: { role: string; developerId: string; canExportPdf: boolean };
      developers: Array<{ developerId: string; categoryScores: { promptQuality: number } }>;
    };
    expect(memberBody.access).toEqual({
      role: 'member',
      developerId: 'dev-123',
      canExportPdf: false,
    });
    expect(memberBody.developers).toHaveLength(1);
    expect(memberBody.developers[0].developerId).toBe('dev-123');
  });
});
