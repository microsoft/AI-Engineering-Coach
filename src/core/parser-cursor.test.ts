/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Cursor Agent JSONL parser. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  clearCursorResolveCache,
  findCursorDirs,
  inferWorkspaceRootFromPaths,
  parseCursorSessions,
  parseCursorTimestamp,
  projectNameFromCursorEncoded,
  resolveCursorEncodedPath,
} from './parser-cursor';
import { EXTERNAL_HARNESS_SET } from './parser-harnesses';

function writeJsonl(filePath: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

function makeUser(query: string, tsLabel = 'Thursday, Aug 13, 2026, 11:42 AM (UTC-3)'): object {
  return {
    role: 'user',
    message: {
      content: [{
        type: 'text',
        text: `<timestamp>${tsLabel}</timestamp>\n<user_query>\n${query}\n</user_query>`,
      }],
    },
  };
}

function makeIncompleteUser(partialQuery: string): object {
  return {
    role: 'user',
    message: {
      content: [{
        type: 'text',
        text: `<timestamp>Thursday, Aug 13, 2026, 11:42 AM (UTC-3)</timestamp>\n<user_query>\n${partialQuery}`,
      }],
    },
  };
}

function makeAssistant(text: string, tools: Array<{ name: string; input: Record<string, unknown> }> = []): object {
  const content: object[] = [];
  if (text) content.push({ type: 'text', text });
  for (const t of tools) content.push({ type: 'tool_use', name: t.name, input: t.input });
  return { role: 'assistant', message: { content } };
}

function makeTurnEnded(status: 'success' | 'error' = 'success'): object {
  return { type: 'turn_ended', status };
}

/** Create a Cursor projects layout under a temp dir and return projectsDir. */
function setupProject(
  home: string,
  projectSlug: string,
  sessions: Array<{
    id: string;
    lines: object[];
    subagents?: Array<{ id: string; lines: object[] }>;
  }>,
): string {
  const projectsDir = path.join(home, '.cursor', 'projects');
  for (const session of sessions) {
    const sessionDir = path.join(projectsDir, projectSlug, 'agent-transcripts', session.id);
    writeJsonl(path.join(sessionDir, `${session.id}.jsonl`), session.lines);
    for (const sub of session.subagents ?? []) {
      writeJsonl(path.join(sessionDir, 'subagents', `${sub.id}.jsonl`), sub.lines);
    }
  }
  return projectsDir;
}

afterEach(() => {
  clearCursorResolveCache();
});

describe('parseCursorTimestamp', () => {
  it('parses Cursor timestamp tags to epoch ms', () => {
    const ms = parseCursorTimestamp('<timestamp>Thursday, Aug 13, 2026, 11:42 AM (UTC-3)</timestamp>');
    expect(ms).toBeTypeOf('number');
    expect(ms).toBeGreaterThan(0);
  });

  it('returns null when no timestamp tag is present', () => {
    expect(parseCursorTimestamp('plain text')).toBeNull();
  });
});

describe('resolveCursorEncodedPath / projectNameFromCursorEncoded', () => {
  it('uses the encoded slug when the path cannot be fully decoded', () => {
    expect(resolveCursorEncodedPath('fixture-demo-workspace')).toBeUndefined();
    expect(projectNameFromCursorEncoded('fixture-demo-workspace')).toBe('fixture-demo-workspace');
  });

  it('does not invent a Windows drive root when the drive is unavailable', () => {
    // On Linux/WSL this typically cannot list E:\ — must not claim a live root.
    expect(resolveCursorEncodedPath('e-projects-demo-app')).toBeUndefined();
    expect(projectNameFromCursorEncoded('e-projects-demo-app')).toBe('e-projects-demo-app');
  });

  it('resolves a real Unix path tree to the folder basename', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-decode-'));
    try {
      const project = path.join(root, 'projects', 'demo-app');
      fs.mkdirSync(project, { recursive: true });
      const encoded = project.replaceAll('\\', '/').replace(/^\//, '').replaceAll('/', '-');
      clearCursorResolveCache();
      const resolved = resolveCursorEncodedPath(encoded);
      expect(resolved).toBe(project);
      expect(projectNameFromCursorEncoded(encoded, resolved)).toBe('demo-app');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses partial matches that would collapse to an existing shallow path', () => {
    // Matching only `/home` for `home-user-projects-demo-app` would be wrong.
    expect(resolveCursorEncodedPath('home-user-projects-demo-app')).toBeUndefined();
  });
});

describe('inferWorkspaceRootFromPaths', () => {
  it('finds the common ancestor of Unix directories', () => {
    expect(inferWorkspaceRootFromPaths([
      '/home/user/projects/demo-app/src',
      '/home/user/projects/demo-app/lib',
    ])).toBe('/home/user/projects/demo-app');
  });

  it('finds the common ancestor of Windows paths with spaces', () => {
    expect(inferWorkspaceRootFromPaths([
      'E:\\projects\\Demo Workspace\\src',
      'E:\\projects\\Demo Workspace\\docs',
    ])).toBe('E:\\projects\\Demo Workspace');
  });

  it('returns the single directory when only one candidate is present', () => {
    expect(inferWorkspaceRootFromPaths(['/home/user/projects/demo-app/src'])).toBe(
      '/home/user/projects/demo-app/src',
    );
  });

  it('returns undefined for drive or filesystem root only', () => {
    expect(inferWorkspaceRootFromPaths(['/', '/tmp'])).toBeUndefined();
    expect(inferWorkspaceRootFromPaths(['E:\\', 'E:\\projects'])).toBeUndefined();
  });

  it('ignores relative paths', () => {
    expect(inferWorkspaceRootFromPaths(['src/main.ts', 'lib/util.ts'])).toBeUndefined();
  });
});

describe('findCursorDirs', () => {
  it('returns empty when .cursor/projects is missing', () => {
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-home-missing-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(findCursorDirs()).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUser;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('finds ~/.cursor/projects when present', () => {
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-home-present-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(home, '.cursor', 'projects'), { recursive: true });
      expect(findCursorDirs()).toEqual([path.join(home, '.cursor', 'projects')]);
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUser;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('parseCursorSessions', () => {
  it('parses a simple single-request session with harness Cursor', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-simple-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-1',
        lines: [
          makeUser('hello world'),
          makeAssistant('hi there'),
          makeTurnEnded(),
        ],
      }]);

      const result = parseCursorSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceId).toBe('cursor-fixture-demo-workspace');
      expect(result[0].workspaceName).toBe('fixture-demo-workspace');
      expect(result[0].sessions).toHaveLength(1);

      const session = result[0].sessions[0];
      expect(session.harness).toBe('Cursor');
      expect(EXTERNAL_HARNESS_SET.has(session.harness)).toBe(true);
      expect(session.sessionId).toBe('sess-1');
      expect(session.requestCount).toBe(1);
      expect(session.requests[0].messageText).toContain('hello world');
      expect(session.requests[0].responseText).toContain('hi there');
      expect(session.requests[0].promptTokens).toBeNull();
      expect(session.requests[0].completionTokens).toBeNull();
      expect(session.requests[0].endState).toBe('no-data');
      expect(session.requests[0].timestamp).toBeTypeOf('number');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('counts multiple user_query turns as separate requests', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-multi-req-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-2',
        lines: [
          makeUser('first', 'Thursday, Aug 13, 2026, 10:00 AM (UTC-3)'),
          makeAssistant('reply 1'),
          makeTurnEnded(),
          makeUser('second', 'Thursday, Aug 13, 2026, 10:05 AM (UTC-3)'),
          makeAssistant('reply 2'),
          makeTurnEnded(),
        ],
      }]);

      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.requestCount).toBe(2);
      expect(session.requests[0].messageText).toContain('first');
      expect(session.requests[1].messageText).toContain('second');
      expect(session.requests[0].timestamp).toBeLessThan(session.requests[1].timestamp!);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('aggregates multiple assistant messages and tools before turn_ended', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-multi-asst-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-multi-asst',
        lines: [
          makeUser('explore'),
          makeAssistant('step 1', [{ name: 'Glob', input: { glob_pattern: '**/*', target_directory: '/tmp/demo' } }]),
          makeAssistant('step 2', [{ name: 'Read', input: { path: '/tmp/demo/a.ts' } }]),
          makeTurnEnded(),
        ],
      }]);

      const req = parseCursorSessions(projectsDir)[0].sessions[0].requests[0];
      expect(req.responseText).toContain('step 1');
      expect(req.responseText).toContain('step 2');
      expect(req.toolsUsed).toEqual(expect.arrayContaining(['Glob', 'Read']));
      expect(req.endState).toBe('no-data');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('marks in-flight turns without turn_ended as pending', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pending-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-pending',
        lines: [
          makeUser('still running'),
          makeAssistant('working…'),
        ],
      }]);
      expect(parseCursorSessions(projectsDir)[0].sessions[0].requests[0].endState).toBe('pending');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts an incomplete open user_query for incremental transcripts', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-incomplete-uq-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-inc-uq',
        lines: [
          makeIncompleteUser('partial question still being typed'),
          makeAssistant('ack'),
        ],
      }]);
      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.requestCount).toBe(1);
      expect(session.requests[0].messageText).toContain('partial question');
      expect(session.requests[0].endState).toBe('pending');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not treat role=user without user_query as a request', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-no-uq-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-no-uq',
        lines: [
          {
            role: 'user',
            message: { content: [{ type: 'text', text: '<timestamp>Thursday, Aug 13, 2026, 11:42 AM (UTC-3)</timestamp>\nnot a query' }] },
          },
          makeAssistant('should be ignored'),
          makeTurnEnded(),
        ],
      }]);
      expect(parseCursorSessions(projectsDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('captures tool calls and prefers tool LCP when decoded path is absent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tools-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-tools',
        lines: [
          makeUser('edit the file'),
          makeAssistant('working', [
            { name: 'Glob', input: { glob_pattern: '**/*', target_directory: '/home/user/projects/demo-app' } },
            { name: 'Read', input: { path: '/home/user/projects/demo-app/src/main.ts' } },
            {
              name: 'Write',
              input: {
                path: '/home/user/projects/demo-app/src/main.ts',
                contents: 'export const x = 1;\nexport const y = 2;\n',
              },
            },
            {
              name: 'StrReplace',
              input: {
                path: '/home/user/projects/demo-app/src/main.ts',
                old_string: 'x = 1',
                new_string: 'x = 3',
              },
            },
          ]),
          makeTurnEnded(),
        ],
      }]);

      const parsed = parseCursorSessions(projectsDir)[0].sessions[0];
      const req = parsed.requests[0];
      expect(req.toolsUsed).toEqual(expect.arrayContaining(['Glob', 'Read', 'Write', 'StrReplace']));
      expect(req.referencedFiles).toEqual(expect.arrayContaining([
        '/home/user/projects/demo-app',
        '/home/user/projects/demo-app/src/main.ts',
      ]));
      expect(req.editedFiles).toEqual(expect.arrayContaining([
        '/home/user/projects/demo-app/src/main.ts',
      ]));
      expect(req.aiCode.some(b => b.loc >= 2)).toBe(true);
      expect(parsed.workspaceRootPath).toBe('/home/user/projects/demo-app');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('prefers an existing decoded project path over tool LCP', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-prefer-decoded-'));
    try {
      const project = path.join(root, 'demo-proj');
      fs.mkdirSync(project, { recursive: true });
      const encoded = project.replaceAll('\\', '/').replace(/^\//, '').replaceAll('/', '-');
      clearCursorResolveCache();

      const projectsDir = setupProject(root, encoded, [{
        id: 'sess-pref',
        lines: [
          makeUser('edit'),
          makeAssistant('ok', [
            { name: 'Read', input: { path: path.join(project, 'src', 'a.ts') } },
          ]),
          makeTurnEnded(),
        ],
      }]);

      // setupProject nests under root/.cursor/projects — move to match encoded layout:
      // We stored under root/.cursor/projects/<encoded>, and encoded resolves to `project`.
      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.workspaceRootPath).toBe(project);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges subagent files into the parent session preserving tools and timestamps', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-subagent-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'parent-sess',
        lines: [
          makeUser('main task', 'Thursday, Aug 13, 2026, 10:00 AM (UTC-3)'),
          makeAssistant('parent reply'),
          makeTurnEnded(),
        ],
        subagents: [{
          id: 'sub-1',
          lines: [
            makeUser('subagent task', 'Thursday, Aug 13, 2026, 10:01 AM (UTC-3)'),
            makeAssistant('subagent reply', [
              { name: 'Write', input: { path: '/tmp/demo/out.ts', contents: 'x\n' } },
            ]),
            makeTurnEnded(),
          ],
        }],
      }]);

      const result = parseCursorSessions(projectsDir);
      expect(result[0].sessions).toHaveLength(1);
      const session = result[0].sessions[0];
      expect(session.sessionId).toBe('parent-sess');
      expect(session.harness).toBe('Cursor');
      expect(session.requestCount).toBe(2);
      expect(session.requests.map(r => r.messageText).join(' ')).toContain('subagent task');
      expect(session.requests[0].timestamp!).toBeLessThan(session.requests[1].timestamp!);
      expect(session.requests.some(r => r.editedFiles.includes('/tmp/demo/out.ts'))).toBe(true);
      expect(session.creationDate).toBe(session.requests[0].timestamp);
      expect(session.lastMessageDate).toBeGreaterThanOrEqual(session.requests[1].timestamp!);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits orphan subagent sessions when the parent transcript is missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-orphan-'));
    try {
      const projectsDir = path.join(home, '.cursor', 'projects');
      const sessionDir = path.join(projectsDir, 'fixture-demo-workspace', 'agent-transcripts', 'orphan-sess');
      writeJsonl(path.join(sessionDir, 'subagents', 'sub-only.jsonl'), [
        makeUser('orphan work'),
        makeAssistant('done'),
        makeTurnEnded(),
      ]);

      const result = parseCursorSessions(projectsDir);
      expect(result[0].sessions).toHaveLength(1);
      expect(result[0].sessions[0].sessionId).toBe('orphan-sess');
      expect(result[0].sessions[0].requestCount).toBe(1);
      expect(result[0].sessions[0].harness).toBe('Cursor');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('parses multiple sessions under one workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-multi-sess-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [
        {
          id: 'sess-a',
          lines: [makeUser('a'), makeAssistant('A'), makeTurnEnded()],
        },
        {
          id: 'sess-b',
          lines: [makeUser('b'), makeAssistant('B'), makeTurnEnded()],
        },
      ]);

      const sessions = parseCursorSessions(projectsDir)[0].sessions;
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores empty and corrupt JSONL lines', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-corrupt-'));
    try {
      const projectsDir = path.join(home, '.cursor', 'projects');
      const sessionFile = path.join(
        projectsDir, 'fixture-demo-workspace', 'agent-transcripts', 'sess-bad', 'sess-bad.jsonl',
      );
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        [
          '',
          'not-json',
          JSON.stringify(makeUser('ok')),
          JSON.stringify(makeAssistant('reply')),
          '{broken',
          JSON.stringify(makeTurnEnded()),
        ].join('\n'),
        'utf-8',
      );

      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.requestCount).toBe(1);
      expect(session.requests[0].messageText).toContain('ok');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns no sessions when agent-transcripts is missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-no-transcripts-'));
    try {
      const projectsDir = path.join(home, '.cursor', 'projects');
      fs.mkdirSync(path.join(projectsDir, '1783368199641', 'terminals'), { recursive: true });
      expect(parseCursorSessions(projectsDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns no sessions for an empty projects directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-empty-projects-'));
    try {
      const projectsDir = path.join(home, '.cursor', 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      expect(parseCursorSessions(projectsDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not duplicate a session when parent and matching id already exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-dedupe-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-dup',
        lines: [makeUser('once'), makeAssistant('once'), makeTurnEnded()],
        subagents: [{
          id: 'sub-extra',
          lines: [makeUser('extra'), makeAssistant('extra'), makeTurnEnded()],
        }],
      }]);

      const sessions = parseCursorSessions(projectsDir)[0].sessions;
      expect(sessions.filter(s => s.sessionId === 'sess-dup')).toHaveLength(1);
      expect(sessions[0].requestCount).toBe(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('re-parses an incrementally updated transcript with more requests', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-incremental-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-inc',
        lines: [
          makeUser('first', 'Thursday, Aug 13, 2026, 10:00 AM (UTC-3)'),
          makeAssistant('r1'),
          makeTurnEnded(),
        ],
      }]);

      expect(parseCursorSessions(projectsDir)[0].sessions[0].requestCount).toBe(1);

      const sessionFile = path.join(
        projectsDir, 'fixture-demo-workspace', 'agent-transcripts', 'sess-inc', 'sess-inc.jsonl',
      );
      writeJsonl(sessionFile, [
        makeUser('first', 'Thursday, Aug 13, 2026, 10:00 AM (UTC-3)'),
        makeAssistant('r1'),
        makeTurnEnded(),
        makeUser('second', 'Thursday, Aug 13, 2026, 10:10 AM (UTC-3)'),
        makeAssistant('r2'),
        makeTurnEnded(),
      ]);

      expect(parseCursorSessions(projectsDir)[0].sessions[0].requestCount).toBe(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores unexpected shapes such as turn_ended-only files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-unexpected-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-meta',
        lines: [makeTurnEnded(), { role: 'assistant', message: { content: [{ type: 'text', text: 'orphan' }] } }],
      }]);
      expect(parseCursorSessions(projectsDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('marks errored turn_ended as endState errored', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-error-'));
    try {
      const projectsDir = setupProject(home, 'fixture-demo-workspace', [{
        id: 'sess-err',
        lines: [
          makeUser('fail please'),
          makeAssistant('trying'),
          makeTurnEnded('error'),
        ],
      }]);
      expect(parseCursorSessions(projectsDir)[0].sessions[0].requests[0].endState).toBe('errored');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
