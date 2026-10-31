/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Which logged "user" turns each parser marks as not typed by the user (`nonHumanKind`), and which typed turns it
 * leaves alone, end to end through each parser. The fixtures copy each harness's log shapes with made-up text. The
 * local logs had Copilot App, VS Code and OpenCode data only; the Claude Code, Codex, OpenCode child-session and
 * Xcode shapes follow the harnesses' documented formats. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { detectCuriosity } from './curiosity';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { harnessFromPath, parseSessionFile } from './parser-vscode';
import { parseClaudeSessions } from './parser-claude';
import { parseCodexSessions } from './parser-codex';
import { parseOpenCodeSessions } from './parser-opencode';
import { parseXcodeDatabases, parseXcodeDatabasesAsync } from './parser-xcode';
import { setCuriosityDetector } from './parser-shared';
import type { NonHumanKind, SessionRequest } from './types';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aec-human-turns-${prefix}-`));
  roots.push(root);
  return root;
}

function writeLines(file: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
}

const kinds = (requests: SessionRequest[]) => requests.map(request => request.nonHumanKind);
const curiosity = (requests: SessionRequest[]) => requests.map(request => request.curiosity?.kind);

beforeEach(() => setCuriosityDetector(detectCuriosity));

afterEach(() => {
  setCuriosityDetector(undefined);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const CODE_ONLY = '```ts\nconst total = items.length;\n```';
const URL_ONLY = 'https://example.test/issues/1';
const QUOTE_ONLY = '> Error: the build failed';

describe('Copilot CLI and Copilot App', () => {
  const turns: Array<[string, Record<string, unknown>, NonHumanKind | undefined, 'analyzed' | 'excluded']> = [
    ['typed prompt', { content: 'Why does the build fail?' }, undefined, 'analyzed'],
    ['code only', { content: CODE_ONLY }, undefined, 'excluded'],
    ['URL only', { content: URL_ONLY }, undefined, 'excluded'],
    ['quote only', { content: QUOTE_ONLY }, undefined, 'excluded'],
    ['attachment only', { content: '', attachments: [{ type: 'file', path: '/repo/screenshot.png', displayName: 'screenshot.png' }] }, undefined, 'excluded'],
    ['slash command', { content: '/review Why does the build fail?' }, undefined, 'analyzed'],
    ['harness wrapper around a typed prompt', { content: 'Why?', transformedContent: '<current_datetime>2026-09-30T12:00:00Z</current_datetime>\n\nWhy?' }, undefined, 'analyzed'],
    ['typed text that reads like a sender header', { content: 'from_date: today\nWhy?', transformedContent: '<now>today</now>\nfrom_date: today\nWhy?' }, undefined, 'analyzed'],
    ['agent', { content: 'Why does it fail?', source: 'agent-7' }, 'agent', 'excluded'],
    ['skill', { content: 'Why use this skill?', source: 'skill-pdf' }, 'skill', 'excluded'],
    ['system', { content: 'Why did the task stop?', source: 'system' }, 'system', 'excluded'],
    ['autopilot sent as system', { content: 'Continue. Why stop?', source: 'system', isAutopilotContinuation: true }, 'autopilot', 'excluded'],
    ['autopilot', { content: 'Continue. Why stop?', source: 'autopilot', isAutopilotContinuation: true }, 'autopilot', 'excluded'],
    ['relayed', { content: 'Why does it fail?', transformedContent: '<relayed_message>\nfrom_session_id: s-1\n</relayed_message>\nWhy does it fail?' }, 'relayed', 'excluded'],
  ];

  it('marks only the messages another sender wrote, through both parser paths', async () => {
    const events: object[] = [{ type: 'session.start', timestamp: '2026-09-30T12:00:00Z', data: { sessionId: 'cli-1', remoteSteerable: true } }];
    for (const [index, [, data]] of turns.entries()) {
      const second = String(index * 2).padStart(2, '0');
      events.push({ type: 'user.message', id: `u${index}`, timestamp: `2026-09-30T12:01:${second}Z`, data });
      events.push({ type: 'assistant.message', timestamp: `2026-09-30T12:01:${second}.500Z`, data: { content: 'Done.' } });
    }
    const file = path.join(tempRoot('cli'), 'events.jsonl');
    writeLines(file, events);
    for (const session of [parseCLIEventsFile(file, 'ws', 'Workspace'), await parseCLIEventsFileAsync(file, 'ws', 'Workspace')]) {
      const requests = session?.requests ?? [];
      expect(requests.map(request => request.userEventId)).toEqual(turns.map((_, index) => `u${index}`));
      expect(kinds(requests)).toEqual(turns.map(([, , kind]) => kind));
      expect(curiosity(requests)).toEqual(turns.map(([, , , kind]) => kind));
    }
  });
});

describe('VS Code (Local Agent, Insiders and Server)', () => {
  const request = (requestId: string, text: string, extra: Record<string, unknown> = {}) => ({
    requestId, timestamp: 1_790_000_000_000 + Number(requestId.replaceAll(/\D/g, '') || 0) * 1000,
    message: { text }, response: [{ value: 'Done.' }], result: { metadata: {} }, ...extra,
  });
  const requests = [
    request('r1', 'Why does the build fail?'),
    request('r2', CODE_ONLY),
    request('r3', '/explain why this fails', { slashCommand: { name: 'explain' } }),
    request('r4', '', { variableData: { variables: [{ kind: 'image', id: 'img', name: 'screenshot.png', value: {} }] } }),
    request('r5', 'Continue', { confirmation: 'Continue' }),
    request('r6', 'Why did the terminal command stop?', { isSystemInitiated: true }),
    request('r7', 'Why does the test fail?', { origin: { kind: 'delegation' } }),
  ];
  const expected = [undefined, undefined, undefined, undefined, undefined, 'system', 'relayed'];

  it.each([
    ['Code', 'Local Agent'],
    ['Code - Insiders', 'Local Agent (Insiders)'],
    ['.vscode-server', 'Local Agent (Server)'],
  ])('marks requests VS Code sent or another session delegated in %s', (edition, harness) => {
    const logsDir = path.join(tempRoot('vscode'), edition, 'User', 'workspaceStorage');
    const file = path.join(logsDir, 'ws', 'chatSessions', 'session.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId: 'vscode-1', creationDate: 1_790_000_000_000, requests }), 'utf-8');
    expect(harnessFromPath(logsDir)).toBe(harness);
    const session = parseSessionFile(file, 'ws', 'Workspace', harnessFromPath(logsDir));
    expect(session?.harness).toBe(harness);
    expect(kinds(session?.requests ?? [])).toEqual(expected);
    expect(curiosity(session?.requests ?? []).slice(5)).toEqual(['excluded', 'excluded']);
  });

  it('reads the flags from incremental JSONL session files', () => {
    const file = path.join(tempRoot('vscode-jsonl'), 'chatSessions', 'session.jsonl');
    writeLines(file, [
      { kind: 0, v: { sessionId: 'vscode-2', creationDate: 1_790_000_000_000, requests: [] } },
      { kind: 2, k: ['requests'], v: requests.slice(0, 1) },
      { kind: 2, k: ['requests'], v: requests.slice(5) },
    ]);
    expect(kinds(parseSessionFile(file, 'ws', 'Workspace', 'Local Agent')?.requests ?? [])).toEqual([undefined, 'system', 'relayed']);
  });
});

/* ---- Claude Code transcript lines ---- */

let claudeClock = 0;
const claudeAt = () => new Date(claudeClock += 1000).toISOString();
const claudeUser = (content: string | object[], extra: Record<string, unknown> = {}) => ({
  type: 'user', timestamp: claudeAt(), sessionId: 'sess-1', cwd: '/Users/me/proj',
  message: { role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content }, ...extra,
});
/** A user line whose content is a string, as Claude logs task notifications. */
const claudeUserString = (content: string) => ({ type: 'user', timestamp: claudeAt(), sessionId: 'sess-1', message: { role: 'user', content } });
const claudeAssistant = (content: object[] = [{ type: 'text', text: 'Done.' }]) => ({
  type: 'assistant', timestamp: claudeAt(), sessionId: 'sess-1',
  message: { role: 'assistant', model: 'claude-sonnet-4', content, usage: { input_tokens: 10, output_tokens: 5 } },
});
const claudeTurn = (line: object) => [line, claudeAssistant()];

function parseClaudeProject(files: Record<string, object[]>) {
  const projectsDir = path.join(tempRoot('claude'), 'projects');
  for (const [relative, lines] of Object.entries(files)) writeLines(path.join(projectsDir, '-Users-me-proj', ...relative.split('/')), lines);
  return parseClaudeSessions(projectsDir).flatMap(result => result.sessions);
}

describe('Claude Code', () => {
  it('marks harness-written lines, and keeps typed prompts, commands and attachments', () => {
    claudeClock = Date.parse('2026-09-30T12:00:00Z');
    const main = [
      ...claudeTurn(claudeUser('Why does the build fail?')),
      ...claudeTurn(claudeUser(CODE_ONLY)),
      ...claudeTurn(claudeUser(URL_ONLY)),
      ...claudeTurn(claudeUser(QUOTE_ONLY)),
      ...claudeTurn(claudeUser([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }])),
      ...claudeTurn(claudeUser([{ type: 'text', text: '<ide_selection>The user selected lines 1 to 2.</ide_selection>' }, { type: 'text', text: 'Why is this slow?' }])),
      claudeUser('<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the diff</command-args>'),
      ...claudeTurn(claudeUser('Review the change for bugs: why does it fail?', { isMeta: true })),
      ...claudeTurn(claudeUser('Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.', { isMeta: true })),
      claudeUser('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'),
      claudeUser('<local-command-stdout>Set model to sonnet</local-command-stdout>'),
      ...claudeTurn(claudeUser('<bash-input>npm test</bash-input>')),
      ...claudeTurn(claudeUser('<bash-stdout>Why? 1 passed</bash-stdout><bash-stderr></bash-stderr>')),
      ...claudeTurn(claudeUserString('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Why did it stop?</summary>\n</task-notification>')),
      claudeUser('Fix the parser.'),
      claudeAssistant([{ type: 'tool_use', id: 'skill-1', name: 'Skill', input: { skill: 'pdf' } }]),
      claudeUser([{ type: 'tool_result', tool_use_id: 'skill-1', content: 'Launching skill: pdf' }]),
      ...claudeTurn(claudeUser('Base directory for this skill: /skills/pdf\n\nWhy use this skill?', { isMeta: true })),
      ...claudeTurn(claudeUser('This session is being continued from a previous conversation that ran out of context. Why?', { isCompactSummary: true, isVisibleInTranscriptOnly: true })),
    ];
    const sub = claudeTurn(claudeUser('Why are the totals wrong?', { isSidechain: true, agentId: 'a1' }));
    const orphan = claudeTurn(claudeUser('Why is the cache stale?', { isSidechain: true, agentId: 'b2', sessionId: 'orphan-1' }));

    const sessions = parseClaudeProject({ 'sess-1.jsonl': main, 'sess-1/subagents/agent-a1.jsonl': sub, 'orphan-1/subagents/agent-b2.jsonl': orphan });
    const parent = sessions.find(session => session.sessionId === 'sess-1');
    expect(kinds(parent?.requests ?? [])).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, 'meta', undefined, 'output', 'system', undefined, 'meta', 'compaction', 'subagent',
    ]);
    expect(curiosity(parent?.requests ?? [])).toEqual([
      'analyzed', 'excluded', 'excluded', 'excluded', 'excluded', 'analyzed',
      'excluded', 'excluded', 'excluded', 'excluded', 'excluded', 'analyzed', 'excluded', 'excluded', 'excluded',
    ]);
    expect(kinds(sessions.find(session => session.sessionId === 'orphan-1')?.requests ?? [])).toEqual(['subagent']);
  });
});

describe('Codex', () => {
  it.each<[string, unknown, NonHumanKind | undefined]>([
    ['cli', 'cli', undefined],
    ['vscode', 'vscode', undefined],
    ['exec', 'exec', undefined],
    ['mcp', 'mcp', undefined],
    ['a review sub-agent', { subagent: 'review' }, 'subagent'],
    ['a spawned thread', { subagent: { thread_spawn: { parent_thread_id: 'thread-1', depth: 1 } } }, 'subagent'],
  ])('marks every prompt of a %s session accordingly', (_label, source, expected) => {
    const sessionsDir = path.join(tempRoot('codex'), 'sessions');
    writeLines(path.join(sessionsDir, '2026', '09', '30', 'rollout-2026-09-30-test.jsonl'), [
      { type: 'session_meta', payload: { id: 'codex-1', cwd: '/Users/me/proj', source } },
      { type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
      { type: 'event_msg', timestamp: '2026-09-30T12:00:00Z', payload: { type: 'user_message', message: 'Why does the build fail?' } },
      { type: 'event_msg', timestamp: '2026-09-30T12:00:01Z', payload: { type: 'agent_message', message: 'Done.' } },
      { type: 'event_msg', timestamp: '2026-09-30T12:00:10Z', payload: { type: 'user_message', message: CODE_ONLY } },
      { type: 'event_msg', timestamp: '2026-09-30T12:00:11Z', payload: { type: 'agent_message', message: 'Done.' } },
    ]);
    const requests = parseCodexSessions(sessionsDir)[0]?.requests ?? [];
    expect(kinds(requests)).toEqual([expected, expected]);
    expect(curiosity(requests)).toEqual(expected ? ['excluded', 'excluded'] : ['analyzed', 'excluded']);
  });
});

/* ---- OpenCode storage ---- */

const typedText = (text: string) => ({ type: 'text', text });
const syntheticText = (text: string) => ({ type: 'text', text, synthetic: true });
const OPENCODE_MESSAGES: Array<[string, object[], NonHumanKind | undefined]> = [
  ['typed prompt', [typedText('Why does the build fail?')], undefined],
  ['code only', [typedText(CODE_ONLY)], undefined],
  ['attachment only', [{ type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' }], undefined],
  ['typed prompt with an attached file', [typedText('Why?'), syntheticText('Called the Read tool with the following input: {}'), { type: 'file', mime: 'text/plain', filename: 'a.ts', url: 'file:///repo/a.ts' }], undefined],
  ['typed /compact', [{ type: 'compaction', auto: false }], undefined],
  ['shell command', [syntheticText('The following tool was executed by the user')], undefined],
  ['automatic compaction', [{ type: 'compaction', auto: true }], 'compaction'],
  ['generated message', [syntheticText('Continue if you have next steps')], 'system'],
];

/** JSON storage with each session holding OPENCODE_MESSAGES. */
function openCodeStorage(sessions: Array<{ id: string; parentID?: string }>): string {
  const storageDir = path.join(tempRoot('opencode'), 'storage');
  for (const { id, parentID } of sessions) {
    const session = { id, directory: '/Users/me/proj', time: { created: 1_790_000_000_000 }, ...(parentID ? { parentID } : {}) };
    writeLines(path.join(storageDir, 'session', 'global', `${id}.json`), [session]);
    for (const [index, [, parts]] of OPENCODE_MESSAGES.entries()) {
      const messageId = `${id}_u${index}`;
      writeLines(path.join(storageDir, 'message', id, `${messageId}.json`), [
        { id: messageId, sessionID: id, role: 'user', time: { created: 1_790_000_000_000 + index * 1000 } },
      ]);
      for (const [partIndex, part] of parts.entries()) {
        const partId = `${messageId}_p${partIndex}`;
        writeLines(path.join(storageDir, 'part', messageId, `${partId}.json`), [{ ...part, id: partId, messageID: messageId, sessionID: id }]);
      }
    }
  }
  return storageDir;
}

/** opencode.db with a root and a child session, each with a typed prompt and an automatic compaction. */
function openCodeDatabase(withParentColumn: boolean): string {
  const dbPath = path.join(tempRoot('opencode-db'), 'opencode.db');
  const database = new DatabaseSync(dbPath);
  database.exec([
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, ${withParentColumn ? 'parent_id TEXT, ' : ''}directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);`,
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    'CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
  ].join('\n'));
  const insertSession = database.prepare(withParentColumn
    ? 'INSERT INTO session VALUES (?, \'project\', ?, \'/Users/me/proj\', \'Project\', \'project\', ?, ?)'
    : 'INSERT INTO session VALUES (?, \'project\', \'/Users/me/proj\', \'Project\', \'project\', ?, ?)');
  const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  const userParts: object[] = [typedText('Why does the build fail?'), { type: 'compaction', auto: true }];
  for (const [id, parent] of [['ses_root', null], ['ses_child', 'ses_root']] as const) {
    if (withParentColumn) insertSession.run(id, parent, 1_790_000_000_000, 1_790_000_100_000);
    else insertSession.run(id, 1_790_000_000_000, 1_790_000_100_000);
    for (const [index, part] of userParts.entries()) {
      const messageId = `${id}_u${index}`;
      const created = 1_790_000_000_000 + index * 1000;
      insertMessage.run(messageId, id, created, created, JSON.stringify({ role: 'user' }));
      insertPart.run(`${messageId}_p0`, id, messageId, created, created, JSON.stringify(part));
    }
  }
  database.close();
  return dbPath;
}

describe('OpenCode', () => {
  const expectedKinds = OPENCODE_MESSAGES.map(([, , kind]) => kind);

  it('marks automatic compactions and generated messages in JSON storage', () => {
    expect(kinds(parseOpenCodeSessions(openCodeStorage([{ id: 'ses_root' }]))[0]?.requests ?? [])).toEqual(expectedKinds);
  });

  it('marks every other prompt of a child session as a sub-agent prompt', () => {
    const sessions = parseOpenCodeSessions(openCodeStorage([{ id: 'ses_root' }, { id: 'ses_child', parentID: 'ses_root' }]));
    const child = sessions.find(session => session.sessionId === 'ses_child');
    expect(kinds(child?.requests ?? [])).toEqual(expectedKinds.map(kind => kind ?? 'subagent'));
    expect(curiosity(child?.requests ?? []).every(kind => kind === 'excluded')).toBe(true);
    expect(kinds(sessions.find(session => session.sessionId === 'ses_root')?.requests ?? [])).toEqual(expectedKinds);
  });

  it.each([true, false])('reads child sessions and parts from opencode.db (parent_id column: %s)', withParentColumn => {
    const sessions = parseOpenCodeSessions(openCodeDatabase(withParentColumn));
    const kindsOf = (id: string) => kinds(sessions.find(session => session.sessionId === id)?.requests ?? []);
    expect(kindsOf('ses_root')).toEqual([undefined, 'compaction']);
    expect(kindsOf('ses_child')).toEqual(withParentColumn ? ['subagent', 'compaction'] : [undefined, 'compaction']);
  });
});

describe('Xcode', () => {
  const hasSqlite3 = (() => {
    try {
      execFileSync('sqlite3', ['-version'], { stdio: 'ignore', cwd: os.tmpdir() });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasSqlite3)('keeps every user turn, which Copilot for Xcode records only when the user sends it', async () => {
    const xcodeBase = tempRoot('xcode');
    const file = path.join(xcodeBase, 'machine', 'conversations', 'turns.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    database.exec([
      'CREATE TABLE Conversation (id TEXT, title TEXT, createdAt INTEGER, updatedAt INTEGER);',
      'CREATE TABLE Turn (id TEXT, conversationID TEXT, role TEXT, data TEXT, createdAt INTEGER);',
    ].join('\n'));
    database.prepare('INSERT INTO Conversation VALUES (?, ?, ?, ?)').run('conv', 'Conversation', 1_790_000_000, 1_790_000_010);
    const insertTurn = database.prepare('INSERT INTO Turn VALUES (?, ?, ?, ?, ?)');
    const userTurns = [
      { content: 'Why does the build fail?', requestType: 'conversation' },
      { content: CODE_ONLY, requestType: 'conversation' },
      { content: '', requestType: 'conversation', contentImageReferences: [{ fileUrl: 'file:///tmp/shot.png' }] },
      { content: '/fix', requestType: 'conversation' },
      { content: 'Review the staged changes', requestType: 'codeReview' },
    ];
    for (const [index, data] of userTurns.entries()) {
      insertTurn.run(`user-${index}`, 'conv', 'user', JSON.stringify(data), 1_790_000_000 + index * 2);
      insertTurn.run(`answer-${index}`, 'conv', 'assistant', JSON.stringify({ content: 'Done.', turnStatus: 'completed' }), 1_790_000_001 + index * 2);
    }
    database.close();

    for (const sessions of [parseXcodeDatabases(xcodeBase), await parseXcodeDatabasesAsync(xcodeBase)]) {
      expect(sessions[0]?.requests.map(request => request.requestId)).toEqual(userTurns.map((_, index) => `user-${index}`));
      expect(kinds(sessions[0]?.requests ?? [])).toEqual(userTurns.map(() => undefined));
    }
  });
});
