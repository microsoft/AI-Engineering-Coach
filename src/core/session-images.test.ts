/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAllLogs } from './parser';
import { collectExternalHarnessesAsync } from './parser-harnesses';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { parseClaudeSessions } from './parser-claude';
import { parseCodexSessions } from './parser-codex';
import { parseOpenCodeSessions } from './parser-opencode';
import { parseSessionFile, processWorkspaceEntryAsync } from './parser-vscode';
import { extractSourceImages, loadSourceSession } from './session-images';
import { Analyzer } from './analyzer';
import type { SessionSource } from './cache';
import { loadSessionFromDisk, setMemoryCache } from './cache';
import { createRequest, type ParseContext } from './parser-shared';
import { loadSessionDetails } from './session-image-loader';

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));
vi.mock('./parser-shared', async importOriginal => {
  const actual = await importOriginal<typeof import('./parser-shared')>();
  return { ...actual, createRequest: vi.fn(actual.createRequest) };
});
vi.mock('./session-image-loader', () => ({
  loadSessionDetails: vi.fn((source: SessionSource, sessionId: string) => Promise.resolve(loadSourceSession(source, sessionId))),
}));

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = `data:image/png;base64,${base64}`;
const alternateBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const alternateImage = `data:image/png;base64,${alternateBase64}`;
const timestamp = '2026-10-19T10:00:00Z';
let root: string;
let sources: Map<string, SessionSource>;

function write(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function jsonl(file: string, lines: unknown[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
  return file;
}

function claudeUser(id: string, content: unknown[], sessionId = 'claude-session'): object {
  return { type: 'user', uuid: id, sessionId, timestamp, cwd: root, message: { role: 'user', content } };
}

function claudeImage(): object {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } };
}

function makeClaude(): string {
  return jsonl(path.join(root, '.claude', 'projects', 'project', 'claude-session.jsonl'), [
    claudeUser('claude-image', [claudeImage()]),
  ]);
}

function makeCodex(): string {
  return jsonl(path.join(root, '.codex', 'sessions', 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-session', cwd: root } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Screenshot', images: [image] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Screenshot' }, { type: 'input_image', image_url: image },
    ] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First answer' }] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: image }] } },
  ]);
}

function makeOpenCodeStorage(): string {
  const storage = path.join(root, '.local', 'share', 'opencode', 'storage');
  write(path.join(storage, 'session', 'global', 'oc-session.json'), { id: 'oc-session', directory: root });
  write(path.join(storage, 'message', 'oc-session', 'oc-user.json'), {
    id: 'oc-user', sessionID: 'oc-session', role: 'user', time: { created: Date.parse(timestamp) },
  });
  write(path.join(storage, 'part', 'oc-user', 'part-image.json'), {
    id: 'part-image', messageID: 'oc-user', type: 'file', mime: 'image/png', url: image,
  });
  return storage;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-session-images-'));
  sources = new Map();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, '.local', 'share'));
  vi.stubEnv('LOCALAPPDATA', path.join(root, 'local-appdata'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('harness-aware image loading', () => {
  it.each([
    ['Code', 'Local Agent'],
    ['Code - Insiders', 'Local Agent (Insiders)'],
    ['.vscode-server', 'Local Agent (Server)'],
    ['.vscode-server-insiders', 'Local Agent (Server Insiders)'],
  ])('registers VS Code image sources in synchronous and asynchronous parsing: %s', async (edition, harness) => {
    const logsDir = path.join(root, edition, 'workspaceStorage');
    write(path.join(logsDir, 'ws', 'workspace.json'), { folder: pathToFileURL(root).href });
    write(path.join(logsDir, 'ws', 'chatSessions', 'session.json'), {
      sessionId: 'vscode', creationDate: Date.parse(timestamp), requests: [{
        requestId: 'vscode-user', timestamp: Date.parse(timestamp), message: { text: 'Screenshot' },
        variableData: { variables: [{ kind: 'image', data: [...Buffer.from(base64, 'base64')] }] },
      }],
    });
    const parsed = parseAllLogs([logsDir]);
    expect(parsed.sessions[0].harness).toBe(harness);
    expect(parsed.sessionSourceIndex.get('vscode')?.workspaceRootPath).toBe(root);
    expect(extractSourceImages(parsed.sessionSourceIndex.get('vscode')!, 'vscode', 'vscode-user')).toEqual([image]);
    const context: ParseContext = { sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: sources, aiLoc: 0 };
    await processWorkspaceEntryAsync(logsDir, 'ws', harness, context);
    expect(extractSourceImages(sources.get('vscode')!, 'vscode', 'vscode-user')).toEqual([image]);
  });

  it.each([false, true])('matches Copilot user attachments to normalized assistant IDs (App=%s)', async app => {
    const file = path.join(root, 'screen.png');
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    const events = jsonl(path.join(root, 'events.jsonl'), [
      { type: 'session.start', timestamp, data: { sessionId: 'copilot-session', ...(app ? { remoteSteerable: true } : {}) } },
      { type: 'user.message', id: 'user-event', timestamp, data: { content: 'Screenshot', attachments: [{ type: 'file', path: file }] } },
      { type: 'assistant.message', id: 'first-answer', timestamp, data: { content: 'Working' } },
      { type: 'assistant.message', id: 'last-answer', timestamp, data: { content: 'Done', phase: 'final' } },
      { type: 'user.message', id: 'plain-user', timestamp, data: { content: 'No image' } },
      { type: 'assistant.message', id: 'plain-answer', timestamp, data: { content: 'Text' } },
    ]);
    const source: SessionSource = { kind: 'cli-events', filePath: events, workspaceId: 'ws', workspaceName: 'Workspace', harness: 'Copilot' };
    for (const session of [parseCLIEventsFile(events, 'ws', 'Workspace'), await parseCLIEventsFileAsync(events, 'ws', 'Workspace')]) {
      expect(session?.requests.map(request => request.variableKinds.image ?? 0)).toEqual([1, 0]);
      expect(session?.requests[0]).toMatchObject({ requestId: 'last-answer', userEventId: 'user-event' });
    }
    expect(extractSourceImages(source, 'copilot-session', 'last-answer')).toEqual([image]);
    expect(extractSourceImages(source, 'copilot-session', 'plain-answer')).toEqual([]);
    expect(extractSourceImages(source, 'copilot-session', 'user-event')).toEqual([]);
  });

  it('supports Copilot image variables and generated IDs when no assistant event exists', () => {
    const file = jsonl(path.join(root, 'events.jsonl'), [
      { type: 'session.start', data: { sessionId: 'pending' } },
      { type: 'user.message', data: { content: '', variables: [{ kind: 'image', data: [...Buffer.from(base64, 'base64')] }] } },
    ]);
    const source: SessionSource = { kind: 'cli-events', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Copilot' };
    const session = loadSourceSession(source, 'pending');
    expect(session?.requests[0].variableKinds.image).toBe(1);
    expect(extractSourceImages(source, 'pending', 'pending:cli:0')).toEqual([image]);
  });

  it.each([false, true])('matches the cached Copilot user event after the assistant identity changes (App=%s)', app => {
    const file = jsonl(path.join(root, 'growing-events.jsonl'), [
      { type: 'session.start', data: { sessionId: 'growing', ...(app ? { remoteSteerable: true } : {}) } },
      { type: 'user.message', id: 'stable-user', data: { content: 'Screenshot', variables: [{ kind: 'image', value: image }] } },
    ]);
    const source: SessionSource = { kind: 'cli-events', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Copilot' };
    for (const assistantId of ['first-answer', 'later-answer']) {
      const cached = parseCLIEventsFile(file, 'ws', 'WS')!.requests[0];
      fs.appendFileSync(file, `\n${JSON.stringify({ type: 'assistant.message', id: assistantId, data: { content: 'Working' } })}`);
      expect(extractSourceImages(source, 'growing', cached.requestId, { userEventId: cached.userEventId, requestIndex: 0 })).toEqual([image]);
    }
    expect(extractSourceImages(source, 'growing', 'growing:cli:0', { userEventId: 'missing-user', requestIndex: 0 })).toEqual([]);
  });

  it('uses an explicit cached turn index when a growing Copilot record has no native user ID', () => {
    const file = jsonl(path.join(root, 'legacy-events.jsonl'), [
      { type: 'session.start', data: { sessionId: 'legacy' } },
      { type: 'user.message', data: { content: 'Text only' } },
      { type: 'assistant.message', id: 'plain-answer', data: { content: 'Done' } },
      { type: 'user.message', data: { content: 'Screenshot', variables: [{ kind: 'image', value: image }] } },
    ]);
    const source: SessionSource = { kind: 'cli-events', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Copilot' };
    const cached = parseCLIEventsFile(file, 'ws', 'WS')!.requests[1];
    fs.appendFileSync(file, `\n${JSON.stringify({ type: 'assistant.message', id: 'new-answer', data: { content: 'Working' } })}`);
    expect(extractSourceImages(source, 'legacy', cached.requestId, { requestIndex: 1 })).toEqual([image]);
  });

  it.each(['cli', 'codex', 'claude'])('extracts 30 %s image moments without rebuilding any normalized requests', harness => {
    const lines: object[] = harness === 'cli'
      ? [{ type: 'session.start', data: { sessionId: 'many-images' } }]
      : harness === 'codex' ? [{ type: 'session_meta', payload: { id: 'many-images', cwd: root } }]
        : [{ type: 'queue-operation', sessionId: 'many-images' }];
    for (let index = 0; index < 30; index++) {
      if (harness === 'cli') {
        lines.push(
          { type: 'user.message', id: `user-${index}`, data: { content: `Screenshot ${index}`, variables: [{ kind: 'image', value: image }] } },
          { type: 'assistant.message', id: `answer-${index}`, data: { content: 'Done' } },
        );
      } else if (harness === 'codex') {
        lines.push(
          { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: `Screenshot ${index}` }, { type: 'input_image', image_url: image }] } },
          { type: 'response_item', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] } },
        );
      } else {
        lines.push(
          claudeUser(`user-${index}`, [{ type: 'text', text: `Screenshot ${index}` }, claudeImage()], 'many-images'),
          { type: 'assistant', sessionId: 'many-images', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
        );
      }
    }
    const file = jsonl(path.join(root, harness, ...(harness === 'claude' ? ['project'] : []), 'events.jsonl'), lines);
    const session = harness === 'cli' ? parseCLIEventsFile(file, 'ws', 'WS')!
      : harness === 'codex' ? parseCodexSessions(path.dirname(file), undefined, sources)[0]
        : parseClaudeSessions(path.dirname(path.dirname(file)), undefined, sources)[0].sessions[0];
    const source: SessionSource = harness === 'cli'
      ? { kind: 'cli-events', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Copilot' }
      : sources.get(session.sessionId)!;
    expect(session.requests).toHaveLength(30);
    vi.mocked(createRequest).mockClear();
    for (const [index, request] of session.requests.entries()) {
      expect(extractSourceImages(source, session.sessionId, request.requestId, { userEventId: request.userEventId, requestIndex: index }))
        .toEqual([image]);
    }
    expect(createRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves generated Claude IDs and relative image roots (cwd follows image=%s)', rootAfterImage => {
    const projects = path.join(root, 'claude-relative');
    const workspace = path.join(root, 'actual-workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'screenshot.png'), Buffer.from(base64, 'base64'));
    jsonl(path.join(projects, 'project', 'session.jsonl'), [
      { type: 'queue-operation', sessionId: 'generated' },
      { type: 'user', sessionId: 'generated', ...(!rootAfterImage ? { cwd: workspace } : {}), message: { role: 'user', content: 'Earlier text turn' } },
      { type: 'user', sessionId: 'generated', ...(!rootAfterImage ? { cwd: workspace } : {}), message: {
        role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'screenshot.png' } }],
      } },
      ...(rootAfterImage ? [{ type: 'user', sessionId: 'generated', cwd: workspace, message: { role: 'user', content: 'Later text turn' } }] : []),
    ]);
    const session = parseClaudeSessions(projects, undefined, sources)[0].sessions[0];
    const source = { ...sources.get(session.sessionId)!, workspaceRootPath: path.join(root, 'parent-workspace') };
    expect(session.requests[1].requestId).toMatch(/^generated:claude:[a-f0-9]{32}:1$/);
    expect(extractSourceImages(source, session.sessionId, session.requests[1].requestId)).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, 'missing')).toEqual([]);
  });

  it('uses the matched Claude user turn directory when cwd changes within a transcript', () => {
    const projects = path.join(root, 'claude-directories');
    const first = path.join(root, 'first-workspace');
    const second = path.join(root, 'second-workspace');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'screenshot.png'), Buffer.from(base64, 'base64'));
    fs.writeFileSync(path.join(second, 'screenshot.png'), Buffer.from(alternateBase64, 'base64'));
    const content = [{ type: 'image', source: { type: 'url', url: 'screenshot.png' } }];
    jsonl(path.join(projects, 'project', 'session.jsonl'), [
      { type: 'user', uuid: 'first-user', sessionId: 'directories', cwd: first, message: { role: 'user', content } },
      { type: 'user', uuid: 'second-user', sessionId: 'directories', cwd: second, message: { role: 'user', content } },
    ]);
    const session = parseClaudeSessions(projects, undefined, sources)[0].sessions[0];
    const source = sources.get(session.sessionId)!;
    expect(source.workspaceRootPath).toBe(first);
    expect(extractSourceImages(source, session.sessionId, 'first-user')).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, 'second-user')).toEqual([alternateImage]);
  });

  it('keeps UUID-less parent and subagent images distinct within the same Claude session', () => {
    const projects = path.join(root, 'claude-scoped-ids');
    const project = path.join(projects, 'project');
    jsonl(path.join(project, 'same-session.jsonl'), [
      { type: 'user', sessionId: 'same-session', cwd: root, message: { role: 'user', content: [claudeImage()] } },
    ]);
    jsonl(path.join(project, 'same-session', 'subagents', 'agent-child.jsonl'), [
      { type: 'user', sessionId: 'same-session', cwd: root, message: {
        role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: alternateBase64 } }],
      } },
    ]);
    const session = parseClaudeSessions(projects, undefined, sources)[0].sessions[0];
    const source = sources.get(session.sessionId)!;
    expect(session.requests).toHaveLength(2);
    expect(new Set(session.requests.map(request => request.requestId)).size).toBe(2);
    expect(extractSourceImages(source, session.sessionId, session.requests[0].requestId)).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, session.requests[1].requestId)).toEqual([alternateImage]);
  });

  it('keeps targeted Codex image selection aligned with orphan replies, tools, tokens, mirrors, and aborted turns', () => {
    jsonl(path.join(root, 'codex-parity', 'events.jsonl'), [
      { type: 'session_meta', payload: { id: 'parity', cwd: root } },
      { type: 'response_item', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Earlier reply' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'First screenshot', images: [image] } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'First screenshot' }, { type: 'input_image', image_url: image }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'write_file', arguments: '{"path":"test.ts","content":"new code"}', call_id: 'write' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'write', output: { success: true } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 3 } } } },
      { type: 'response_item', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: '', images: [image] } },
      { type: 'event_msg', payload: { type: 'user_message', message: '', images: [image, image] } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_image', image_url: image }, { type: 'input_image', image_url: image }] } },
      { type: 'event_msg', payload: { type: 'turn_aborted' } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Final screenshot' }, { type: 'input_image', image_url: image }] } },
    ]);
    const session = parseCodexSessions(path.join(root, 'codex-parity'), undefined, sources)[0];
    const source = sources.get(session.sessionId)!;
    expect(session.requests.map(request => request.variableKinds.image ?? 0)).toEqual([0, 1, 1, 2, 1]);
    vi.mocked(createRequest).mockClear();
    for (const [index, request] of session.requests.entries()) {
      const expected = Array<string>(request.variableKinds.image ?? 0).fill(image);
      expect(extractSourceImages(source, session.sessionId, request.requestId, { requestIndex: index })).toEqual(expected);
    }
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('loads VS Code JSON and applies JSONL image patches before extraction', () => {
    const request = { requestId: 'vscode-user', message: { text: 'Screenshot' }, variableData: { variables: [] } };
    const variable = { kind: 'image', data: [...Buffer.from(base64, 'base64')] };
    const json = write(path.join(root, 'session.json'), { sessionId: 'vs-session', requests: [{ ...request, variableData: { variables: [variable] } }] });
    const patched = jsonl(path.join(root, 'session.jsonl'), [
      { kind: 0, v: { sessionId: 'vs-session', requests: [request] } },
      { kind: 1, k: ['requests', 0, 'variableData', 'variables'], v: [variable] },
    ]);
    fs.appendFileSync(patched, '\nmalformed line\n');
    for (const file of [json, patched]) {
      const source: SessionSource = { kind: 'vscode-session-file', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Local Agent' };
      expect(parseSessionFile(file, 'ws', 'WS', 'Local Agent')?.requests[0].variableKinds.image).toBe(1);
      expect(extractSourceImages(source, 'vs-session', 'vscode-user')).toEqual([image]);
      expect(extractSourceImages(source, 'vs-session', 'unknown')).toEqual([]);
    }
  });

  it('loads Claude image-only requests, merged subagents, and orphan subagent sources', () => {
    makeClaude();
    const project = path.join(root, '.claude', 'projects', 'project');
    jsonl(path.join(project, 'claude-session', 'subagents', 'agent-child.jsonl'), [
      claudeUser('child-image', [claudeImage()]),
    ]);
    jsonl(path.join(project, 'orphan', 'subagents', 'agent-orphan.jsonl'), [
      claudeUser('orphan-image', [claudeImage()], 'orphan'),
    ]);
    const results = parseClaudeSessions(path.dirname(project), undefined, sources);
    const sessions = results.flatMap(result => result.sessions);
    expect(sessions.find(session => session.sessionId === 'claude-session')?.requests).toHaveLength(2);
    expect(sources.get('claude-session')?.additionalFilePaths).toHaveLength(1);
    for (const [sessionId, requestId] of [['claude-session', 'claude-image'], ['claude-session', 'child-image'], ['orphan', 'orphan-image']]) {
      const source = sources.get(sessionId)!;
      vi.mocked(createRequest).mockClear();
      expect(extractSourceImages(source, sessionId, requestId)).toEqual([image]);
      expect(createRequest).not.toHaveBeenCalled();
      expect(loadSourceSession(source, sessionId)?.requests.some(request => request.requestId === requestId)).toBe(true);
      expect(extractSourceImages(source, sessionId, 'unknown')).toEqual([]);
    }
  });

  it('counts Codex mirrors once and matches successive image-only response items', () => {
    makeCodex();
    const session = parseCodexSessions(path.join(root, '.codex', 'sessions'), undefined, sources)[0];
    expect(session.requests.map(request => request.variableKinds.image)).toEqual([1, 1]);
    const source = sources.get(session.sessionId)!;
    for (const request of session.requests) expect(extractSourceImages(source, session.sessionId, request.requestId)).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, 'unknown')).toEqual([]);
  });

  it('does not merge consecutive Codex image-only requests without an intervening assistant', () => {
    jsonl(path.join(root, 'codex', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: 'image-only', cwd: root } },
      { type: 'response_item', timestamp, payload: { role: 'user', content: [{ type: 'input_image', image_url: image }] } },
      { type: 'response_item', timestamp, payload: { role: 'user', content: [{ type: 'input_image', image_url: image }, { type: 'input_image', image_url: image }] } },
    ]);
    const session = parseCodexSessions(path.join(root, 'codex'), undefined, sources)[0];
    expect(session.requests.map(request => request.variableKinds.image)).toEqual([1, 2]);
    const source = sources.get(session.sessionId)!;
    expect(extractSourceImages(source, session.sessionId, session.requests[1].requestId)).toEqual([image, image]);
  });

  it('does not merge consecutive Codex image-only event records before any assistant activity', () => {
    jsonl(path.join(root, 'codex', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: 'image-events', cwd: root } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '', images: [image] } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '', images: [image, image] } },
    ]);
    const session = parseCodexSessions(path.join(root, 'codex'), undefined, sources)[0];
    expect(session.requests.map(request => request.variableKinds.image)).toEqual([1, 2]);
    const source = sources.get(session.sessionId)!;
    expect(extractSourceImages(source, session.sessionId, session.requests[0].requestId)).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, session.requests[1].requestId)).toEqual([image, image]);
  });

  it.each([false, true])('retains inline Codex payloads when a mirrored record has more unavailable references (response first=%s)', responseFirst => {
    const event = { type: 'event_msg', timestamp, payload: {
      type: 'user_message', message: 'Screenshot', file_ids: ['unavailable-file'], local_images: ['deleted.png'],
    } };
    const response = { type: 'response_item', timestamp, payload: {
      role: 'user', content: [{ type: 'input_text', text: 'Screenshot' }, { type: 'input_image', image_url: image }],
    } };
    jsonl(path.join(root, 'codex', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: 'mirror-payloads', cwd: root } },
      ...(responseFirst ? [response, event] : [event, response]),
    ]);
    const session = parseCodexSessions(path.join(root, 'codex'), undefined, sources)[0];
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].variableKinds.image).toBe(2);
    expect(extractSourceImages(sources.get(session.sessionId)!, session.sessionId, session.requests[0].requestId)).toEqual([image]);
  });

  it('counts Codex local files and unavailable file IDs without treating remote IDs as paths', () => {
    const file = path.join(root, 'screen.png');
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    const events = jsonl(path.join(root, 'codex', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: 'local-images', cwd: root } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Screenshot', local_images: ['screen.png'], file_ids: ['file-remote-only'] } },
    ]);
    const session = parseCodexSessions(path.dirname(events), undefined, sources)[0];
    expect(session.requests[0].variableKinds.image).toBe(2);
    expect(extractSourceImages(sources.get(session.sessionId)!, session.sessionId, session.requests[0].requestId)).toEqual([image]);
  });

  it('counts and loads OpenCode image parts from legacy JSON storage', () => {
    const storage = makeOpenCodeStorage();
    const session = parseOpenCodeSessions(storage, undefined, sources)[0];
    expect(session.requests[0].variableKinds.image).toBe(1);
    const source = sources.get(session.sessionId)!;
    expect(extractSourceImages(source, session.sessionId, 'oc-user')).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, 'unknown')).toEqual([]);
    const readdir = vi.spyOn(fs, 'readdirSync');
    expect(loadSourceSession(source, session.sessionId)?.requests[0].variableKinds.image).toBe(1);
    expect(readdir.mock.calls.map(([directory]) => String(directory))).toEqual([
      path.join(storage, 'message', 'oc-session'),
      path.join(storage, 'part', 'oc-user'),
    ]);
  });

  it('counts and loads OpenCode SQLite image parts using both session and user-message IDs', () => {
    const file = path.join(root, 'opencode.db');
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('oc-db', 'project', '', 'Project', 'project', 1, 2);
      INSERT INTO message VALUES ('user', 'oc-db', 1, 1, '{"role":"user"}');
      INSERT INTO message VALUES ('assistant', 'oc-db', 2, 2, '{"role":"assistant"}');
    `);
    const insert = database.prepare('INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)');
    const data = JSON.stringify({ type: 'file', mime: 'image/png', url: image });
    insert.run('part-user', 'oc-db', 'user', data);
    insert.run('part-assistant', 'oc-db', 'assistant', data);
    insert.run('part-other-session', 'other-session', 'user', data);
    database.close();
    const session = parseOpenCodeSessions(file, undefined, sources)[0];
    expect(session.requests[0].variableKinds.image).toBe(1);
    const source = sources.get('oc-db')!;
    expect(extractSourceImages(source, 'oc-db', 'user')).toEqual([image]);
    expect(extractSourceImages(source, 'oc-db', 'assistant')).toEqual([]);
    expect(extractSourceImages(source, 'wrong-session', 'user')).toEqual([]);
    expect(extractSourceImages(source, 'oc-db', "' OR 1=1 --")).toEqual([]);
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    expect(loadSourceSession(source, 'oc-db')?.requests[0].variableKinds.image).toBe(1);
    expect(prepare.mock.calls.map(([sql]) => sql)).toHaveLength(3);
    expect(prepare.mock.calls.every(([sql]) => / WHERE (?:id|session_id) = \?/.test(sql))).toBe(true);
  });

  it('registers loadable external sources during cold parsing and asynchronous refresh', async () => {
    makeClaude();
    makeCodex();
    makeOpenCodeStorage();
    const result = parseAllLogs([]);
    setMemoryCache(result, {});
    const gallery = new Analyzer(result.sessions, result.editLocIndex).getImageGallery();
    expect(gallery.moments).toHaveLength(4);
    vi.mocked(loadSessionDetails).mockClear();
    for (const moment of gallery.moments) {
      expect(extractSourceImages(result.sessionSourceIndex.get(moment.sessionId)!, moment.sessionId, moment.id)).toEqual([image]);
      expect((await loadSessionFromDisk(moment.sessionId))?.requests.some(request => request.requestId === moment.id)).toBe(true);
      expect(loadSessionDetails).toHaveBeenCalledWith(result.sessionSourceIndex.get(moment.sessionId), moment.sessionId);
    }
    sources.set('deleted-session', { kind: 'claude-jsonl', filePath: 'deleted.jsonl', workspaceId: 'ws', workspaceName: 'WS', harness: 'Claude' });
    await collectExternalHarnessesAsync(new Map(), [], new Map(), {}, sources);
    expect(sources.has('deleted-session')).toBe(false);
    expect([...sources.values()].map(source => source.kind).sort()).toEqual(['claude-jsonl', 'codex-jsonl', 'opencode-storage']);
    expect(JSON.stringify([...sources])).not.toContain(base64);
  });
});
