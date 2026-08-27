/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the GitHub Copilot Chat "transcripts" parser — the session storage format that
 * replaced `chatSessions/*.json` in newer VS Code / Copilot Chat builds. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { parseTranscriptFile } from './parser-vscode-transcripts';
import { getParseWarningCounts, resetParseWarnings } from './parser-shared';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-transcript-'));
  tempDirs.push(dir);
  return dir;
}

function writeTranscript(events: Array<Record<string, unknown>>): string {
  const dir = makeTempDir();
  const fp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(fp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return fp;
}

const REPO_FILE_A = '/home/user/go/src/example/iam/onboarding_service/organization.go';
const REPO_FILE_B = '/home/user/go/src/example/iam/tenant_management_service/client.go';

const SAMPLE_EVENTS: Array<Record<string, unknown>> = [
  { type: 'session.start', timestamp: '2026-06-10T11:02:38.261Z', data: { sessionId: 'sess-abc', version: 1, producer: 'copilot-agent', copilotVersion: '0.51.1', vscodeVersion: '1.123.1', startTime: '2026-06-10T11:02:38.261Z' } },
  { type: 'user.message', id: 'u1', timestamp: '2026-06-10T11:02:38.262Z', data: { content: 'fix the org lookup bug', attachments: [] } },
  { type: 'assistant.turn_start', timestamp: '2026-06-10T11:02:38.300Z', data: { turnId: '0' } },
  { type: 'tool.execution_start', timestamp: '2026-06-10T11:02:38.400Z', data: { toolCallId: 'call-1', toolName: 'read_file', arguments: { filePath: REPO_FILE_A, startLine: 1, endLine: 40 } } },
  { type: 'tool.execution_complete', timestamp: '2026-06-10T11:02:38.500Z', data: { toolCallId: 'call-1', success: true } },
  { type: 'tool.execution_start', timestamp: '2026-06-10T11:02:38.600Z', data: { toolCallId: 'call-2', toolName: 'replace_string_in_file', arguments: { filePath: REPO_FILE_A, oldString: 'old line', newString: 'new line\nsecond line' } } },
  { type: 'tool.execution_complete', timestamp: '2026-06-10T11:02:38.700Z', data: { toolCallId: 'call-2', success: true } },
  { type: 'assistant.message', id: 'a1', timestamp: '2026-06-10T11:02:51.307Z', data: { messageId: 'msg-1', content: 'Fixed the lookup bug.', toolRequests: [], reasoningText: '' } },
  { type: 'assistant.turn_end', timestamp: '2026-06-10T11:02:51.307Z', data: { turnId: '0' } },
];

beforeEach(() => resetParseWarnings());

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseTranscriptFile', () => {
  it('parses a well-formed transcript into a session', () => {
    const fp = writeTranscript(SAMPLE_EVENTS);
    const session = parseTranscriptFile(fp, 'ws-1', 'ws-1', 'Local Agent');

    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-abc');
    expect(session!.harness).toBe('Local Agent');
    expect(session!.workspaceId).toBe('ws-1');
    expect(session!.endReason).toBe('unknown');
    expect(session!.requests).toHaveLength(1);

    const req = session!.requests[0];
    expect(req.messageText).toBe('fix the org lookup bug');
    expect(req.responseText).toBe('Fixed the lookup bug.');
    expect(req.toolsUsed).toEqual(expect.arrayContaining(['read_file', 'replace_string_in_file']));
    expect(req.referencedFiles).toContain(REPO_FILE_A);
    expect(req.editedFiles).toContain(REPO_FILE_A);
    expect(req.endState).toBe('no-data');
    expect(req.completionTokens).toBeNull();
  });

  it('derives workspaceRootPath from the common directory of edited files', () => {
    const events: Array<Record<string, unknown>> = [
      ...SAMPLE_EVENTS,
      { type: 'user.message', timestamp: '2026-06-10T11:03:00.000Z', data: { content: 'also fix the client' } },
      { type: 'tool.execution_start', timestamp: '2026-06-10T11:03:00.100Z', data: { toolCallId: 'call-3', toolName: 'create_file', arguments: { filePath: REPO_FILE_B, content: 'package tenant\n' } } },
      { type: 'tool.execution_complete', timestamp: '2026-06-10T11:03:00.200Z', data: { toolCallId: 'call-3', success: true } },
      { type: 'assistant.message', id: 'a2', timestamp: '2026-06-10T11:03:01.000Z', data: { content: 'Created the client file.' } },
    ];
    const fp = writeTranscript(events);
    const session = parseTranscriptFile(fp, 'ws-1', 'ws-1', 'Local Agent');

    expect(session!.workspaceRootPath).toBe('/home/user/go/src/example/iam');
  });

  it('does not commit a tool edit when the tool call failed', () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'session.start', timestamp: '2026-01-01T00:00:00Z', data: { sessionId: 'sess-fail', startTime: '2026-01-01T00:00:00Z' } },
      { type: 'user.message', timestamp: '2026-01-01T00:00:01Z', data: { content: 'edit this file' } },
      { type: 'tool.execution_start', timestamp: '2026-01-01T00:00:02Z', data: { toolCallId: 'call-1', toolName: 'replace_string_in_file', arguments: { filePath: '/repo/a.ts', oldString: 'x', newString: 'y' } } },
      { type: 'tool.execution_complete', timestamp: '2026-01-01T00:00:03Z', data: { toolCallId: 'call-1', success: false } },
      { type: 'assistant.message', timestamp: '2026-01-01T00:00:04Z', data: { content: 'That failed.' } },
    ];
    const fp = writeTranscript(events);
    const session = parseTranscriptFile(fp, 'ws-1', 'ws-1', 'Local Agent');

    expect(session!.requests[0].editedFiles).toEqual([]);
  });

  it('handles multi_replace_string_in_file across several files', () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'session.start', timestamp: '2026-01-01T00:00:00Z', data: { sessionId: 'sess-multi', startTime: '2026-01-01T00:00:00Z' } },
      { type: 'user.message', timestamp: '2026-01-01T00:00:01Z', data: { content: 'refactor two files' } },
      {
        type: 'tool.execution_start',
        timestamp: '2026-01-01T00:00:02Z',
        data: {
          toolCallId: 'call-1',
          toolName: 'multi_replace_string_in_file',
          arguments: {
            replacements: [
              { filePath: REPO_FILE_A, oldString: 'a', newString: 'b' },
              { filePath: REPO_FILE_B, oldString: 'c', newString: 'd' },
            ],
          },
        },
      },
      { type: 'tool.execution_complete', timestamp: '2026-01-01T00:00:03Z', data: { toolCallId: 'call-1', success: true } },
      { type: 'assistant.message', timestamp: '2026-01-01T00:00:04Z', data: { content: 'Refactored.' } },
    ];
    const fp = writeTranscript(events);
    const session = parseTranscriptFile(fp, 'ws-1', 'ws-1', 'Local Agent');

    expect(session!.requests[0].editedFiles).toEqual(expect.arrayContaining([REPO_FILE_A, REPO_FILE_B]));
  });

  it('returns null and records a failed file when the path cannot be read', () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'does-not-exist.jsonl');

    const session = parseTranscriptFile(missing, 'ws-1', 'ws-1', 'Local Agent');

    expect(session).toBeNull();
    expect(getParseWarningCounts().skippedFiles).toBe(1);
  });

  it('returns null for a transcript with no user/assistant turns', () => {
    const fp = writeTranscript([{ type: 'some.unknown.event', data: {} }]);
    const session = parseTranscriptFile(fp, 'ws-1', 'ws-1', 'Local Agent');
    expect(session).toBeNull();
  });

  it('drops a trailing user message with no assistant response', () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'session.start', timestamp: '2026-01-01T00:00:00Z', data: { sessionId: 'sess-open', startTime: '2026-01-01T00:00:00Z' } },
      { type: 'user.message', timestamp: '2026-01-01T00:00:01Z', data: { content: 'still thinking...' } },
    ];
    const fp = writeTranscript(events);
    const session = parseTranscriptFile(fp, 'ws-1', 'ws-1', 'Local Agent');
    expect(session).toBeNull();
  });
});
