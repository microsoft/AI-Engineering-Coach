/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for external-harness source discovery used by the dashboard load gate,
 * so a host with only non-VS Code logs (e.g. Claude Code on a headless
 * Remote-SSH box, with no VS Code/Copilot directories) still loads. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { hasExternalHarnessSources, registerExternalHarnessSources } from './parser-harnesses';
import { createRequest } from './parser-shared';
import type { SessionSource } from './cache';
import type { Session } from './types';

function makeSession(over: Partial<Session>): Session {
  return {
    sessionId: 's1', workspaceId: 'w1', workspaceName: 'proj', location: 'terminal',
    harness: 'Claude', creationDate: 0, lastMessageDate: 0, requestCount: 0, requests: [],
    ...over,
  };
}

function setEnv(key: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

/** Run `body` with HOME/USERPROFILE pointed at a fresh temp dir, restoring the
 *  previous values (and removing the temp dir) afterwards. Self-contained so it
 *  leaks no env state across tests. */
function withHome(setup: (home: string) => void, body: () => void): void {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    setup(home);
    body();
  } finally {
    setEnv('HOME', prevHome);
    setEnv('USERPROFILE', prevUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('hasExternalHarnessSources', () => {
  it('returns false when no external-harness directories exist', () => {
    withHome(() => { /* empty home */ }, () => {
      expect(hasExternalHarnessSources()).toBe(false);
    });
  });

  it('returns true when a Claude Code projects directory exists', () => {
    withHome(home => {
      fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    }, () => {
      expect(hasExternalHarnessSources()).toBe(true);
    });
  });

  it('returns false when no home directory is set (avoids relative-path probing)', () => {
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    setEnv('HOME', undefined);
    setEnv('USERPROFILE', undefined);
    try {
      expect(hasExternalHarnessSources()).toBe(false);
    } finally {
      setEnv('HOME', prevHome);
      setEnv('USERPROFILE', prevUserProfile);
    }
  });
});

describe('registerExternalHarnessSources', () => {
  it('registers a single-file harness session keyed by its on-disk source path', () => {
    const index = new Map<string, SessionSource>();
    registerExternalHarnessSources(
      [makeSession({ sessionId: 'c1', harness: 'Claude', sourceFilePath: '/home/me/.claude/projects/p/c1.jsonl' })],
      index,
    );
    expect(index.get('c1')).toEqual({
      kind: 'claude-session-file',
      filePath: '/home/me/.claude/projects/p/c1.jsonl',
      workspaceId: 'w1',
      workspaceName: 'proj',
      harness: 'Claude',
    });
  });

  it('skips sessions that carry no source file path (e.g. Codex / OpenCode)', () => {
    const index = new Map<string, SessionSource>();
    registerExternalHarnessSources([makeSession({ sessionId: 'x1', harness: 'Codex' })], index);
    expect(index.has('x1')).toBe(false);
  });

  it('registers an image-bearing subagent request under a <sessionId>::<requestId> key pointing at the subagent file', () => {
    const index = new Map<string, SessionSource>();
    const subagentImageReq = createRequest({
      requestId: 'sub-img', messageText: 'see this', responseText: '',
      variableKinds: { image: 1 },
      sourceFilePath: '/home/me/.claude/projects/p/parent/subagents/agent-1.jsonl',
    });
    registerExternalHarnessSources(
      [makeSession({
        sessionId: 'parent', harness: 'Claude',
        sourceFilePath: '/home/me/.claude/projects/p/parent.jsonl',
        requests: [subagentImageReq],
      })],
      index,
    );
    // Parent still registered by sessionId -> parent file
    expect(index.get('parent')?.filePath).toBe('/home/me/.claude/projects/p/parent.jsonl');
    // Subagent image request registered under the composite key -> subagent file
    expect(index.get('parent::sub-img')).toEqual({
      kind: 'claude-session-file',
      filePath: '/home/me/.claude/projects/p/parent/subagents/agent-1.jsonl',
      workspaceId: 'w1',
      workspaceName: 'proj',
      harness: 'Claude',
    });
  });

  it('does not add a composite key for requests in the session file or without images', () => {
    const index = new Map<string, SessionSource>();
    const sameFileReq = createRequest({
      requestId: 'same', messageText: '', responseText: '',
      variableKinds: { image: 1 }, sourceFilePath: '/p/parent.jsonl',
    });
    const noImageReq = createRequest({
      requestId: 'noimg', messageText: '', responseText: '',
      variableKinds: {}, sourceFilePath: '/p/parent/subagents/a.jsonl',
    });
    registerExternalHarnessSources(
      [makeSession({
        sessionId: 'parent', harness: 'Claude', sourceFilePath: '/p/parent.jsonl',
        requests: [sameFileReq, noImageReq],
      })],
      index,
    );
    expect(index.has('parent::same')).toBe(false);
    expect(index.has('parent::noimg')).toBe(false);
  });
});
