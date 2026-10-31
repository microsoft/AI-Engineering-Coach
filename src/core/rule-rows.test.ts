/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { createRequest, createSession } from './parser-shared';
import { toRuleRequestRows } from './rule-rows';
import type { SessionRequest } from './types';

function session(harness: string, ...ids: string[]) {
  const requests = ids.map(requestId => createRequest({ requestId, messageText: `prompt ${requestId}`, responseText: '' }));
  return createSession({ sessionId: harness, workspaceId: 'ws', workspaceName: 'Project', harness, requests });
}

describe('toRuleRequestRows', () => {
  const claude = session('Claude', 'a', 'b');
  const vscode = session('Local Agent', 'c');
  const reqs = [...claude.requests, ...vscode.requests];

  it('copies each request with its session harness and leaves the shared requests untouched', () => {
    const rows = toRuleRequestRows(reqs, [claude, vscode]);
    expect(rows.map(row => [row.requestId, row.harness])).toEqual([['a', 'Claude'], ['b', 'Claude'], ['c', 'Local Agent']]);
    expect(rows[0]).not.toBe(reqs[0]);
    expect(rows[0]).toEqual({ ...reqs[0], harness: 'Claude' });
    expect(reqs.some(request => 'harness' in request)).toBe(false);
  });

  it('resolves requests by identity, not by request ID', () => {
    const twin = session('Codex', 'a');
    expect(toRuleRequestRows([twin.requests[0], claude.requests[0]], [claude, twin]).map(row => row.harness)).toEqual(['Codex', 'Claude']);
  });

  it('accepts a request-to-session index', () => {
    const index = new Map<SessionRequest, typeof claude>([[vscode.requests[0], vscode]]);
    expect(toRuleRequestRows(vscode.requests, index).map(row => row.harness)).toEqual(['Local Agent']);
  });

  it('gives an unresolved request an empty harness, and keeps one it already carries', () => {
    const rows = toRuleRequestRows(reqs, [vscode]);
    expect(rows.map(row => row.harness)).toEqual(['', '', 'Local Agent']);
    expect(toRuleRequestRows(toRuleRequestRows(reqs, [claude]), []).map(row => row.harness)).toEqual(['Claude', 'Claude', '']);
  });
});
