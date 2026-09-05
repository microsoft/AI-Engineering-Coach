/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Claude JSONL parser — focuses on synthetic user-record
 * filtering (tool_result deliveries, slash-command bookkeeping, interrupt
 * markers) so we don't inflate the missing-token rate. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { parseClaudeSessions } from './parser-claude';

/** os.tmpdir() on Windows often returns 8.3 short names (e.g. TAMASB~1)
 *  that don't match readdirSync output. Resolve to the long form so
 *  tests that encode and decode filesystem paths work reliably. */
function longTmpDir(): string {
  const tmp = os.tmpdir();
  if (process.platform !== 'win32' || !tmp.includes('~')) return tmp;
  try {
    return execSync(
      `powershell -NoProfile -Command "(Get-Item ${JSON.stringify(tmp)}).FullName"`,
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return tmp;
  }
}

function makeUser(text: string, ts = '2025-06-15T10:00:00Z', extra: Record<string, unknown> = {}): object {
  return {
    type: 'user',
    timestamp: ts,
    sessionId: 'sess-1',
    cwd: '/Users/me/proj',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  };
}

function makeToolResultUser(ts = '2025-06-15T10:00:01Z'): object {
  return {
    type: 'user',
    timestamp: ts,
    sessionId: 'sess-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
  };
}

function makeAssistant(text: string, ts = '2025-06-15T10:00:02Z', usage?: Record<string, number>): object {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess-1',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text }],
      usage: usage ?? { input_tokens: 1000, output_tokens: 50 },
    },
  };
}

function makeToolAssistant(
  name: string,
  input: Record<string, unknown>,
  ts = '2025-06-15T10:00:02Z',
  id?: string,
): object {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess-1',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  };
}

function withProjectsDir(filename: string, lines: object[], run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-parser-test-'));
  const projectsDir = path.join(root, 'projects');
  const projDir = path.join(projectsDir, '-Users-me-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, filename);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(projectsDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('parseClaudeSessions', () => {
  it('extracts current Edit new_string and MultiEdit deltas', () => {
    withProjectsDir('s.jsonl', [
      makeUser('edit files', '2025-06-15T10:00:00Z', { uuid: 'request_claude_edit' }),
      makeToolAssistant('Edit', {
        file_path: '/Users/me/proj/app.ts',
        old_string: 'a\nold',
        new_string: 'a\nnew\nextra',
      }),
      makeToolAssistant('MultiEdit', {
        file_path: '/Users/me/proj/other.ts',
        edits: [
          { old_string: 'old1', new_string: 'new1' },
          { old_string: 'old2', new_string: 'new2\nextra2' },
        ],
      }, '2025-06-15T10:00:03Z'),
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const request = parseClaudeSessions(projectsDir, editLocIndex)[0].sessions[0].requests[0];

      expect(request.toolsUsed).toEqual(['Edit', 'MultiEdit']);
      expect(request.editedFiles).toEqual([
        '/Users/me/proj/app.ts',
        '/Users/me/proj/other.ts',
      ]);
      expect(editLocIndex.get('request_claude_edit')?.get('/Users/me/proj/app.ts'))
        .toEqual({ added: 2, removed: 1 });
      expect(editLocIndex.get('request_claude_edit')?.get('/Users/me/proj/other.ts'))
        .toEqual({ added: 3, removed: 2 });
    });
  });

  it('excludes edits whose correlated tool result reports an error', () => {
    withProjectsDir('s.jsonl', [
      makeUser('edit a file', '2025-06-15T10:00:00Z', { uuid: 'request_failed_edit' }),
      makeToolAssistant('Edit', {
        file_path: '/Users/me/proj/app.ts',
        old_string: 'old',
        new_string: 'new',
      }, '2025-06-15T10:00:01Z', 'tool-failed'),
      {
        type: 'user',
        timestamp: '2025-06-15T10:00:02Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-failed', is_error: true }],
        },
      },
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const request = parseClaudeSessions(projectsDir, editLocIndex)[0].sessions[0].requests[0];

      expect(request.toolsUsed).toEqual(['Edit']);
      expect(request.editedFiles).toEqual([]);
      expect(editLocIndex.has('request_failed_edit')).toBe(false);
    });
  });

  it('excludes correlated edits without a tool result', () => {
    withProjectsDir('s.jsonl', [
      makeUser('edit a file', '2025-06-15T10:00:00Z', { uuid: 'request_incomplete_edit' }),
      makeToolAssistant('Edit', {
        file_path: '/Users/me/proj/app.ts',
        old_string: 'old',
        new_string: 'new',
      }, '2025-06-15T10:00:01Z', 'tool-incomplete'),
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const request = parseClaudeSessions(projectsDir, editLocIndex)[0].sessions[0].requests[0];

      expect(request.editedFiles).toEqual([]);
      expect(editLocIndex.size).toBe(0);
    });
  });

  it('records the on-disk source file path on each parsed session', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hello', '2025-06-15T10:00:00Z'),
      makeAssistant('hi', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.sourceFilePath).toBe(path.join(projectsDir, '-Users-me-proj', 's.jsonl'));
    });
  });

  it('skips tool_result-only user records and merges following assistant into prior real user request', () => {
    withProjectsDir('s.jsonl', [
      makeUser('write a file please'),
      makeAssistant('I will use the Write tool', '2025-06-15T10:00:01Z',
        { input_tokens: 100, output_tokens: 30 }),
      makeToolResultUser('2025-06-15T10:00:02Z'),
      makeAssistant('Done.', '2025-06-15T10:00:03Z',
        { input_tokens: 200, output_tokens: 10 }),
    ], (projectsDir) => {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      const session = result[0].sessions[0];
      // ONE request, not two — the tool_result delivery is consumed into
      // the parent request alongside both assistant follow-ups
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].promptTokens).toBe(300);  // sum of both assistants
      expect(session.requests[0].completionTokens).toBe(40);
    });
  });

  it('skips slash-command bookkeeping records (<command-name>, <local-command-stdout>)', () => {
    withProjectsDir('s.jsonl', [
      // Three slash-command records that have text but aren't real prompts —
      // these used to be parsed as missing-token requests.
      makeUser('<local-command-caveat>resumed conversation</local-command-caveat>'),
      makeUser('<command-name>/mcp</command-name>'),
      makeUser('<local-command-stdout>No MCP servers configured.</local-command-stdout>'),
      // Real user prompt comes after
      makeUser('how does mcp work?', '2025-06-15T10:01:00Z'),
      makeAssistant('It works like this…', '2025-06-15T10:01:01Z',
        { input_tokens: 500, output_tokens: 100 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toContain('how does mcp work?');
    });
  });

  it('skips [Request interrupted by user…] markers', () => {
    withProjectsDir('s.jsonl', [
      makeUser('do something'),
      makeAssistant('starting', '2025-06-15T10:00:01Z',
        { input_tokens: 100, output_tokens: 5 }),
      makeUser('[Request interrupted by user for tool use]', '2025-06-15T10:00:02Z'),
      // Real follow-up
      makeUser('actually do this instead', '2025-06-15T10:00:03Z'),
      makeAssistant('ok', '2025-06-15T10:00:04Z',
        { input_tokens: 200, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(2);
      expect(session.requests[0].messageText).toBe('do something');
      expect(session.requests[1].messageText).toBe('actually do this instead');
    });
  });

  it('marks tokens as missing when a real user prompt has no assistant response', () => {
    withProjectsDir('s.jsonl', [
      makeUser('this prompt errors and gets no response'),
      // No assistant follow-up
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].promptTokens).toBeNull();
      expect(session.requests[0].completionTokens).toBeNull();
    });
  });

  // ---- entrypoint classification & subagent merging ----

  it('classifies cli entrypoint as interactive Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'cli' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('interactive');
      expect(session.entrypoint).toBe('cli');
    });
  });

  it('classifies claude-desktop entrypoint as interactive Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'claude-desktop' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('interactive');
    });
  });

  it('classifies sdk-ts entrypoint as programmatic Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'sdk-ts' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('programmatic');
      expect(session.entrypoint).toBe('sdk-ts');
    });
  });

  it('defaults missing entrypoint to programmatic Claude harness', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi'),  // no entrypoint field at all
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('programmatic');
      expect(session.entrypoint).toBeUndefined();
    });
  });

  it('defaults unknown entrypoint to programmatic (allow-list discipline)', () => {
    withProjectsDir('s.jsonl', [
      makeUser('hi', '2025-06-15T10:00:00Z', { entrypoint: 'some-future-launcher' }),
      makeAssistant('hello', '2025-06-15T10:00:01Z', { input_tokens: 10, output_tokens: 5 }),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.harness).toBe('Claude');
      expect(session.launcherKind).toBe('programmatic');
      expect(session.entrypoint).toBe('some-future-launcher');
    });
  });

  it('merges subagent files into the parent session, sorted by timestamp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-test-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, '-Users-me-proj');
    const subDir = path.join(projDir, 'parent-sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    // Parent session at top-level
    fs.writeFileSync(
      path.join(projDir, 'parent-sess.jsonl'),
      [
        makeUser('parent prompt', '2025-06-15T10:00:00Z',
          { sessionId: 'parent-sess', entrypoint: 'sdk-ts' }),
        makeAssistant('parent reply', '2025-06-15T10:00:01Z',
          { input_tokens: 100, output_tokens: 20 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    // Subagent file (later timestamp) should be merged in but appear after parent request
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      [
        makeUser('subagent task', '2025-06-15T10:00:30Z',
          { sessionId: 'agent-1', entrypoint: 'sdk-ts' }),
        makeAssistant('subagent reply', '2025-06-15T10:00:31Z',
          { input_tokens: 50, output_tokens: 10 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      const sessions = result[0].sessions;
      // Only ONE session — subagent merged into parent, not standalone
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('parent-sess');
      expect(sessions[0].requests).toHaveLength(2);
      // Sorted by timestamp
      expect(sessions[0].requests[0].messageText).toContain('parent prompt');
      expect(sessions[0].requests[1].messageText).toContain('subagent task');
      expect(sessions[0].requestCount).toBe(2);
      // lastMessageDate extends to the subagent's last assistant timestamp
      expect(sessions[0].lastMessageDate).toBe(new Date('2025-06-15T10:00:31Z').getTime());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stamps a subagent image request with the subagent file path so its images stay loadable', () => {
    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-subagent-img-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, '-Users-me-proj');
    const subDir = path.join(projDir, 'parent-sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(
      path.join(projDir, 'parent-sess.jsonl'),
      [
        makeUser('parent prompt', '2025-06-15T10:00:00Z', { sessionId: 'parent-sess', uuid: 'p-1' }),
        makeAssistant('parent reply', '2025-06-15T10:00:01Z', { input_tokens: 100, output_tokens: 20 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    const subFile = path.join(subDir, 'agent-1.jsonl');
    fs.writeFileSync(
      subFile,
      [
        makeUser('here is a screenshot', '2025-06-15T10:00:30Z', {
          sessionId: 'agent-1', uuid: 'sub-img-req',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'here is a screenshot' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAAAAAA' } },
            ],
          },
        }),
        makeAssistant('looked at it', '2025-06-15T10:00:31Z', { input_tokens: 50, output_tokens: 10 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const sessions = parseClaudeSessions(projectsDir)[0].sessions;
      expect(sessions).toHaveLength(1);
      const imgReq = sessions[0].requests.find(r => r.requestId === 'sub-img-req');
      expect(imgReq?.variableKinds.image).toBe(1);
      // Image bytes live in the subagent file, so the request points there...
      expect(imgReq?.sourceFilePath).toBe(subFile);
      // ...while the parent's own request falls back to the session source file.
      const parentReq = sessions[0].requests.find(r => r.requestId === 'p-1');
      expect(parentReq?.sourceFilePath).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits orphan subagent (no parent session) as standalone Claude', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-orphan-test-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, '-Users-me-proj');
    const subDir = path.join(projDir, 'orphan-sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    // No parent file — only the subagent under orphan-sess/subagents/
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      [
        makeUser('orphan task', '2025-06-15T10:00:00Z',
          { sessionId: 'agent-1', entrypoint: 'sdk-ts' }),
        makeAssistant('orphan reply', '2025-06-15T10:00:01Z',
          { input_tokens: 50, output_tokens: 10 }),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      const sessions = result[0].sessions;
      expect(sessions).toHaveLength(1);
      // Orphan session takes the parent dir name as its sessionId
      expect(sessions[0].sessionId).toBe('orphan-sess');
      expect(sessions[0].harness).toBe('Claude');
      expect(sessions[0].launcherKind).toBe('programmatic');
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0].messageText).toContain('orphan task');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---- workspace name resolution with spaces ----

  it('resolves workspace name when path contains a folder with spaces', { timeout: 30_000 }, () => {
    // Create a real directory tree with a space in a folder name.
    // longTmpDir() resolves Windows 8.3 short names so the encoded path
    // uses long names that match readdirSync output.
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'claude-ws-'));
    const spaceParent = path.join(tmpBase, 'My Folder');
    const targetDir = path.join(spaceParent, 'proj');
    fs.mkdirSync(targetDir, { recursive: true });

    // Compute the encoded directory name that Claude Code would produce:
    // lowercase drive letter, then replace :, \, /, and whitespace with -
    const encodedDirName = targetDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-proj-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, encodedDirName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 's.jsonl'),
      [makeUser('hello'), makeAssistant('hi')].map(l => JSON.stringify(l)).join('\n'),
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('proj');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('resolves workspace name when path has space-hyphen-space (OneDrive style)', () => {
    // Simulates paths like C:\Users\me\OneDrive - Microsoft\Documents\proj
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'claude-od-'));
    const oneDriveDir = path.join(tmpBase, 'OneDrive - Microsoft');
    const docsDir = path.join(oneDriveDir, 'Documents');
    const targetDir = path.join(docsDir, 'myapp');
    fs.mkdirSync(targetDir, { recursive: true });

    const encodedDirName = targetDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-proj-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, encodedDirName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 's.jsonl'),
      [makeUser('hello'), makeAssistant('world')].map(l => JSON.stringify(l)).join('\n'),
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('myapp');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('resolves workspace name through symlinked directories (OneDrive reparse points)', () => {
    // On Windows, "OneDrive - Microsoft" is a reparse point that readdirSync
    // reports as a symlink rather than a directory.  The resolution algorithm
    // must follow symlinks to resolve the project name correctly.
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'claude-sym-'));
    const realDir = path.join(tmpBase, 'real-onedrive');
    const docsDir = path.join(realDir, 'Documents');
    const targetDir = path.join(docsDir, 'myapp');
    fs.mkdirSync(targetDir, { recursive: true });

    // Create a symlink (junction on Windows) with a space-hyphen-space name
    const symlinkDir = path.join(tmpBase, 'OneDrive - Microsoft');
    if (process.platform === 'win32') {
      fs.symlinkSync(realDir, symlinkDir, 'junction');
    } else {
      fs.symlinkSync(realDir, symlinkDir);
    }

    // The encoded path goes through the symlink, not the real directory
    const symlinkTargetDir = path.join(symlinkDir, 'Documents', 'myapp');
    const encodedDirName = symlinkTargetDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'claude-proj-'));
    const projectsDir = path.join(root, 'projects');
    const projDir = path.join(projectsDir, encodedDirName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 's.jsonl'),
      [makeUser('hello'), makeAssistant('world')].map(l => JSON.stringify(l)).join('\n'),
    );

    try {
      const result = parseClaudeSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('myapp');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('extracts skillsUsed from Read tool calls targeting SKILL.md files', () => {
    const assistantWithSkillRead = {
      type: 'assistant',
      timestamp: '2025-06-15T10:00:02Z',
      sessionId: 'sess-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/.claude/skills/investigate/SKILL.md' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/.claude/skills/browse/SKILL.md' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/src/main.ts' } },
          { type: 'text', text: 'I read the skill files.' },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    };

    withProjectsDir('s.jsonl', [
      makeUser('investigate this bug'),
      assistantWithSkillRead,
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].skillsUsed).toContain('investigate');
      expect(session.requests[0].skillsUsed).toContain('browse');
      expect(session.requests[0].skillsUsed).toHaveLength(2);
    });
  });

  it('extracts skillsUsed from Skill tool calls', () => {
    const assistantWithSkillTool = {
      type: 'assistant',
      timestamp: '2025-06-15T10:00:02Z',
      sessionId: 'sess-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'office-hours', args: 'brainstorm my idea' } },
          { type: 'text', text: 'Running office-hours skill.' },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    };

    withProjectsDir('s.jsonl', [
      makeUser('brainstorm this'),
      assistantWithSkillTool,
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].skillsUsed).toContain('office-hours');
      expect(session.requests[0].skillsUsed).toHaveLength(1);
      expect(session.requests[0].toolsUsed).toContain('Skill');
    });
  });

  it('deduplicates skills from Skill tool and Read-based detection', () => {
    const assistantWithBoth = {
      type: 'assistant',
      timestamp: '2025-06-15T10:00:02Z',
      sessionId: 'sess-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'investigate', args: 'debug this' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/.claude/skills/investigate/SKILL.md' } },
          { type: 'text', text: 'Investigating.' },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    };

    withProjectsDir('s.jsonl', [
      makeUser('debug this'),
      assistantWithBoth,
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.requests[0].skillsUsed).toContain('investigate');
      expect(session.requests[0].skillsUsed).toHaveLength(1);
    });
  });

  it('stores the Claude session cwd as workspaceRootPath', () => {
    // The cwd recorded on user records is the project root. Surfacing it as
    // workspaceRootPath lets config-health / SDLC workspace scans resolve the
    // repo for Claude sessions, the same way the Codex parser already does.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cwd-test-'));
    withProjectsDir('s.jsonl', [
      makeUser('hello', '2025-06-15T10:00:00Z', { cwd }),
      makeAssistant('hi there'),
    ], (projectsDir) => {
      const session = parseClaudeSessions(projectsDir)[0].sessions[0];
      expect(session.workspaceRootPath).toBe(cwd);
    });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
