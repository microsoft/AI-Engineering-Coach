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
import { parseSessionFile, harnessFromPath, findVsCodeDirs, scanVsCodeDirs } from './parser-vscode';

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
