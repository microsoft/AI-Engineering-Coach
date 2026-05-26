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
import { CLAUDE_CONFIG_DIRS_ENV } from './harness-config-roots';
import { findClaudeDirs, parseClaudeSessions } from './parser-claude';

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

function withProjectsDir(filename: string, lines: object[], run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-parser-test-'));
  const projectsDir = path.join(root, 'projects');
  const projDir = path.join(projectsDir, '-Users-me-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, filename);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(projectsDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

describe('parseClaudeSessions', () => {
  it('uses configured Claude config directories as an explicit override', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dirs-test-'));
    const home = path.join(root, 'home');
    const work = path.join(root, '.claude-work');
    const active = path.join(root, '.claude-active');
    const directProjects = path.join(root, '.claude-home', 'projects');

    try {
      withClaudeEnv(() => {
        for (const dir of [
          path.join(home, '.claude', 'projects'),
          path.join(work, 'projects'),
          path.join(active, 'projects'),
          directProjects,
        ]) {
          fs.mkdirSync(dir, { recursive: true });
        }

        process.env.HOME = home;
        delete process.env.USERPROFILE;
        process.env.CLAUDE_CONFIG_DIR = active;
        process.env[CLAUDE_CONFIG_DIRS_ENV] = JSON.stringify([work, directProjects]);

        expect(findClaudeDirs()).toEqual([
          path.join(work, 'projects'),
          directProjects,
        ]);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to CLAUDE_CONFIG_DIR and default home when no Claude dirs are configured', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auto-dirs-test-'));
    const home = path.join(root, 'home');
    const active = path.join(root, '.claude-active');

    try {
      withClaudeEnv(() => {
        fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
        fs.mkdirSync(path.join(active, 'projects'), { recursive: true });

        process.env.HOME = home;
        delete process.env.USERPROFILE;
        process.env.CLAUDE_CONFIG_DIR = active;
        delete process.env[CLAUDE_CONFIG_DIRS_ENV];

        expect(findClaudeDirs()).toEqual([
          path.join(active, 'projects'),
          path.join(home, '.claude', 'projects'),
        ]);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates Claude config directories that resolve to the same symlink target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-symlink-dirs-test-'));
    const home = path.join(root, 'home');
    const target = path.join(root, '.claude-home');

    try {
      withClaudeEnv(() => {
        fs.mkdirSync(path.join(home), { recursive: true });
        fs.mkdirSync(path.join(target, 'projects'), { recursive: true });
        try {
          fs.symlinkSync(target, path.join(home, '.claude'), 'dir');
        } catch {
          return;
        }

        process.env.HOME = home;
        delete process.env.USERPROFILE;
        delete process.env.CLAUDE_CONFIG_DIR;
        process.env[CLAUDE_CONFIG_DIRS_ENV] = JSON.stringify([target]);

        expect(findClaudeDirs()).toEqual([path.join(target, 'projects')]);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
});
