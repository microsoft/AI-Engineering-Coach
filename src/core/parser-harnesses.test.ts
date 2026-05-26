/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CONFIG_DIRS_ENV } from './harness-config-roots';
import { collectExternalHarnessesSync } from './parser-harnesses';
import { Session, Workspace } from './types';

function writeClaudeSession(projectsDir: string, sessionId: string): void {
  const projectDir = path.join(projectsDir, '-Users-me-story-book');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [
    {
      type: 'user',
      timestamp: '2026-05-26T10:00:00Z',
      sessionId,
      cwd: '/Users/me/story-book',
      entrypoint: 'cli',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-26T10:00:01Z',
      sessionId,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'), 'utf-8');
}

function withClaudeEnv(run: () => void): void {
  const original = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    [CLAUDE_CONFIG_DIRS_ENV]: process.env[CLAUDE_CONFIG_DIRS_ENV],
  };
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('collectExternalHarnessesSync', () => {
  it('deduplicates Claude sessions copied across multiple config roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-harness-dedupe-'));
    const home = path.join(root, 'home');
    const defaultProjects = path.join(home, '.claude', 'projects');
    const workRoot = path.join(root, '.claude-work');
    const workProjects = path.join(workRoot, 'projects');
    const sessionId = '11111111-1111-4111-8111-111111111111';

    try {
      withClaudeEnv(() => {
        writeClaudeSession(defaultProjects, sessionId);
        writeClaudeSession(workProjects, sessionId);

        process.env.HOME = home;
        delete process.env.USERPROFILE;
        delete process.env.CLAUDE_CONFIG_DIR;
        process.env[CLAUDE_CONFIG_DIRS_ENV] = JSON.stringify([workRoot]);

        const workspaces = new Map<string, Workspace>();
        const sessions: Session[] = [];
        collectExternalHarnessesSync(workspaces, sessions);

        const claudeSessions = sessions.filter(session => session.harness === 'Claude');
        expect(claudeSessions).toHaveLength(1);
        expect(claudeSessions[0].sessionId).toBe(sessionId);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
