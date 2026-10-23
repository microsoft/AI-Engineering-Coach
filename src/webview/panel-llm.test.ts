/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

class MockCancellationTokenSource {
  token = { isCancellationRequested: false };
  cancel(): void {}
  dispose(): void {}
}

const { sendRequestMock } = vi.hoisted(() => ({ sendRequestMock: vi.fn() }));

vi.mock('vscode', () => ({
  lm: {
    selectChatModels: vi.fn(async () => [
      {
        id: 'mock-model',
        sendRequest: sendRequestMock,
      },
    ]),
  },
  LanguageModelTextPart: class LanguageModelTextPart {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  },
  LanguageModelChatMessage: class LanguageModelChatMessage {
    role: number;
    content: { value: string }[];
    name?: string;
    constructor(role: number, content: { value: string }[], name?: string) {
      this.role = role;
      this.content = content;
      this.name = name;
    }
    static User(content: string) {
      return new LanguageModelChatMessage(1, [{ value: content }]);
    }
  },
  CancellationTokenSource: MockCancellationTokenSource,
  CancellationError: class CancellationError extends Error {},
}));

vi.mock('../core/runtime-debug', () => ({ runtimeDebug: vi.fn() }));
vi.mock('../core/redact-secrets', () => ({ redactSecrets: (s: string) => s }));

async function textStream(chunks: string[]) {
  return {
    text: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

describe('callLlmJson structured-output fallback', () => {
  beforeEach(() => {
    sendRequestMock.mockReset();
  });

  it('drops modelOptions after a generic structured-output rejection and recovers in plain mode', async () => {
    const { callLlmJson } = await import('./panel-llm');

    sendRequestMock
      .mockImplementationOnce(async (_messages: unknown, options: Record<string, unknown>) => {
        // First call is structured; reject with a generic, non-pattern-matching error.
        expect(options.modelOptions).toBeDefined();
        throw new Error('upstream provider error: request failed');
      })
      .mockImplementationOnce(async (_messages: unknown, options: Record<string, unknown>) => {
        // Second call must have modelOptions cleared so plain mode can recover.
        expect(options.modelOptions).toBeUndefined();
        return textStream(['{"ok":true}']);
      });

    const vscode = await import('vscode');
    const result = await callLlmJson<{ ok: boolean }>(
      [vscode.LanguageModelChatMessage.User('hi')] as never,
      { name: 'test_schema', schema: { type: 'object' } }
    );

    expect(result).toEqual({ ok: true });
    expect(sendRequestMock).toHaveBeenCalledTimes(2);
  });
});
