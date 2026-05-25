import { describe, expect, it } from 'vitest';
import { createTeamModeApp } from './worker';

describe('team mode bootstrap', () => {
  it('creates the first admin and returns only the bootstrap metadata', async () => {
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
});
