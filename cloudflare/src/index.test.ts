import { describe, expect, it } from 'vitest';
import { buildTeamSchemaStatements } from './schema';
import { createTeamModeApp } from './worker';

describe('team mode backend contract', () => {
  it('bootstraps the first admin and returns only admin token metadata', async () => {
    const app = createTeamModeApp({
      env: {
        TEAM_MODE_BOOTSTRAP_SECRET: 'bootstrap-secret',
      },
    });

    const response = await app.fetch('https://team.example/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverName: 'Platform Team',
        adminLabel: 'Lead',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      serverId: expect.any(String),
      role: 'admin',
      token: expect.any(String),
    });
  });

  it('requires admin access to create invite codes and lets members join with a one-time code', async () => {
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

    expect(bootstrapResponse.status).toBe(200);
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

    expect(inviteResponse.status).toBe(200);
    const inviteBody = await inviteResponse.json() as { inviteCode: string };
    expect(inviteBody).toEqual({
      inviteCode: expect.any(String),
      expiresAtMs: expect.any(Number),
    });

    const joinResponse = await app.fetch('https://team.example/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteCode: inviteBody.inviteCode,
        developerId: 'dev-123',
      }),
    });

    expect(joinResponse.status).toBe(200);
    expect(await joinResponse.json()).toEqual({
      developerId: 'dev-123',
      role: 'member',
      token: expect.any(String),
    });
  });

  it('rejects snapshot payloads that include raw text fields', async () => {
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

    expect(bootstrapResponse.status).toBe(200);
    const bootstrapBody = await bootstrapResponse.json() as { token: string };

    const response = await app.fetch('https://team.example/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrapBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        developerId: 'admin',
        capturedAtMs: 1710000000000,
        windowStartMs: 1709395200000,
        windowEndMs: 1710000000000,
        categoryScores: {
          promptQuality: 82,
          sessionHygiene: 76,
          codeReview: 71,
          toolMastery: 88,
          contextManagement: 79,
        },
        tokenUsage: {
          inputTokens: 2200,
          outputTokens: 1100,
          totalTokens: 3300,
        },
        antiPatterns: {
          total: 4,
          bySeverity: { low: 1, medium: 2, high: 1 },
          byGroup: {},
          topViolations: [],
        },
        weeklyTrend: {
          weekStartsOn: ['2026-05-11', '2026-05-18'],
          promptQuality: [81, 84],
          sessionHygiene: [74, 77],
          codeReview: [69, 72],
          toolMastery: [87, 89],
          contextManagement: [78, 80],
        },
        rawPromptText: 'should never leave the machine',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('keeps the storage schema limited to aggregate team data', () => {
    const statements = buildTeamSchemaStatements().join('\n');

    expect(statements).toContain('team_servers');
    expect(statements).toContain('team_members');
    expect(statements).toContain('team_invitations');
    expect(statements).toContain('team_snapshots');
    expect(statements).not.toContain('prompt_text');
    expect(statements).not.toContain('session_text');
    expect(statements).not.toContain('file_name');
    expect(statements).not.toContain('workspace_name');
  });
});
