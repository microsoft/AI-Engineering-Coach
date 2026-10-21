/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { SessionSchema, SessionRequestSchema, validateSessions } from './schemas';

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    timestamp: 1700000000000,
    messageText: 'hello',
    responseText: 'world',
    isCanceled: false,
    agentName: '',
    agentMode: '',
    modelId: 'gpt-4',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: null,
    totalElapsed: 100,
    messageLength: 5,
    responseLength: 5,
    userCode: [],
    aiCode: [],
    toolConfirmations: [],
    promptTokens: 100,
    completionTokens: 50,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'feature',
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'my-project',
    location: '/path/to/sessions',
    harness: 'vscode',
    creationDate: 1700000000000,
    lastMessageDate: 1700000001000,
    requestCount: 1,
    requests: [makeRequest()],
    ...overrides,
  };
}

describe('SessionRequestSchema', () => {
  it('validates a well-formed request', () => {
    const result = SessionRequestSchema.safeParse(makeRequest());
    expect(result.success).toBe(true);
  });

  it('preserves optional recorded source hosts and rejects non-string domains', () => {
    const result = SessionRequestSchema.safeParse(makeRequest({ webDomains: ['docs.python.org'] }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.webDomains).toEqual(['docs.python.org']);
    expect(SessionRequestSchema.safeParse(makeRequest({ webDomains: [42] })).success).toBe(false);
  });

  it('rejects request missing required field', () => {
    const { messageText: _, ...incomplete } = makeRequest();
    const result = SessionRequestSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it('preserves extra fields via passthrough', () => {
    const result = SessionRequestSchema.safeParse(makeRequest({ extraField: 'kept' }));
    expect(result.success).toBe(true);
    expect((result as { success: true; data: Record<string, unknown> }).data.extraField).toBe('kept');
  });
});

describe('SessionSchema', () => {
  it('validates a well-formed session', () => {
    const result = SessionSchema.safeParse(makeSession());
    expect(result.success).toBe(true);
  });

  it('rejects session missing required field', () => {
    const { sessionId: _, ...incomplete } = makeSession();
    const result = SessionSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it('preserves extra fields via passthrough', () => {
    const result = SessionSchema.safeParse(makeSession({ customProp: 42 }));
    expect(result.success).toBe(true);
    expect((result as { success: true; data: Record<string, unknown> }).data.customProp).toBe(42);
  });

  it('accepts optional fields when absent', () => {
    const session = makeSession();
    // No modelUsage, endReason, hasDevcontainer, customInstructionsBytes
    const result = SessionSchema.safeParse(session);
    expect(result.success).toBe(true);
  });
});

describe('validateSessions', () => {
  it('keeps valid sessions and filters invalid ones', () => {
    const good = makeSession();
    const bad = { sessionId: 'incomplete' }; // missing many required fields
    const result = validateSessions([good, bad], 'test');
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('sess-1');
  });

  it('returns empty array for all-invalid input', () => {
    const result = validateSessions([null, undefined, {}], 'test');
    expect(result).toHaveLength(0);
  });
});
