/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* VS Code context limits: the selected model's configured context size, else that setting's default, else the
 * model's maximum input tokens. Each request takes the limit selected when it was added to the session.
 * Fixtures mirror real `inputState.selectedModel` shapes (VS Code 1.120) with content redacted. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSessionFile } from './parser-vscode';
import { SelectedModelLimits, selectedModelLimit } from './vscode-model-limits';
import { Analyzer } from './analyzer';
import { requestContextLimit, sessionContextWindow } from './context-window';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTemp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-model-limits-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function model(identifier: string, o: { maxInput?: number; options?: number[]; fallback?: number; configured?: number }): Record<string, unknown> {
  return {
    identifier,
    metadata: {
      id: identifier.split('/').pop(), vendor: 'copilot', family: 'secret-family', name: 'Secret Model',
      ...(o.maxInput == null ? {} : { maxInputTokens: o.maxInput }),
      maxOutputTokens: 64_000,
      configurationSchema: {
        properties: {
          reasoningEffort: { type: 'string', default: 'medium', enum: ['low', 'medium', 'high'] },
          ...(o.options ? { contextSize: { type: 'number', default: o.fallback ?? o.options[0], enum: o.options } } : {}),
        },
      },
    },
    modelConfiguration: { reasoningEffort: 'medium', ...(o.configured == null ? {} : { contextSize: o.configured }) },
  };
}

const GPT = (configured?: number) => model('copilot/gpt-5.6-sol', { maxInput: 921_793, options: [272_000, 922_000], fallback: 272_000, configured });
const OPUS = model('copilot/claude-opus-4.8', { maxInput: 935_793, options: [200_000, 936_000], fallback: 936_000, configured: 936_000 });
const AUTO = model('copilot/auto', { maxInput: 128_000 });

function request(id: string, modelId: string | undefined, promptTokens = 20_000): Record<string, unknown> {
  return {
    requestId: id,
    timestamp: 1_790_000_000_000 + Number(id.replaceAll(/\D/g, '') || 0) * 60_000,
    message: { text: 'secret prompt' },
    response: [{ value: 'secret answer' }],
    ...(modelId ? { modelId } : {}),
    result: { metadata: { promptTokens, outputTokens: 100 } },
  };
}

function jsonl(entries: object[]): string {
  return writeTemp('session.jsonl', entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function limitsOf(file: string): (number | null)[] {
  const session = parseSessionFile(file, 'ws', 'demo', 'Local Agent');
  return session?.requests.map(requestContextLimit) ?? [];
}

describe('selectedModelLimit', () => {
  it('prefers the configured context size, then its default, then the maximum input tokens', () => {
    expect(selectedModelLimit(GPT(272_000))).toEqual({ identifier: 'copilot/gpt-5.6-sol', limit: 272_000 });
    expect(selectedModelLimit(GPT())).toEqual({ identifier: 'copilot/gpt-5.6-sol', limit: 272_000 });
    expect(selectedModelLimit(model('byok/model', { maxInput: 128_000 }))).toEqual({ identifier: 'byok/model', limit: 128_000 });
  });

  it('never goes above the maximum input tokens', () => {
    expect(selectedModelLimit(GPT(922_000))?.limit).toBe(921_793);
    expect(selectedModelLimit(model('x/y', { options: [500_000], configured: 500_000 }))?.limit).toBe(500_000);
  });

  it('has no limit for Auto, a missing identifier or no logged size', () => {
    expect(selectedModelLimit(AUTO)).toBeNull();
    expect(selectedModelLimit({ ...GPT(), identifier: '' })).toBeNull();
    expect(selectedModelLimit(model('x/y', {}))).toBeNull();
    expect(selectedModelLimit(model('x/y', { maxInput: -5 }))).toBeNull();
    expect(selectedModelLimit(null)).toBeNull();
  });
});

describe('SelectedModelLimits', () => {
  it('stamps a request without a model id with the model selected when it was added', () => {
    const limits = new SelectedModelLimits();
    limits.select(OPUS);
    limits.stamp([{ requestId: 'r1' }]);
    limits.select(GPT());
    expect(limits.limitFor('r1', 'copilot/claude-opus-4.8')).toBe(935_793);
    expect(limits.limitFor('r1', 'copilot/gpt-5.6-sol')).toBe(272_000);
    expect(limits.limitFor('r9', 'copilot/unknown')).toBeNull();
  });
});

describe('VS Code request context limits', () => {
  it('give each request the limit selected when it was added, across model and context-size changes', () => {
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', creationDate: 1_790_000_000_000, inputState: { mode: { id: 'agent' }, selectedModel: GPT(272_000) }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', 'copilot/gpt-5.6-sol')] },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 30_000, outputTokens: 50 } } },
      { kind: 1, k: ['inputState', 'selectedModel'], v: OPUS },
      { kind: 2, k: ['requests'], v: [request('r2', 'copilot/claude-opus-4.8')] },
      { kind: 1, k: ['inputState', 'selectedModel'], v: GPT(922_000) },
      { kind: 2, k: ['requests'], v: [request('r3', 'copilot/gpt-5.6-sol')] },
    ]);
    expect(limitsOf(file)).toEqual([272_000, 935_793, 921_793]);
  });

  it('takes the limit of requests present in the initial state and of a legacy .json session', () => {
    const initial = jsonl([
      { kind: 0, v: { sessionId: 's', inputState: { selectedModel: OPUS }, requests: [request('r1', 'copilot/claude-opus-4.8')] } },
    ]);
    expect(limitsOf(initial)).toEqual([935_793]);
    const legacy = writeTemp('legacy.json', JSON.stringify({ sessionId: 'l', inputState: { selectedModel: GPT() }, requests: [request('r1', 'copilot/gpt-5.6-sol')] }));
    expect(limitsOf(legacy)).toEqual([272_000]);
  });

  it('leaves Auto, unknown models and sessions without a selected model on the estimate', () => {
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', inputState: { selectedModel: AUTO }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', 'copilot/auto')] },
      { kind: 1, k: ['inputState', 'selectedModel'], v: GPT() },
      { kind: 2, k: ['requests'], v: [request('r2', 'copilot/other-model')] },
    ]);
    expect(limitsOf(file)).toEqual([null, null]);
    const none = writeTemp('none.json', JSON.stringify({ sessionId: 'n', requests: [request('r1', 'copilot/gpt-5.6-sol')] }));
    expect(limitsOf(none)).toEqual([null]);
  });
});

describe('VS Code request context limits as a session is replayed', () => {
  it('give a request added before its model id is set the limit of the model then selected', () => {
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', inputState: { selectedModel: OPUS }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', undefined)] },
      { kind: 1, k: ['inputState', 'selectedModel'], v: GPT() },
      { kind: 1, k: ['requests', 0, 'modelId'], v: 'copilot/claude-opus-4.8' },
    ]);
    expect(limitsOf(file)).toEqual([935_793]);
  });

  it('measure VS Code utilization against the reported limit', () => {
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', creationDate: 1_790_000_000_000, inputState: { selectedModel: OPUS }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', 'copilot/claude-opus-4.8', 120_000), request('r2', 'copilot/claude-opus-4.8', 150_000)] },
    ]);
    const session = parseSessionFile(file, 'ws', 'demo', 'Local Agent')!;
    expect(sessionContextWindow(session)).toMatchObject({ source: 'reported', window: 935_793 });
    const [workspace] = new Analyzer([session]).getContextManagement().workspaces;
    expect(workspace).toMatchObject({ windowSource: 'reported', verdict: 'optimal' });
    expect(workspace.peakUtilization).toBeCloseTo((150_000 / 935_793) * 100, 1);
  });
});

describe('VS Code request context limits around model changes', () => {
  it('give the first request after a model switch the model selected right after it, as VS Code saves that request first', () => {
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', inputState: { selectedModel: GPT(272_000) }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', 'copilot/claude-opus-4.8')] },
      { kind: 1, k: ['inputState', 'inputText'], v: '' },
      { kind: 1, k: ['inputState', 'selectedModel'], v: OPUS },
      { kind: 2, k: ['requests'], v: [request('r2', 'copilot/claude-opus-4.8')] },
    ]);
    expect(limitsOf(file)).toEqual([935_793, 935_793]);
  });

  it('never give a request a model selected only after later requests, even when the file rewrites its requests', () => {
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', inputState: { selectedModel: GPT(272_000) }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', 'copilot/claude-opus-4.8')] },
      { kind: 2, k: ['requests'], v: [request('r2', 'copilot/gpt-5.6-sol')] },
      { kind: 1, k: ['inputState', 'selectedModel'], v: OPUS },
      { kind: 1, k: ['requests'], v: [request('r1', 'copilot/claude-opus-4.8'), request('r2', 'copilot/gpt-5.6-sol')] },
      { kind: 2, k: ['requests'], v: [request('r3', 'copilot/claude-opus-4.8')] },
    ]);
    expect(limitsOf(file)).toEqual([null, 272_000, 935_793]);
  });

  it('prefer the selection logged right after a request over an older setting of its model', () => {
    const opus200k = model('copilot/claude-opus-4.8', { maxInput: 935_793, options: [200_000, 936_000], fallback: 936_000, configured: 200_000 });
    const file = jsonl([
      { kind: 0, v: { sessionId: 's', inputState: { selectedModel: OPUS }, requests: [] } },
      { kind: 2, k: ['requests'], v: [request('r1', 'copilot/claude-opus-4.8')] },
      { kind: 1, k: ['inputState', 'selectedModel'], v: GPT(272_000) },
      { kind: 2, k: ['requests'], v: [request('r2', 'copilot/gpt-5.6-sol')] },
      { kind: 2, k: ['requests'], v: [request('r3', 'copilot/claude-opus-4.8')] },
      { kind: 1, k: ['inputState', 'selectedModel'], v: opus200k },
    ]);
    expect(limitsOf(file)).toEqual([935_793, 272_000, 200_000]);
  });
});