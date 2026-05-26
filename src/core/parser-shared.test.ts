/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { detectDevcontainerFromRequests, extractSkillPathsFromText } from './parser-shared';
import { createRequest, createSession } from './parser-shared';
import { SessionRequest } from './types';

function makeReq(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: 'r1',
    timestamp: 0,
    messageText: '',
    responseText: '',
    isCanceled: false,
    agentName: '',
    agentMode: 'chat',
    modelId: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: 0,
    totalElapsed: 0,
    messageLength: 0,
    responseLength: 0,
    userCode: [],
    aiCode: [],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'feature',
    ...overrides,
  };
}

describe('detectDevcontainerFromRequests', () => {
  it('returns false when no signal is present', () => {
    expect(detectDevcontainerFromRequests([makeReq()])).toBe(false);
    expect(detectDevcontainerFromRequests([makeReq()], '/Users/me/proj')).toBe(false);
  });

  it('detects via cwd starting with /workspaces/', () => {
    expect(detectDevcontainerFromRequests([makeReq()], '/workspaces/repo')).toBe(true);
  });

  it('detects via terminal commandLine referencing /workspaces/', () => {
    const req = makeReq({
      toolConfirmations: [{ toolId: 'run_in_terminal', confirmationType: 0, isTerminal: true, commandLine: 'cd /workspaces/foo && ls' }],
    });
    expect(detectDevcontainerFromRequests([req])).toBe(true);
  });

  it('detects via editedFiles entry under /workspaces/', () => {
    const req = makeReq({ editedFiles: ['/workspaces/foo/src/index.ts'] });
    expect(detectDevcontainerFromRequests([req])).toBe(true);
  });

  it('detects via referencedFiles entry under /workspaces/', () => {
    const req = makeReq({ referencedFiles: ['/workspaces/foo/README.md'] });
    expect(detectDevcontainerFromRequests([req])).toBe(true);
  });

  it('ignores non-terminal tool confirmations even with /workspaces/ in payload', () => {
    const req = makeReq({
      toolConfirmations: [{ toolId: 'edit_file', confirmationType: 0, isTerminal: false, commandLine: '/workspaces/foo/x' }],
    });
    expect(detectDevcontainerFromRequests([req])).toBe(false);
  });

  it('does not match incidental substrings like /Users/me/workspaces-old', () => {
    const req = makeReq({ editedFiles: ['/Users/me/workspaces-old/index.ts'] });
    expect(detectDevcontainerFromRequests([req])).toBe(false);
  });
});

describe('createRequest timestamp sanitization', () => {
  it('preserves valid timestamp', () => {
    const ts = Date.now();
    const req = createRequest({ messageText: 'hi', responseText: 'ok', timestamp: ts });
    expect(req.timestamp).toBe(ts);
  });

  it('nullifies timestamp of 0', () => {
    const req = createRequest({ messageText: 'hi', responseText: 'ok', timestamp: 0 });
    expect(req.timestamp).toBeNull();
  });

  it('nullifies negative timestamp', () => {
    const req = createRequest({ messageText: 'hi', responseText: 'ok', timestamp: -1 });
    expect(req.timestamp).toBeNull();
  });

  it('keeps null timestamp as null', () => {
    const req = createRequest({ messageText: 'hi', responseText: 'ok', timestamp: null });
    expect(req.timestamp).toBeNull();
  });
});

describe('extractSkillPathsFromText', () => {
  it('returns an empty array for empty, non-string, or non-matching input', () => {
    expect(extractSkillPathsFromText('')).toEqual([]);
    expect(extractSkillPathsFromText(undefined as unknown as string)).toEqual([]);
    expect(extractSkillPathsFromText(null as unknown as string)).toEqual([]);
    expect(extractSkillPathsFromText('cat README.md')).toEqual([]);
    expect(extractSkillPathsFromText('echo /skills/foo')).toEqual([]);
  });

  it('extracts a single SKILL.md path from a shell-style command line', () => {
    const out = extractSkillPathsFromText('cat ~/.codex/skills/investigate/SKILL.md');
    expect(out).toEqual(['/skills/investigate/SKILL.md']);
  });

  it('extracts multiple SKILL.md paths from one string', () => {
    const cmd = 'cat /a/skills/foo/SKILL.md /b/skills/bar/SKILL.md';
    expect(extractSkillPathsFromText(cmd)).toEqual([
      '/skills/foo/SKILL.md',
      '/skills/bar/SKILL.md',
    ]);
  });

  it('extracts paths embedded inside quoted JSON-style text', () => {
    const text = '{"file":"/Users/me/.claude/skills/money/SKILL.md"}';
    expect(extractSkillPathsFromText(text)).toEqual(['/skills/money/SKILL.md']);
  });

  it('does not match SKILL.md outside a skills/ directory', () => {
    expect(extractSkillPathsFromText('cat /etc/SKILL.md')).toEqual([]);
    expect(extractSkillPathsFromText('cat /home/me/notes/SKILL.md')).toEqual([]);
  });
});

describe('createSession timestamp sanitization', () => {
  const validTs = new Date('2025-03-15T10:00:00Z').getTime();
  const validReq = makeReq({ timestamp: validTs });

  it('computes creationDate/lastMessageDate from valid request timestamps', () => {
    const session = createSession({ sessionId: 's1', workspaceId: 'w1', workspaceName: 'test', harness: 'vscode', requests: [validReq] });
    expect(session.creationDate).toBe(validTs);
    expect(session.lastMessageDate).toBe(validTs);
  });

  it('ignores zero-timestamp requests when computing session dates', () => {
    const zeroReq = makeReq({ timestamp: 0 });
    const session = createSession({ sessionId: 's1', workspaceId: 'w1', workspaceName: 'test', harness: 'vscode', requests: [zeroReq, validReq] });
    expect(session.creationDate).toBe(validTs);
    expect(session.lastMessageDate).toBe(validTs);
  });

  it('sanitizes creationDate override of 0', () => {
    const session = createSession({ sessionId: 's1', workspaceId: 'w1', workspaceName: 'test', harness: 'vscode', requests: [validReq], creationDate: 0 });
    expect(session.creationDate).toBe(validTs);
  });

  it('sanitizes lastMessageDate override of 0', () => {
    const session = createSession({ sessionId: 's1', workspaceId: 'w1', workspaceName: 'test', harness: 'vscode', requests: [validReq], lastMessageDate: 0 });
    expect(session.lastMessageDate).toBe(validTs);
  });

  it('returns null dates when all requests have zero timestamps', () => {
    const zeroReq = makeReq({ timestamp: 0 });
    const session = createSession({ sessionId: 's1', workspaceId: 'w1', workspaceName: 'test', harness: 'vscode', requests: [zeroReq] });
    expect(session.creationDate).toBeNull();
    expect(session.lastMessageDate).toBeNull();
  });
});
