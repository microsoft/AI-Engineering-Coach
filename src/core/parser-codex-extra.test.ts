/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parseCodexSessions } from './parser-codex';

type CodexFixture = {
  relativePath: string;
  content: string | object[];
};

function withCodexRoot(run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parser-test-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    run(sessionsDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function stringifyLines(lines: object[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n');
}

function writeCodexFixture(sessionsDir: string, relativePath: string, content: string | object[]): void {
  const filePath = path.join(sessionsDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === 'string' ? content : stringifyLines(content), 'utf-8');
}

function withCodexFile(lines: object[], run: (sessionsDir: string) => void): void {
  withCodexRoot((sessionsDir) => {
    writeCodexFixture(sessionsDir, '2025/06/15/rollout-2025-06-15-test.jsonl', lines);
    run(sessionsDir);
  });
}

function withCodexRawFile(content: string, run: (sessionsDir: string) => void): void {
  withCodexRoot((sessionsDir) => {
    writeCodexFixture(sessionsDir, '2025/06/15/rollout-2025-06-15-test.jsonl', content);
    run(sessionsDir);
  });
}

function withCodexFiles(files: CodexFixture[], run: (sessionsDir: string) => void): void {
  withCodexRoot((sessionsDir) => {
    for (const file of files) writeCodexFixture(sessionsDir, file.relativePath, file.content);
    run(sessionsDir);
  });
}

function parseSingleSession(lines: object[]) {
  let session: ReturnType<typeof parseCodexSessions>[number] | undefined;
  withCodexFile(lines, (sessionsDir) => {
    const sessions = parseCodexSessions(sessionsDir);
    expect(sessions).toHaveLength(1);
    session = sessions[0];
  });
  return session!;
}

describe('parseCodexSessions extra coverage', () => {
  it('captures web hosts from both function-call formats and resets source context each turn', () => {
    const source = parseSingleSession([
      { type: 'session_meta', payload: { id: 's', cwd: '/repo' } },
      { type: 'event_msg', timestamp: '2026-09-30T12:00:00Z', payload: { type: 'user_message', message: 'Why?' } },
      { type: 'event_msg', payload: { type: 'function_call', name: 'web_fetch', arguments: { url: 'https://docs.python.org/3/' } } },
      { type: 'response_item', payload: { type: 'function_call', name: 'web_fetch', arguments: '{"url":"https://learn.microsoft.com/typescript"}' } },
      { type: 'event_msg', timestamp: '2026-09-30T12:01:00Z', payload: { type: 'user_message', message: 'How?' } },
      { type: 'event_msg', payload: { type: 'assistant_message', content: 'An answer.' } },
    ]);
    expect(source.requests.map(request => request.webDomains)).toEqual([['docs.python.org', 'learn.microsoft.com'], []]);
  });

  it('distinguishes final answers from reasoning and captures freeform patch paths', () => {
    const source = parseSingleSession([
      { type: 'session_meta', payload: { id: 's', cwd: '/repo' } },
      { type: 'event_msg', timestamp: '2026-09-30T12:00:00Z', payload: { type: 'user_message', message: 'Why?' } },
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'I should inspect this.' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Update File: src/a.ts\n+x\n' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: '{"agent_type":"research"}' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'An answer.' }] } },
      { type: 'event_msg', timestamp: '2026-09-30T12:01:00Z', payload: { type: 'user_message', message: 'How?' } },
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Still thinking.' } },
    ]);
    expect(source.requests).toMatchObject([
      { answerEvidence: 'final', editedFiles: ['src/a.ts'], toolsUsed: ['apply_patch', 'spawn_agent'], investigationDelegations: ['research'] },
      { answerEvidence: 'missing', investigationDelegations: [] },
    ]);
  });

  describe('empty and invalid input', () => {
    it('returns no sessions for an empty file', () => {
      withCodexRawFile('', (sessionsDir) => {
        expect(parseCodexSessions(sessionsDir)).toEqual([]);
      });
    });

    it('returns no sessions for invalid JSON lines only', () => {
      withCodexRawFile('{not valid json}\nstill not json\n', (sessionsDir) => {
        expect(parseCodexSessions(sessionsDir)).toEqual([]);
      });
    });

    it('ignores invalid JSON lines when valid records exist', () => {
      const validLines = stringifyLines([
        { type: 'session_meta', payload: { id: 'sess-invalid-mixed', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'hello' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'world' } },
      ]);

      withCodexRawFile(`{not valid json}\n${validLines}\nnot json either`, (sessionsDir) => {
        const sessions = parseCodexSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].requests[0].messageText).toBe('hello');
      });
    });

    it('falls back to the file name when session_meta is missing', () => {
      withCodexRawFile([
        JSON.stringify({ type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'hello' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'world' } }),
      ].join('\n'), (sessionsDir) => {
        const sessions = parseCodexSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].sessionId).toBe('rollout-2025-06-15-test');
        expect(sessions[0].workspaceName).toBe('unknown');
      });
    });
  });

  describe('function call handling', () => {
    it('extracts edited files from write_file event arguments', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-write-event', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'create file' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'function_call', name: 'write_file', arguments: { file_path: 'src/new.ts' } } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['write_file']);
      expect(session.requests[0].editedFiles).toEqual(['src/new.ts']);
    });

    it('extracts edited files from edit_file event arguments', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-edit-event', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'edit file' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'function_call', name: 'edit_file', arguments: { filename: 'src/app.ts' } } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['edit_file']);
      expect(session.requests[0].editedFiles).toEqual(['src/app.ts']);
    });

    it('extracts edited files from path arguments on write tools', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-create-event', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'create path file' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'function_call', name: 'create_file', arguments: { path: 'src/feature.ts' } } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['create_file']);
      expect(session.requests[0].editedFiles).toEqual(['src/feature.ts']);
    });

    it('keeps non-writing tools without marking edited files', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-read-event', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'read file' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'function_call', name: 'read_file', arguments: { file_path: 'src/app.ts' } } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['read_file']);
      expect(session.requests[0].editedFiles).toEqual([]);
    });
  });

  describe('turn flushing and cancellation', () => {
    it('flushes turns when a second user message arrives', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-multi-turn', cwd: '/Users/me/project' } },
        { type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'first' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'one' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:10Z', payload: { type: 'user_message', message: 'second' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:11Z', payload: { type: 'assistant_message', content: 'two' } },
      ]);

      expect(session.requests).toHaveLength(2);
      expect(session.requests.map(request => request.messageText)).toEqual(['first', 'second']);
      expect(session.requests.map(request => request.responseText)).toEqual(['one', 'two']);
    });

    it('uses payload.text for user_message events when message is absent', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-user-text', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', text: 'from text field' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'ok' } },
      ]);

      expect(session.requests[0].messageText).toBe('from text field');
    });

    it('marks turn_aborted requests as canceled', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-aborted-request', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'stop' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'turn_aborted' } },
      ]);

      expect(session.requests[0].isCanceled).toBe(true);
    });

    it('classifies empty aborted turns as aborted sessions', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-aborted-session', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'stop early' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'turn_aborted' } },
      ]);

      expect(session.endReason).toBe('aborted');
    });
  });

  describe('response_item handling', () => {
    it('creates a user message from user response_item content', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-user-response-item', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'hello from item' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'hi there' }] } },
      ]);

      expect(session.requests[0].messageText).toBe('hello from item');
    });

    it('ignores placeholder user response_item content that starts with angle brackets', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-user-placeholder', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: '<system>' }, { type: 'input_text', text: 'real prompt' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'done' }] } },
      ]);

      expect(session.requests[0].messageText).toBe('real prompt');
    });

    it('adds assistant response_item output_text to the response', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-assistant-response-item', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'hello' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'reply text' }] } },
      ]);

      expect(session.requests[0].responseText).toBe('reply text');
    });

    it('joins multiple assistant response_item texts with newlines', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-assistant-multi-text', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'hello' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'line one' }, { type: 'output_text', text: 'line two' }] } },
      ]);

      expect(session.requests[0].responseText).toBe('line one\nline two');
    });

    it('records tools and edited files from function_call response_items with JSON string arguments', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-function-item-string', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'write it' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'function_call', name: 'write_file', arguments: '{"path":"src/generated.ts"}' } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['write_file']);
      expect(session.requests[0].editedFiles).toEqual(['src/generated.ts']);
    });

    it('records tools and edited files from function_call response_items with object arguments', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-function-item-object', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'edit it' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'function_call', name: 'edit_file', arguments: { filename: 'src/main.ts' } } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['edit_file']);
      expect(session.requests[0].editedFiles).toEqual(['src/main.ts']);
    });

    it('keeps function_call tools when response_item arguments are invalid JSON', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-function-item-invalid', cwd: '/Users/me/project' } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:00Z', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'try it' }] } },
        { type: 'response_item', timestamp: '2025-06-15T10:00:01Z', payload: { role: 'assistant', type: 'function_call', name: 'write_file', arguments: '{not json}' } },
      ]);

      expect(session.requests[0].toolsUsed).toEqual(['write_file']);
      expect(session.requests[0].editedFiles).toEqual([]);
    });
  });

  describe('reasoning effort and model switching', () => {
    it('applies turn_context effort to requests', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-effort-high', cwd: '/Users/me/project' } },
        { type: 'turn_context', payload: { model: 'gpt-5.3-codex', effort: 'high' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'think hard' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'done' } },
      ]);

      expect(session.requests[0].reasoningEffort).toBe('high');
    });

    it('maps unrecognized effort values to null', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-effort-unknown', cwd: '/Users/me/project' } },
        { type: 'turn_context', payload: { model: 'gpt-5.3-codex', effort: 'mystery' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'unknown effort' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'done' } },
      ]);

      expect(session.requests[0].reasoningEffort).toBeNull();
    });

    it('carries turn_context effort across later turns until changed', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-effort-persist', cwd: '/Users/me/project' } },
        { type: 'turn_context', payload: { model: 'gpt-5.3-codex', effort: 'medium' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'first' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'one' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:10Z', payload: { type: 'user_message', message: 'second' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:11Z', payload: { type: 'assistant_message', content: 'two' } },
      ]);

      expect(session.requests.map(request => request.reasoningEffort)).toEqual(['medium', 'medium']);
    });

    it('propagates turn_context model changes to later requests', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-model-switch', cwd: '/Users/me/project' } },
        { type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'first' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'one' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:10Z', payload: { type: 'user_message', message: 'second' } },
        { type: 'turn_context', payload: { model: 'gpt-5.4' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:11Z', payload: { type: 'assistant_message', content: 'two' } },
      ]);

      expect(session.requests.map(request => request.modelId)).toEqual(['gpt-5.3-codex', 'gpt-5.4']);
    });
  });

  describe('assistant reasoning and end reasons', () => {
    it('adds agent_reasoning text to the assistant response', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-agent-reasoning', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'explain' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'agent_reasoning', text: 'thinking' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:02Z', payload: { type: 'assistant_message', content: 'answer' } },
      ]);

      expect(session.requests[0].responseText).toBe('thinking\nanswer');
    });

    it('creates assistant-only responses from agent_reasoning events', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-agent-reasoning-only', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'explain' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'agent_reasoning', text: 'just reasoning' } },
      ]);

      expect(session.requests[0].responseText).toBe('just reasoning');
    });

    it('leaves endReason as unknown when any request has a response', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-end-reason-response', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'hello' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'hi' } },
      ]);

      expect(session.endReason).toBe('unknown');
    });

    it('leaves endReason as unknown when a request only used tools', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-end-reason-tool', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'edit' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'function_call', name: 'write_file', arguments: { file_path: 'src/file.ts' } } },
      ]);

      expect(session.endReason).toBe('unknown');
    });
  });

  describe('multiple session files and metadata', () => {
    it('parses multiple nested .jsonl files in one sessions directory', () => {
      withCodexFiles([
        {
          relativePath: '2025/06/15/rollout-2025-06-15-a.jsonl',
          content: [
            { type: 'session_meta', payload: { id: 'sess-a', cwd: '/Users/me/project-a' } },
            { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'a' } },
            { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'one' } },
          ],
        },
        {
          relativePath: '2025/06/16/rollout-2025-06-16-b.jsonl',
          content: [
            { type: 'session_meta', payload: { id: 'sess-b', cwd: '/Users/me/project-b' } },
            { type: 'event_msg', timestamp: '2025-06-16T10:00:00Z', payload: { type: 'user_message', message: 'b' } },
            { type: 'event_msg', timestamp: '2025-06-16T10:00:01Z', payload: { type: 'assistant_message', content: 'two' } },
          ],
        },
      ], (sessionsDir) => {
        const sessions = parseCodexSessions(sessionsDir);
        expect(sessions).toHaveLength(2);
        expect(sessions.map(session => session.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
      });
    });

    it('ignores non-jsonl files while scanning nested directories', () => {
      withCodexFiles([
        {
          relativePath: '2025/06/15/rollout-2025-06-15-a.jsonl',
          content: [
            { type: 'session_meta', payload: { id: 'sess-jsonl', cwd: '/Users/me/project' } },
            { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'keep me' } },
            { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'ok' } },
          ],
        },
        {
          relativePath: '2025/06/15/notes.txt',
          content: stringifyLines([
            { type: 'session_meta', payload: { id: 'sess-text', cwd: '/Users/me/project' } },
          ]),
        },
      ], (sessionsDir) => {
        const sessions = parseCodexSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].sessionId).toBe('sess-jsonl');
      });
    });

    it('derives workspaceName from cwd and marks the harness as Codex', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-meta', cwd: '/Users/me/projects/sample-app/', source: 'cli' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'hello' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'world' } },
      ]);

      expect(session.workspaceName).toBe('sample-app');
      expect(session.harness).toBe('Codex');
      expect(session.location).toBe('cli');
    });
  });

  describe('duplicate user messages', () => {
    it('does not create a duplicate request for repeated user messages without activity', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-duplicate-user', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'repeat me' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'user_message', message: 'repeat me' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:02Z', payload: { type: 'assistant_message', content: 'once' } },
      ]);

      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toBe('repeat me');
    });

    it('creates a new request for repeated user messages after activity occurs', () => {
      const session = parseSingleSession([
        { type: 'session_meta', payload: { id: 'sess-duplicate-after-activity', cwd: '/Users/me/project' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'repeat me' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:01Z', payload: { type: 'assistant_message', content: 'first reply' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:10Z', payload: { type: 'user_message', message: 'repeat me' } },
        { type: 'event_msg', timestamp: '2025-06-15T10:00:11Z', payload: { type: 'assistant_message', content: 'second reply' } },
      ]);

      expect(session.requests).toHaveLength(2);
      expect(session.requests.map(request => request.messageText)).toEqual(['repeat me', 'repeat me']);
    });
  });
});
