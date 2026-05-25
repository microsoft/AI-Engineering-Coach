import { describe, expect, it } from 'vitest';
import { createTeamModeApp } from './worker';

function createFakeDb() {
  const calls: { sql: string; values: unknown[] }[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              calls.push({ sql, values });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

describe('team mode ingest persistence', () => {
  it('stores only aggregate snapshot fields and deduplicates repeated uploads', async () => {
    const db = createFakeDb();
    const app = createTeamModeApp({
      env: {
        TEAM_MODE_BOOTSTRAP_SECRET: 'bootstrap-secret',
        DB: db,
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

    const joinBody = await joinResponse.json() as { token: string; developerId: string };

    const payload = {
      snapshot: {
        schemaVersion: 1 as const,
        developerId: joinBody.developerId,
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
          topViolations: [
            {
              key: 'no-file-context',
              label: 'No file context',
              count: 2,
              severity: 'medium' as const,
            },
          ],
        },
        weeklyTrend: {
          weekStartsOn: ['2026-05-11', '2026-05-18'],
          promptQuality: [81, 84],
          sessionHygiene: [74, 77],
          codeReview: [69, 72],
          toolMastery: [87, 89],
          contextManagement: [78, 80],
        },
      },
    };

    const firstResponse = await app.fetch('https://team.example/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${joinBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({ ok: true, inserted: true });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('INSERT INTO team_snapshots');
    expect(JSON.stringify(db.calls[0].values)).not.toContain('promptText');
    expect(JSON.stringify(db.calls[0].values)).not.toContain('sessionText');
    expect(JSON.stringify(db.calls[0].values)).not.toContain('fileName');
    expect(JSON.stringify(db.calls[0].values)).not.toContain('workspaceName');

    const secondResponse = await app.fetch('https://team.example/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${joinBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({ ok: true, inserted: false });
    expect(db.calls).toHaveLength(1);
  });
});
