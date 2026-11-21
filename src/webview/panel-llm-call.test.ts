/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { callLlm, callLlmJson } from './panel-llm';
import { COPILOT_UNAVAILABLE_MESSAGE, isCopilotModelAvailable } from './panel-llm-model';

const mocks = vi.hoisted(() => ({
  selectChatModels: vi.fn(),
  sendRequest: vi.fn(),
}));

vi.mock('vscode', () => {
  class LanguageModelError extends Error {
    constructor(message: string, readonly code: string) { super(message); }
    static NoPermissions(message = '') { return new LanguageModelError(message, 'NoPermissions'); }
    static Blocked(message = '') { return new LanguageModelError(message, 'Blocked'); }
    static NotFound(message = '') { return new LanguageModelError(message, 'NotFound'); }
  }
  class CancellationError extends Error {}
  class CancellationTokenSource {
    token = { isCancellationRequested: false };
    cancel(): void { this.token.isCancellationRequested = true; }
    dispose(): void {}
  }
  class LanguageModelTextPart { constructor(readonly value: string) {} }
  class LanguageModelChatMessage {
    constructor(readonly role: number, readonly content: unknown[], readonly name?: string) {}
    static User(text: string) { return new LanguageModelChatMessage(1, [new LanguageModelTextPart(text)]); }
  }
  return {
    lm: { selectChatModels: mocks.selectChatModels },
    LanguageModelError,
    CancellationError,
    CancellationTokenSource,
    LanguageModelTextPart,
    LanguageModelChatMessage,
  };
});
vi.mock('../core/runtime-debug', () => ({ runtimeDebug: () => {} }));

const AUTO_SELECTOR = { vendor: 'copilot', id: 'auto' };
const model = { id: 'auto', vendor: 'copilot', family: 'routed-family', sendRequest: mocks.sendRequest };

function reply(...chunks: string[]) {
  return {
    text: (async function* () {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
    })(),
  };
}

const prompt = () => [vscode.LanguageModelChatMessage.User('Explain this session')];

/** Start a call and record how it settles, so tests can check when it finished. */
function track(call: Promise<string>): ReturnType<typeof vi.fn<(outcome: string) => void>> {
  const outcome = vi.fn<(outcome: string) => void>();
  call.then(text => outcome(`resolved: ${text}`), (err: unknown) => outcome(err instanceof Error ? err.message : String(err)));
  return outcome;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectChatModels.mockResolvedValue([model]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Copilot Auto model selection', () => {
  it('uses only GitHub Copilot\'s Auto model and explains why access is needed', async () => {
    mocks.sendRequest.mockResolvedValue(reply('Because ', 'reasons.'));

    await expect(callLlm(prompt())).resolves.toBe('Because reasons.');

    expect(mocks.selectChatModels).toHaveBeenCalledTimes(1);
    expect(mocks.selectChatModels).toHaveBeenCalledWith(AUTO_SELECTOR);
    const [, options] = mocks.sendRequest.mock.calls[0] as [unknown, vscode.LanguageModelChatRequestOptions];
    expect(options.justification).toContain('AI Engineer Coach');
  });

  it('fails fast with a sign-in message when Copilot is unavailable', async () => {
    mocks.selectChatModels.mockResolvedValue([]);

    await expect(callLlm(prompt())).rejects.toThrow(COPILOT_UNAVAILABLE_MESSAGE);

    expect(mocks.selectChatModels).toHaveBeenCalledTimes(1);
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it('bounds a stalled model selection', async () => {
    vi.useFakeTimers();
    mocks.selectChatModels.mockReturnValue(new Promise(() => {}));

    const assertion = expect(callLlm(prompt())).rejects.toThrow('Timed out waiting for GitHub Copilot to load');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });
});

describe('callLlm request budget', () => {
  it('counts model selection toward the 120s budget', async () => {
    vi.useFakeTimers();
    mocks.selectChatModels.mockImplementation(() => new Promise(resolve => { setTimeout(() => resolve([model]), 14_000); }));
    mocks.sendRequest
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('upstream 502')), 80_000);
      }))
      .mockImplementationOnce(() => new Promise(() => {}));

    const outcome = track(callLlm(prompt()));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toHaveBeenCalledWith('GitHub Copilot did not respond within 26s. Try again.');
    expect(mocks.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('fails at once when a shared deadline has already passed', async () => {
    await expect(callLlm(prompt(), { deadline: Date.now() - 1 })).rejects.toThrow('GitHub Copilot did not respond in time');

    expect(mocks.selectChatModels).not.toHaveBeenCalled();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });
});

describe('callLlm shared deadlines', () => {
  it('shares one deadline across calls that serve the same request', async () => {
    vi.useFakeTimers();
    mocks.sendRequest
      .mockImplementationOnce(() => new Promise(resolve => { setTimeout(() => resolve(reply('First draft.')), 70_000); }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const deadline = Date.now() + 120_000;

    const first = track(callLlm(prompt(), { deadline }));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(first).toHaveBeenCalledWith('resolved: First draft.');

    const second = track(callLlm(prompt(), { deadline }));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalledWith('GitHub Copilot did not respond within 50s. Try again.');
  });

  it('bounds model selection by a shared deadline', async () => {
    vi.useFakeTimers();
    mocks.selectChatModels.mockReturnValue(new Promise(() => {}));

    const outcome = track(callLlm(prompt(), { deadline: Date.now() + 5_000 }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toHaveBeenCalledWith('Timed out waiting for GitHub Copilot to load. Try again in a moment.');
  });
});

describe('isCopilotModelAvailable', () => {
  it('reports availability from the Auto selector', async () => {
    await expect(isCopilotModelAvailable(3000)).resolves.toBe(true);
    expect(mocks.selectChatModels).toHaveBeenCalledWith(AUTO_SELECTOR);

    mocks.selectChatModels.mockResolvedValue([]);
    await expect(isCopilotModelAvailable(3000)).resolves.toBe(false);
  });

  it('stays optimistic when the probe fails or stalls', async () => {
    mocks.selectChatModels.mockRejectedValue(new Error('provider crashed'));
    await expect(isCopilotModelAvailable(3000)).resolves.toBe(true);

    vi.useFakeTimers();
    mocks.selectChatModels.mockReturnValue(new Promise(() => {}));
    const probe = isCopilotModelAvailable(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(probe).resolves.toBe(true);
  });
});

describe('callLlm', () => {
  it('retries a transient failure and returns the reply', async () => {
    mocks.sendRequest
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(reply('Recovered.'));

    await expect(callLlm(prompt())).resolves.toBe('Recovered.');
    expect(mocks.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('treats an empty reply as a failure instead of a blank explanation', async () => {
    mocks.sendRequest.mockImplementation(() => Promise.resolve(reply('  ', '\n')));

    await expect(callLlm(prompt())).rejects.toThrow('GitHub Copilot returned an empty response');
    expect(mocks.sendRequest).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request that timed out, and cancels it', async () => {
    vi.useFakeTimers();
    mocks.sendRequest.mockReturnValue(new Promise(() => {}));

    const assertion = expect(callLlm(prompt())).rejects.toThrow('GitHub Copilot did not respond within 90s');
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;

    expect(mocks.sendRequest).toHaveBeenCalledTimes(1);
    const token = mocks.sendRequest.mock.calls[0][2] as { isCancellationRequested: boolean };
    expect(token.isCancellationRequested).toBe(true);
  });

  it.each([
    ['NoPermissions', 'Manage Language Model Access'],
    ['Blocked', 'rate limit or quota'],
    ['NotFound', 'no longer available'],
  ] as const)('does not retry a %s error and explains it', async (code, message) => {
    mocks.sendRequest.mockRejectedValue(vscode.LanguageModelError[code]('denied'));

    await expect(callLlm(prompt())).rejects.toThrow(message);
    expect(mocks.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('rethrows cancellation without retrying', async () => {
    mocks.sendRequest.mockRejectedValue(new vscode.CancellationError());

    await expect(callLlm(prompt())).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(mocks.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('caps later attempts by the overall time budget', async () => {
    vi.useFakeTimers();
    mocks.sendRequest
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('upstream 502')), 80_000);
      }))
      .mockImplementationOnce(() => new Promise(() => {}));

    const assertion = expect(callLlm(prompt())).rejects.toThrow('did not respond within 40s');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(mocks.sendRequest).toHaveBeenCalledTimes(2);
  });
});

describe('callLlmJson', () => {
  it('uses the Copilot Auto model and passes the justification with structured output', async () => {
    mocks.sendRequest.mockResolvedValue(reply('{"items":[]}'));

    await expect(callLlmJson<{ items: unknown[] }>(prompt(), { name: 'test_schema', schema: { type: 'object' } }))
      .resolves.toEqual({ items: [] });

    expect(mocks.selectChatModels).toHaveBeenCalledWith(AUTO_SELECTOR);
    const [, options] = mocks.sendRequest.mock.calls[0] as [unknown, vscode.LanguageModelChatRequestOptions];
    expect(options.justification).toContain('AI Engineer Coach');
    expect(options.modelOptions).toHaveProperty('response_format');
  });
});
