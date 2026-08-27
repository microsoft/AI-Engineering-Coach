/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { reconstructFromJsonl } from './parser-vscode-files';
import { parseCLIEventsFile } from './parser-vscode-cli';
import {
  parseSessionFile,
  harnessFromPath,
  findVsCodeDirs,
  scanVsCodeDirs,
  parseEditState,
  processWorkspaceEntry,
  processWorkspaceEntryAsync,
} from './parser-vscode';
import { getParseWarningCounts, type ParseContext, resetParseWarnings } from './parser-shared';

function withTempFile(name: string, content: string, run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-'));
  const filePath = path.join(dir, name);
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    run(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('reconstructFromJsonl', () => {
  it('rebuilds state from replace, set, and append records', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { messages: [], meta: { workspace: 'demo' } } }),
      JSON.stringify({ kind: 2, k: ['messages'], v: [{ role: 'user', content: 'hello' }] }),
      JSON.stringify({ kind: 1, k: ['meta', 'model'], v: 'gpt-4.1' }),
    ].join('\n');

    withTempFile('state.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath);
      expect(state).not.toBeNull();
      expect(state).toMatchObject({
        messages: [{ role: 'user', content: 'hello' }],
        meta: { workspace: 'demo', model: 'gpt-4.1' },
      });
    });
  });

  it('returns null for malformed jsonl input', () => {
    withTempFile('broken.jsonl', '{not valid json}\n', (filePath) => {
      expect(reconstructFromJsonl(filePath)).toBeNull();
    });
  });
});

describe('parseCLIEventsFile', () => {
  it('converts CLI events into a session with tool usage and timing', () => {
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2024-06-10T10:00:00.000Z',
        data: { sessionId: 'cli-session-1', startTime: '2024-06-10T10:00:00.000Z', selectedModel: 'gpt-4.1' },
      }),
      JSON.stringify({
        type: 'user.message',
        timestamp: '2024-06-10T10:00:01.000Z',
        data: { content: 'Write tests for parser.' },
      }),
      JSON.stringify({
        id: 'assistant-1',
        type: 'assistant.message',
        timestamp: '2024-06-10T10:00:04.000Z',
        data: {
          content: 'Added tests.',
          modelId: 'gpt-4.1',
          outputTokens: 321,
          toolRequests: [{ toolName: 'read_file' }, { toolName: 'apply_patch' }],
        },
      }),
    ].join('\n');

    withTempFile('events.jsonl', lines, (filePath) => {
      const session = parseCLIEventsFile(filePath, 'ws-1', 'demo-workspace');
      expect(session).not.toBeNull();
      expect(session).toMatchObject({
        sessionId: 'cli-session-1',
        workspaceId: 'ws-1',
        workspaceName: 'demo-workspace',
        harness: 'GitHub Copilot CLI',
        requestCount: 1,
      });
      expect(session?.requests[0]).toMatchObject({
        requestId: 'assistant-1',
        messageText: 'Write tests for parser.',
        responseText: 'Added tests.',
        modelId: 'gpt-4.1',
        completionTokens: 321,
        toolsUsed: ['read_file', 'apply_patch'],
      });
      expect(session?.requests[0].totalElapsed).toBe(3000);
    });
  });

  it('labels the harness as GitHub Copilot App when session.start carries remoteSteerable', () => {
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2024-06-10T10:00:00.000Z',
        data: { sessionId: 'app-session-1', startTime: '2024-06-10T10:00:00.000Z', selectedModel: 'gpt-4.1', remoteSteerable: false },
      }),
      JSON.stringify({
        type: 'user.message',
        timestamp: '2024-06-10T10:00:01.000Z',
        data: { content: 'Write tests for parser.' },
      }),
      JSON.stringify({
        id: 'assistant-1',
        type: 'assistant.message',
        timestamp: '2024-06-10T10:00:04.000Z',
        data: { content: 'Added tests.', modelId: 'gpt-4.1', outputTokens: 321, toolRequests: [{ toolName: 'read_file' }] },
      }),
    ].join('\n');

    withTempFile('events.jsonl', lines, (filePath) => {
      const session = parseCLIEventsFile(filePath, 'ws-app', 'demo-workspace');
      expect(session).toMatchObject({ sessionId: 'app-session-1', harness: 'GitHub Copilot App' });
      expect(session?.requests[0].agentName).toBe('GitHub Copilot App');
    });
  });

  it('returns null when no assistant responses are present', () => {
    const lines = [
      JSON.stringify({ type: 'session.start', timestamp: '2024-06-10T10:00:00.000Z', data: { sessionId: 'cli-session-2' } }),
      JSON.stringify({ type: 'user.message', timestamp: '2024-06-10T10:00:01.000Z', data: { content: 'Hello' } }),
    ].join('\n');

    withTempFile('events-empty.jsonl', lines, (filePath) => {
      expect(parseCLIEventsFile(filePath, 'ws-2', 'demo-workspace')).toBeNull();
    });
  });

  it('captures session.shutdown modelMetrics into Session.modelUsage', () => {
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2024-06-10T10:00:00.000Z',
        data: { sessionId: 'cli-shutdown-1', startTime: '2024-06-10T10:00:00.000Z', selectedModel: 'gpt-5.5' },
      }),
      JSON.stringify({ type: 'user.message', timestamp: '2024-06-10T10:00:01.000Z', data: { content: 'hi' } }),
      JSON.stringify({
        id: 'assistant-1',
        type: 'assistant.message',
        timestamp: '2024-06-10T10:00:02.000Z',
        data: { content: 'reply', modelId: 'gpt-5.5', outputTokens: 50 },
      }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: '2024-06-10T10:05:00.000Z',
        data: {
          modelMetrics: {
            'gpt-5.5': {
              usage: {
                inputTokens: 1234,
                outputTokens: 567,
                cacheReadTokens: 800,
                cacheWriteTokens: 100,
                reasoningTokens: 0,
              },
            },
          },
        },
      }),
    ].join('\n');

    withTempFile('events-shutdown.jsonl', lines, (filePath) => {
      const session = parseCLIEventsFile(filePath, 'ws-3', 'demo-workspace');
      expect(session).not.toBeNull();
      expect(session?.modelUsage).toBeDefined();
      expect(session?.modelUsage?.['gpt-5.5']).toMatchObject({
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
      });
    });
  });

  it('does not set modelUsage when no session.shutdown event is present', () => {
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2024-06-10T10:00:00.000Z',
        data: { sessionId: 'cli-no-shutdown', startTime: '2024-06-10T10:00:00.000Z', selectedModel: 'gpt-5.5' },
      }),
      JSON.stringify({ type: 'user.message', timestamp: '2024-06-10T10:00:01.000Z', data: { content: 'hi' } }),
      JSON.stringify({
        id: 'a1', type: 'assistant.message', timestamp: '2024-06-10T10:00:02.000Z',
        data: { content: 'reply', modelId: 'gpt-5.5', outputTokens: 50 },
      }),
    ].join('\n');

    withTempFile('events-no-shutdown.jsonl', lines, (filePath) => {
      const session = parseCLIEventsFile(filePath, 'ws-4', 'demo-workspace');
      expect(session?.modelUsage).toBeUndefined();
    });
  });

  it('marks user-aborted turns (no assistant.message ever fired) as endState=errored', () => {
    // Real-world pattern from `local-cli` workspace: user typed "hi", model
    // turn started, user aborted (Ctrl+C) before any response chunk, then
    // session shut down with totalPremiumRequests=0. There is no token data
    // to capture for this turn — mark it `errored` so the analyzer excludes
    // it from the missing-token denominator.
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2024-06-10T10:00:00.000Z',
        data: { sessionId: 'cli-aborted', startTime: '2024-06-10T10:00:00.000Z', selectedModel: 'gpt-4.1' },
      }),
      JSON.stringify({ type: 'user.message', timestamp: '2024-06-10T10:00:01.000Z', data: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant.turn_start', timestamp: '2024-06-10T10:00:02.000Z', data: { modelId: 'gpt-4.1' } }),
      JSON.stringify({ type: 'abort', timestamp: '2024-06-10T10:00:03.000Z', data: {} }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: '2024-06-10T10:00:04.000Z',
        data: { totalPremiumRequests: 0, modelMetrics: {} },
      }),
    ].join('\n');

    withTempFile('events-aborted.jsonl', lines, (filePath) => {
      const session = parseCLIEventsFile(filePath, 'ws-5', 'local-cli');
      expect(session?.requests).toHaveLength(1);
      expect(session?.requests[0].isCanceled).toBe(true);
      expect(session?.requests[0].endState).toBe('errored');
    });
  });

  it('does NOT mark canceled turns as errored when assistant produced output (partial response)', () => {
    // If the user aborts mid-stream after the model produced output tokens
    // or tool calls, we want the request to surface as partial/missing — not
    // silently excluded from the coverage denominator.
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2024-06-10T10:00:00.000Z',
        data: { sessionId: 'cli-partial', startTime: '2024-06-10T10:00:00.000Z', selectedModel: 'gpt-4.1' },
      }),
      JSON.stringify({ type: 'user.message', timestamp: '2024-06-10T10:00:01.000Z', data: { content: 'long task' } }),
      JSON.stringify({
        id: 'a1', type: 'assistant.message', timestamp: '2024-06-10T10:00:02.000Z',
        data: { content: 'partial response', modelId: 'gpt-4.1', outputTokens: 20 },
      }),
      JSON.stringify({ type: 'abort', timestamp: '2024-06-10T10:00:03.000Z', data: {} }),
    ].join('\n');

    withTempFile('events-partial-abort.jsonl', lines, (filePath) => {
      const session = parseCLIEventsFile(filePath, 'ws-6', 'demo');
      expect(session?.requests).toHaveLength(1);
      expect(session?.requests[0].isCanceled).toBe(true);
      expect(session?.requests[0].endState).toBeUndefined();
    });
  });
});

describe('parseSessionFile (VS Code chat) — endState', () => {
  function withChatSession(requests: unknown[], run: (filePath: string) => void): void {
    const data = { sessionId: 'sess-test', requesterUsername: 'u', responderUsername: 'b', requests };
    withTempFile('chat.json', JSON.stringify(data), run);
  }

  it('marks requests with empty result as endState=pending (in-flight/abandoned)', () => {
    const reqs = [
      { requestId: 'r1', timestamp: 1000, message: { text: 'hi' }, response: [], result: {} },
    ];
    withChatSession(reqs, (filePath) => {
      const sess = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(sess?.requests[0].endState).toBe('pending');
    });
  });

  it('marks requests with errorDetails as endState=errored', () => {
    const reqs = [
      {
        requestId: 'r1', timestamp: 1000, message: { text: 'hi' }, response: [],
        result: { errorDetails: { message: 'Canceled' }, metadata: {} },
      },
    ];
    withChatSession(reqs, (filePath) => {
      const sess = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(sess?.requests[0].endState).toBe('errored');
    });
  });

  it('leaves endState undefined for completed requests with token data', () => {
    const reqs = [
      {
        requestId: 'r1', timestamp: 1000, message: { text: 'hi' }, response: [{ kind: 'markdownContent', content: { value: 'hello' } }],
        result: { metadata: { promptTokens: 100, outputTokens: 20 } },
        completionTokens: 20,
      },
    ];
    withChatSession(reqs, (filePath) => {
      const sess = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(sess?.requests[0].endState).toBeUndefined();
    });
  });

  it('marks endState=no-data for finalized requests with substantive metadata but no tokens', () => {
    // Real-world pattern: VS Code chat extension recorded full agentic
    // metadata (toolCallRounds, modelMessageId, responseId) but did not
    // capture promptTokens/outputTokens. Common for some 2026-04 requests
    // against `copilot/auto` and `copilot/gpt-5.4`. Not recoverable.
    const reqs = [
      {
        requestId: 'r1', timestamp: 1000, message: { text: 'hi' }, response: [],
        result: { metadata: { toolCallRounds: [{ id: 'x' }], modelMessageId: 'm1', responseId: 'rsp1' } },
      },
    ];
    withChatSession(reqs, (filePath) => {
      const sess = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(sess?.requests[0].endState).toBe('no-data');
    });
  });

  it('leaves endState undefined when metadata has tokens but no agentic keys (older shape)', () => {
    // A finalized request with promptTokens/outputTokens but no toolCallRounds —
    // this is `complete`, not `no-data`.
    const reqs = [
      {
        requestId: 'r1', timestamp: 1000, message: { text: 'hi' }, response: [{ kind: 'markdownContent', content: { value: 'ok' } }],
        result: { metadata: { promptTokens: 50, outputTokens: 5 } },
        completionTokens: 5,
      },
    ];
    withChatSession(reqs, (filePath) => {
      const sess = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(sess?.requests[0].endState).toBeUndefined();
    });
  });
});

describe('parseSessionFile token extraction', () => {
  it('prefers request-level completionTokens over metadata.outputTokens', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {
        creationDate: 1700000000000,
        lastMessageDate: 1700000001000,
        sessionId: 'token-test-1',
        requests: [{
          requestId: 'req-1',
          timestamp: 1700000001000,
          message: { text: 'hello' },
          response: [{ value: 'world' }],
          modelId: 'claude-opus-4-6',
          result: { timings: { totalElapsed: 5000 }, metadata: { promptTokens: 1000, outputTokens: 50 } },
        }],
      }}),
      // Streaming counter patches — final value should win
      JSON.stringify({ kind: 1, k: ['requests', 0, 'completionTokens'], v: 200 }),
      JSON.stringify({ kind: 1, k: ['requests', 0, 'completionTokens'], v: 450 }),
    ].join('\n');

    withTempFile('session-tokens.jsonl', lines, (filePath) => {
      const session = parseSessionFile(filePath, 'ws-1', 'test-ws', 'VS Code');
      expect(session).not.toBeNull();
      expect(session!.requests[0].promptTokens).toBe(1000);
      // Should use request-level completionTokens (450) not metadata.outputTokens (50)
      expect(session!.requests[0].completionTokens).toBe(450);
    });
  });

  it('falls back to metadata.outputTokens when request-level completionTokens is absent', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {
        creationDate: 1700000000000,
        sessionId: 'token-test-2',
        requests: [{
          requestId: 'req-1',
          timestamp: 1700000001000,
          message: { text: 'hello' },
          response: [{ value: 'world' }],
          modelId: 'gpt-4.1',
          result: { timings: { totalElapsed: 3000 }, metadata: { promptTokens: 2000, outputTokens: 300 } },
        }],
      }}),
    ].join('\n');

    withTempFile('session-meta-only.jsonl', lines, (filePath) => {
      const session = parseSessionFile(filePath, 'ws-2', 'test-ws', 'VS Code');
      expect(session).not.toBeNull();
      expect(session!.requests[0].promptTokens).toBe(2000);
      // Falls back to metadata.outputTokens since no request-level completionTokens
      expect(session!.requests[0].completionTokens).toBe(300);
    });
  });
});

describe('harnessFromPath', () => {
  it('returns Insiders for Insiders paths', () => {
    expect(harnessFromPath('/home/user/Library/Application Support/Code - Insiders/User/workspaceStorage')).toBe('Local Agent (Insiders)');
  });

  it('returns CLI for .copilot paths', () => {
    expect(harnessFromPath('/home/user/.copilot/session-state')).toBe('GitHub Copilot CLI');
  });

  it('returns Local Agent for standard VS Code paths', () => {
    expect(harnessFromPath('/home/user/Library/Application Support/Code/User/workspaceStorage')).toBe('Local Agent');
  });
});

describe('parseSessionFile — basic VS Code session', () => {
  it('parses a minimal JSON session file with a single request', () => {
    const data = {
      sessionId: 'test-session',
      creationDate: 1700000000000,
      lastMessageDate: 1700000001000,
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'How do I write tests?' },
        response: [{ value: 'Use vitest.' }],
        result: { timings: { firstProgress: 200, totalElapsed: 1000 }, metadata: {} },
        modelId: 'gpt-4.1',
      }],
    };
    withTempFile('basic-session.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'my-project', 'Local Agent');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('test-session');
      expect(session!.workspaceName).toBe('my-project');
      expect(session!.requests).toHaveLength(1);
      expect(session!.requests[0].messageText).toBe('How do I write tests?');
      expect(session!.requests[0].modelId).toBe('gpt-4.1');
    });
  });

  it('returns null for invalid JSON', () => {
    withTempFile('bad.json', '{not valid json', (filePath) => {
      expect(parseSessionFile(filePath, 'ws', 'wp', 'Local Agent')).toBeNull();
    });
  });

  it('extracts agent info from requests', () => {
    const data = {
      sessionId: 'agent-test',
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'help' },
        response: [{ value: 'ok' }],
        agent: { extensionDisplayName: 'GitHub Copilot', id: 'copilot' },
        result: { metadata: {} },
      }],
    };
    withTempFile('agent-session.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session).not.toBeNull();
      expect(session!.requests[0].agentName).toBe('GitHub Copilot');
      // Without inputState.mode.id, agentMode is cleared to '' so the
      // participant id ("copilot") doesn't pollute mode analytics.
      expect(session!.requests[0].agentMode).toBe('');
    });
  });

  it('uses inputState.mode.id as agentMode when present', () => {
    const data = {
      sessionId: 'mode-test',
      inputState: { mode: { id: 'agent', kind: 'agent' } },
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'help' },
        response: [{ value: 'ok' }],
        agent: { extensionDisplayName: 'GitHub Copilot Chat', id: 'github.copilot.editsAgent' },
        result: { metadata: {} },
      }],
    };
    withTempFile('mode-agent.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session!.requests[0].agentMode).toBe('agent');
    });
  });

  it('normalizes plan mode URI to "plan"', () => {
    const data = {
      sessionId: 'plan-test',
      inputState: { mode: { id: 'vscode-userdata:/c%3A/Users/test/plan-agent/Plan.agent.md', kind: 'agent' } },
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'plan the architecture' },
        response: [{ value: 'ok' }],
        agent: { extensionDisplayName: 'GitHub Copilot Chat', id: 'github.copilot.editsAgent' },
        result: { metadata: {} },
      }],
    };
    withTempFile('mode-plan.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session!.requests[0].agentMode).toBe('plan');
    });
  });

  it('normalizes ask mode', () => {
    const data = {
      sessionId: 'ask-test',
      inputState: { mode: { id: 'ask', kind: 'default' } },
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'what is this?' },
        response: [{ value: 'explanation' }],
        agent: { extensionDisplayName: 'GitHub Copilot', id: 'github.copilot.default' },
        result: { metadata: {} },
      }],
    };
    withTempFile('mode-ask.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session!.requests[0].agentMode).toBe('ask');
    });
  });

  it('normalizes custom chatmode URI to stem name', () => {
    const data = {
      sessionId: 'custom-test',
      inputState: { mode: { id: 'file:///c%3A/Users/test/MERs%20Agent.chatmode.md', kind: 'agent' } },
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'run audit' },
        response: [{ value: 'done' }],
        result: { metadata: {} },
      }],
    };
    withTempFile('mode-custom.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session!.requests[0].agentMode).toBe('MERs Agent');
    });
  });

  it('extracts slash commands', () => {
    const data = {
      sessionId: 'slash-test',
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'explain this' },
        response: [{ value: 'explained' }],
        slashCommand: { name: 'explain' },
        result: { metadata: {} },
      }],
    };
    withTempFile('slash.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session!.requests[0].slashCommand).toBe('explain');
    });
  });

  it('extracts edited files', () => {
    const data = {
      sessionId: 'edit-test',
      requests: [{
        requestId: 'r1',
        timestamp: 1000,
        message: { text: 'fix bug' },
        response: [{ value: 'done' }],
        editedFileEvents: [{ uri: { path: '/src/main.ts' } }],
        result: { metadata: {} },
      }],
    };
    withTempFile('edit.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session!.requests[0].editedFiles).toContain('/src/main.ts');
    });
  });

  it('parses JSONL session files', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {
        sessionId: 'jsonl-test',
        creationDate: 1700000000000,
        requests: [{
          requestId: 'r1',
          timestamp: 1700000001000,
          message: { text: 'hi' },
          response: [{ value: 'hello' }],
          result: { metadata: {} },
        }],
      }}),
    ].join('\n');
    withTempFile('test.jsonl', lines, (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('jsonl-test');
    });
  });
});

describe('scanVsCodeDirs', () => {
  it('scans directories and returns entries', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-vscode-'));
    try {
      fs.mkdirSync(path.join(logsDir, 'workspace1'));
      fs.mkdirSync(path.join(logsDir, 'workspace2'));
      fs.writeFileSync(path.join(logsDir, 'file.txt'), 'ignore');

      const { entries, totalDirs } = scanVsCodeDirs([logsDir]);
      expect(totalDirs).toBe(2);
      expect(entries).toHaveLength(1);
      expect(entries[0].dirEntries).toHaveLength(2);
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('handles non-existent dirs gracefully', () => {
    const { entries, totalDirs } = scanVsCodeDirs(['/nonexistent/path']);
    expect(totalDirs).toBe(0);
    expect(entries).toHaveLength(0);
  });
});

describe('scanVsCodeDirs — Copilot session state', () => {
  it('only includes Copilot session-state directories that contain events', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-cli-scan-'));
    const logsDir = path.join(root, '.copilot', 'session-state');
    try {
      fs.mkdirSync(path.join(logsDir, 'with-events'), { recursive: true });
      fs.mkdirSync(path.join(logsDir, 'without-events'));
      fs.writeFileSync(path.join(logsDir, 'with-events', 'events.jsonl'), '');

      const { entries, totalDirs } = scanVsCodeDirs([logsDir]);

      expect(totalDirs).toBe(1);
      expect(entries[0].dirEntries.map(entry => entry.name)).toEqual(['with-events']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count a missing optional VS Code events file as skipped', async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-vscode-scan-'));
    const makeContext = (): ParseContext => ({
      workspaces: new Map(),
      sessions: [],
      editLocIndex: new Map(),
      sessionSourceIndex: new Map(),
      aiLoc: 0,
    });
    try {
      fs.mkdirSync(path.join(logsDir, 'workspace'));
      resetParseWarnings();

      processWorkspaceEntry(logsDir, 'workspace', 'Local Agent', makeContext());
      await processWorkspaceEntryAsync(logsDir, 'workspace', 'Local Agent', makeContext());

      expect(getParseWarningCounts().skippedFiles).toBe(0);
    } finally {
      resetParseWarnings();
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('processWorkspaceEntry — GitHub.copilot-chat/transcripts', () => {
  const makeContext = (): ParseContext => ({
    workspaces: new Map(),
    sessions: [],
    editLocIndex: new Map(),
    sessionSourceIndex: new Map(),
    aiLoc: 0,
  });

  function writeTranscriptWorkspace(logsDir: string, wsId: string): void {
    const dir = path.join(logsDir, wsId, 'GitHub.copilot-chat', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const events = [
      { type: 'session.start', timestamp: '2026-01-01T00:00:00Z', data: { sessionId: 'sess-t1', startTime: '2026-01-01T00:00:00Z' } },
      { type: 'user.message', timestamp: '2026-01-01T00:00:01Z', data: { content: 'hello' } },
      { type: 'tool.execution_start', timestamp: '2026-01-01T00:00:02Z', data: { toolCallId: 'c1', toolName: 'create_file', arguments: { filePath: '/home/user/proj/myrepo/src/index.ts', content: 'x' } } },
      { type: 'tool.execution_complete', timestamp: '2026-01-01T00:00:03Z', data: { toolCallId: 'c1', success: true } },
      { type: 'tool.execution_start', timestamp: '2026-01-01T00:00:04Z', data: { toolCallId: 'c2', toolName: 'create_file', arguments: { filePath: '/home/user/proj/myrepo/test/index.test.ts', content: 'y' } } },
      { type: 'tool.execution_complete', timestamp: '2026-01-01T00:00:05Z', data: { toolCallId: 'c2', success: true } },
      { type: 'assistant.message', id: 'a1', timestamp: '2026-01-01T00:00:06Z', data: { content: 'done' } },
    ];
    fs.writeFileSync(path.join(dir, 'sess-t1.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  }

  it('parses transcripts when there is no chatSessions dir or workspace.json (sync)', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-transcripts-'));
    try {
      writeTranscriptWorkspace(logsDir, 'ws-hash-1');
      const ctx = makeContext();

      const wsName = processWorkspaceEntry(logsDir, 'ws-hash-1', 'Local Agent', ctx);

      expect(wsName).toBe('ws-hash-1');
      expect(ctx.sessions).toHaveLength(1);
      expect(ctx.sessions[0].sessionId).toBe('sess-t1');
      expect(ctx.sessionSourceIndex.get('sess-t1')?.kind).toBe('vscode-transcript');
      // The derived workspace root upgrades the placeholder hash-based name/path.
      expect(ctx.workspaces.get('ws-hash-1')).toEqual({ id: 'ws-hash-1', name: 'myrepo', path: '/home/user/proj/myrepo' });
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('parses transcripts when there is no chatSessions dir or workspace.json (async)', async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-transcripts-async-'));
    try {
      writeTranscriptWorkspace(logsDir, 'ws-hash-2');
      const ctx = makeContext();

      const wsName = await processWorkspaceEntryAsync(logsDir, 'ws-hash-2', 'Local Agent', ctx);

      expect(wsName).toBe('ws-hash-2');
      expect(ctx.sessions).toHaveLength(1);
      expect(ctx.sessionSourceIndex.get('sess-t1')?.kind).toBe('vscode-transcript');
      expect(ctx.workspaces.get('ws-hash-2')).toEqual({ id: 'ws-hash-2', name: 'myrepo', path: '/home/user/proj/myrepo' });
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('keeps the workspace.json-derived name when one is present', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-transcripts-wsjson-'));
    try {
      writeTranscriptWorkspace(logsDir, 'ws-hash-3');
      fs.writeFileSync(
        path.join(logsDir, 'ws-hash-3', 'workspace.json'),
        JSON.stringify({ folder: 'file:///home/user/proj/named-workspace' }),
      );
      const ctx = makeContext();

      const wsName = processWorkspaceEntry(logsDir, 'ws-hash-3', 'Local Agent', ctx);

      expect(wsName).toBe('named-workspace');
      expect(ctx.workspaces.get('ws-hash-3')?.name).toBe('named-workspace');
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('parseSessionFile — skill detection', () => {
  it('detects skills from promptFile variables pointing to SKILL.md', () => {
    const data = {
      sessionId: 'skill-promptfile',
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'help me' },
        response: [{ value: 'ok' }],
        variableData: {
          variables: [
            {
              kind: 'promptFile',
              value: { path: '/c:/Users/me/.agents/skills/azure-cosmos-py/SKILL.md', external: 'file:///c%3A/Users/me/.agents/skills/azure-cosmos-py/SKILL.md', scheme: 'file' },
            },
            {
              kind: 'promptFile',
              value: { path: '/c:/Users/me/.claude/skills/browse/SKILL.md', scheme: 'file' },
            },
            {
              kind: 'promptFile',
              value: { path: '/c:/Users/me/.claude/CLAUDE.md', scheme: 'file' },
            },
          ],
        },
        result: { metadata: {} },
      }],
    };
    withTempFile('skill-promptfile.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent (Insiders)');
      expect(session).not.toBeNull();
      const skills = session!.requests[0].skillsUsed;
      expect(skills).toContain('azure-cosmos-py');
      expect(skills).toContain('browse');
      expect(skills).not.toContain('CLAUDE.md');
      expect(skills).toHaveLength(2);
    });
  });

  it('detects skills from read_file tool calls targeting SKILL.md', () => {
    const data = {
      sessionId: 'skill-toolcall',
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'use the skill' },
        response: [{ value: 'done' }],
        result: {
          metadata: {
            toolCallRounds: [{
              toolCalls: [
                { name: 'read_file', arguments: JSON.stringify({ filePath: 'c:\\Users\\me\\.agents\\skills\\fastapi-router-py\\SKILL.md', startLine: 1, endLine: 50 }) },
                { name: 'read_file', arguments: JSON.stringify({ filePath: '/src/main.ts', startLine: 1, endLine: 10 }) },
              ],
            }],
          },
        },
      }],
    };
    withTempFile('skill-toolcall.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent (Insiders)');
      expect(session).not.toBeNull();
      const skills = session!.requests[0].skillsUsed;
      expect(skills).toContain('fastapi-router-py');
      expect(skills).toHaveLength(1);
    });
  });

  it('deduplicates skills found via both promptFile and tool call', () => {
    const data = {
      sessionId: 'skill-dedup',
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'use skill' },
        response: [{ value: 'done' }],
        variableData: {
          variables: [{
            kind: 'promptFile',
            value: { path: '/c:/Users/me/.agents/skills/copilot-sdk/SKILL.md', scheme: 'file' },
          }],
        },
        result: {
          metadata: {
            toolCallRounds: [{
              toolCalls: [
                { name: 'read_file', arguments: JSON.stringify({ filePath: '/c:/Users/me/.agents/skills/copilot-sdk/SKILL.md', startLine: 1, endLine: 100 }) },
              ],
            }],
          },
        },
      }],
    };
    withTempFile('skill-dedup.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent (Insiders)');
      expect(session).not.toBeNull();
      const skills = session!.requests[0].skillsUsed;
      expect(skills).toContain('copilot-sdk');
      expect(skills).toHaveLength(1);
    });
  });

  it('still detects skills from legacy inline XML', () => {
    const skillXml = '<skills>\n<skill>\n<name>azure-cosmos-py</name>\n<description>Test</description>\n</skill>\n<skill>\n<name>find-skills</name>\n<description>Find</description>\n</skill>\n</skills>';
    const data = {
      sessionId: 'skill-xml',
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'help' },
        response: [{ value: 'ok' }],
        variableData: {
          variables: [{
            kind: 'promptText',
            value: skillXml,
          }],
        },
        result: { metadata: {} },
      }],
    };
    withTempFile('skill-xml.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session).not.toBeNull();
      const skills = session!.requests[0].skillsUsed;
      expect(skills).toContain('azure-cosmos-py');
      expect(skills).toContain('find-skills');
      expect(skills).toHaveLength(2);
    });
  });

  it('handles tool call arguments as object (not JSON string)', () => {
    const data = {
      sessionId: 'skill-args-obj',
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'read' },
        response: [{ value: 'ok' }],
        result: {
          metadata: {
            toolCallRounds: [{
              toolCalls: [
                { name: 'read_file', arguments: { filePath: '/home/user/.agents/skills/playwright-cli/SKILL.md', startLine: 1, endLine: 50 } },
              ],
            }],
          },
        },
      }],
    };
    withTempFile('skill-args-obj.json', JSON.stringify(data), (filePath) => {
      const session = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
      expect(session).not.toBeNull();
      expect(session!.requests[0].skillsUsed).toContain('playwright-cli');
    });
  });
});
describe('tool-call metadata extraction (characterization)', () => {
  function parseRequest(metadata: Record<string, unknown>): ReturnType<typeof parseSessionFile> {
    const data = {
      sessionId: 'tc',
      requests: [{
        requestId: 'r1',
        timestamp: 1700000001000,
        message: { text: 'go' },
        response: [{ value: 'done' }],
        result: { metadata },
      }],
    };
    let out: ReturnType<typeof parseSessionFile> = null;
    withTempFile('tc.json', JSON.stringify(data), (filePath) => {
      out = parseSessionFile(filePath, 'ws', 'wp', 'Local Agent');
    });
    return out;
  }

  it('collects toolsUsed from toolCallRounds', () => {
    const session = parseRequest({
      toolCallRounds: [{ toolCalls: [{ name: 'read_file' }, { name: 'apply_patch' }] }],
    });
    expect(session!.requests[0].toolsUsed).toEqual(['read_file', 'apply_patch']);
  });

  it('collects toolsUsed from the toolCallResults branch too', () => {
    const session = parseRequest({
      toolCallResults: [{ toolCalls: [{ name: 'run_in_terminal' }] }],
    });
    expect(session!.requests[0].toolsUsed).toEqual(['run_in_terminal']);
  });

  it('parses toolCalls supplied as a JSON string', () => {
    const session = parseRequest({
      toolCallRounds: [{ toolCalls: JSON.stringify([{ name: 'edit_file' }]) }],
    });
    expect(session!.requests[0].toolsUsed).toEqual(['edit_file']);
  });

  it('skips malformed toolCalls JSON without throwing', () => {
    const session = parseRequest({
      toolCallRounds: [{ toolCalls: '{not valid json' }],
    });
    expect(session).not.toBeNull();
    expect(session!.requests[0].toolsUsed).toEqual([]);
  });

  it('captures the last manage_todo_list snapshot', () => {
    const session = parseRequest({
      toolCallRounds: [
        { toolCalls: [{ name: 'manage_todo_list', arguments: JSON.stringify({ todoList: [{ id: 1, title: 'first', status: 'completed' }] }) }] },
        { toolCalls: [{ name: 'manage_todo_list', arguments: JSON.stringify({ todoList: [{ id: 2, title: 'second', status: 'in-progress' }] }) }] },
      ],
    });
    expect(session!.requests[0].todoSnapshot).toEqual([
      { id: 2, title: 'second', status: 'in-progress' },
    ]);
  });

  it('returns null todoSnapshot when no manage_todo_list call is present', () => {
    const session = parseRequest({ toolCallRounds: [{ toolCalls: [{ name: 'read_file' }] }] });
    expect(session!.requests[0].todoSnapshot).toBeNull();
  });
});
describe('harnessFromPath — VS Code Server', () => {
  it('returns "Local Agent (Server)" for .vscode-server paths', () => {
    expect(harnessFromPath('/home/alice/.vscode-server/data/User/workspaceStorage')).toBe('Local Agent (Server)');
  });

  it('returns "Local Agent (Server Insiders)" for .vscode-server-insiders paths', () => {
    expect(harnessFromPath('/home/alice/.vscode-server-insiders/data/User/workspaceStorage')).toBe('Local Agent (Server Insiders)');
  });

  it('does not match .vscode-server-insiders as plain .vscode-server', () => {
    // .vscode-server-insiders contains the string ".vscode-server" — ensure
    // the more-specific check fires first.
    const result = harnessFromPath('/home/alice/.vscode-server-insiders/data/User/workspaceStorage');
    expect(result).toBe('Local Agent (Server Insiders)');
    expect(result).not.toBe('Local Agent (Server)');
  });
});

describe('findVsCodeDirs — VS Code Server', () => {
  it('includes server workspaceStorage paths on non-Windows hosts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-vscode-'));
    const home = process.env.HOME;
    const userProfile = process.env.USERPROFILE;
    // findVsCodeDirs() branches on process.platform: on win32 it reads editions from
    // %APPDATA% and skips the .vscode-server block entirely. This test exercises the
    // non-Windows layout (~/.config + ~/.vscode-server), so pin the platform rather than
    // relying on the host OS — otherwise it (correctly) returns [] when run on Windows.
    const realPlatform = process.platform;
    const expected = [
      path.join(root, '.config', 'Code', 'User', 'workspaceStorage'),
      path.join(root, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
      path.join(root, '.vscode-server', 'data', 'User', 'workspaceStorage'),
      path.join(root, '.vscode-server-insiders', 'data', 'User', 'workspaceStorage'),
    ];

    for (const dir of expected) fs.mkdirSync(dir, { recursive: true });

    process.env.HOME = root;
    process.env.USERPROFILE = '';
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      expect(findVsCodeDirs()).toEqual(expected);
    } finally {
      process.env.HOME = home;
      process.env.USERPROFILE = userProfile;
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseEditState (AI-generated LoC)', () => {
  const URI = 'file:///project/src/app.ts';

  function wholeFileEdit(text: string): unknown {
    return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1_000_000, endColumn: 1 }, text };
  }

  function textEditOp(reqId: string, epoch: number, text: string): unknown {
    return { type: 'textEdit', requestId: reqId, uri: { external: URI }, epoch, edits: [wholeFileEdit(text)] };
  }

  function totalFor(index: Map<string, Map<string, { added: number; removed: number }>>, uri: string): number {
    let sum = 0;
    for (const fileMap of index.values()) sum += fileMap.get(uri)?.added ?? 0;
    return sum;
  }

  it('counts repeated whole-file snapshots incrementally, not by summing payloads', () => {
    const v1 = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const v2 = v1 + '\nline10';
    const v3 = v2 + '\nline11';
    const raw = JSON.stringify({
      timeline: {
        fileBaselines: [[`${URI}::r1`, { uri: { external: URI }, requestId: 'r1', content: v1 }]],
        operations: [textEditOp('r1', 1, v1), textEditOp('r1', 2, v2), textEditOp('r1', 3, v3)],
      },
    });
    const index = new Map<string, Map<string, { added: number; removed: number }>>();
    parseEditState(raw, index, os.tmpdir());
    expect(totalFor(index, URI)).toBe(2);
  });

  it('counts create-only payloads', () => {
    const raw = JSON.stringify({
      timeline: {
        operations: [{
          type: 'create',
          requestId: 'r1',
          uri: { external: URI },
          epoch: 1,
          initialContent: 'a\nb\nc',
        }],
      },
    });
    const index = new Map<string, Map<string, { added: number; removed: number }>>();
    parseEditState(raw, index, os.tmpdir());
    expect(totalFor(index, URI)).toBe(3);
  });

  it('counts inserted notebook cell sources through the serialized state parser', () => {
    const notebookUri = 'file:///project/notebook.ipynb';
    const raw = JSON.stringify({
      timeline: {
        operations: [{
          type: 'notebookEdit',
          requestId: 'r1',
          uri: { external: notebookUri },
          epoch: 1,
          cellEdits: [{
            editType: 1,
            count: 0,
            cells: [{ source: 'const one = 1;\nconst two = 2;' }],
          }],
        }],
      },
    });
    const index = new Map<string, Map<string, { added: number; removed: number }>>();

    parseEditState(raw, index, os.tmpdir());

    expect(index.get('r1')?.get(notebookUri)).toEqual({ added: 2, removed: 0 });
  });

  it('does not throw on corrupt JSON that contains the textEdit guard token', () => {
    const index = new Map<string, Map<string, { added: number; removed: number }>>();
    expect(() => parseEditState('{"textEdit": not-valid-json', index, os.tmpdir())).not.toThrow();
    expect(index.size).toBe(0);
  });

  it('seeds the diff from contents/<hash> when the per-request baseline is missing', () => {
    const existing = 'a\nb\nc\nd\ne';
    const edited = 'a\nb\nCHANGED\nd\ne';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-edits-'));
    try {
      const hash = 'deadbeef';
      fs.mkdirSync(path.join(dir, 'contents'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'contents', hash), existing, 'utf-8');
      const raw = JSON.stringify({
        initialFileContents: [[URI, hash]],
        timeline: { operations: [textEditOp('r1', 1, edited)] },
      });
      const index = new Map<string, Map<string, { added: number; removed: number }>>();
      parseEditState(raw, index, dir);
      // Only the one changed line is counted — the pre-existing body is not re-counted.
      expect(totalFor(index, URI)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
