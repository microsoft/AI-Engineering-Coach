/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { Analyzer } from './analyzer';
import { withAnalyzedTurns, withInheritedTurnsRemoved } from './fork-ownership';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import type { Session, SessionRequest } from './types/session-types';

const at = (m: number) => new Date(2025, 5, 15, 10, m).getTime();

function request(minute: number, id: string, historyLeadMs?: number): SessionRequest {
  return {
    requestId: id, userEventId: id, timestamp: at(minute), messageText: 'p', responseText: 'r', isCanceled: false, agentName: 'Claude',
    agentMode: 'agent', modelId: 'claude-sonnet-4', toolsUsed: [], editedFiles: [], referencedFiles: [], slashCommand: '', variableKinds: {},
    customInstructions: [], skillsUsed: [], firstProgress: 100, totalElapsed: 60_000, messageLength: 1, responseLength: 1, userCode: [],
    aiCode: [], toolConfirmations: [], promptTokens: 10, completionTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, compaction: null,
    todoSnapshot: null, workType: 'other', ...(historyLeadMs ? { historyLeadMs } : {}),
  };
}

function session(id: string, requests: SessionRequest[]): Session {
  return {
    sessionId: id, workspaceId: 'ws', workspaceName: 'shop', location: '', harness: 'Claude', creationDate: requests[0]?.timestamp ?? null,
    lastMessageDate: requests[requests.length - 1]?.timestamp ?? null, requestCount: requests.length, requests,
  };
}

describe('withInheritedTurnsRemoved', () => {
  it('leaves a copied turn to the session that owns it, and links the fork to it', () => {
    const source = session('src', [request(0, 'm1'), request(5, 'm2')]);
    // Copied 500 ms before the fork's first line: short, but the source holds the same message.
    const fork = session('fork', [request(0, 'm1', 500), request(20, 'm3')]);
    const [s, f] = withInheritedTurnsRemoved([source, fork]);
    expect(s).toBe(source);
    expect([f.requests.map(r => r.userEventId), f.requestCount, f.inheritedTurns, f.forkedFromId, f.creationDate]).toEqual([['m3'], 1, 1, 'src', at(20)]);
  });

  it('keeps a turn logged a few milliseconds out of order when no other session holds it', () => {
    const plain = session('plain', [request(0, 'm1', 3)]);
    expect(withInheritedTurnsRemoved([plain])[0]).toBe(plain);
  });

  it('removes copied history whose source isn’t loaded, without inventing a source', () => {
    const [f] = withInheritedTurnsRemoved([session('fork', [request(0, 'm1', 60_000), request(20, 'm3')])]);
    expect([f.requests.length, f.inheritedTurns, f.forkedFromId]).toEqual([1, 1, undefined]);
  });

  it('finds a fork without a clock lead by the ordered history it shares with its source', () => {
    // The fork's preamble is missing, so its copies look like its own: the source holds the same prompts in the same
    // order, and the fork went on first after them.
    const source = session('src', [request(0, 'm1'), request(5, 'm2'), request(9, 'm3'), request(40, 'm5')]);
    const fork = session('fork', [request(0, 'm1'), request(5, 'm2'), request(9, 'm3'), request(20, 'm4')]);
    const [s, f] = withInheritedTurnsRemoved([source, fork]);
    expect([s.requests.length, f.requests.map(r => r.userEventId), f.inheritedTurns, f.forkedFromId]).toEqual([4, ['m4'], 3, 'src']);
    // A transcript holding only the shared prompts is the source.
    const [s2, f2] = withInheritedTurnsRemoved([session('src', [request(0, 'm1')]), session('fork', [request(0, 'm1'), request(20, 'm4')])]);
    expect([s2.requests.length, f2.requests.length]).toEqual([1, 1]);
    // Two transcripts that went on at the same moment: no way to tell, so both keep their turns.
    const [a, b] = withInheritedTurnsRemoved([session('a', [request(0, 'm1'), request(20, 'x')]), session('b', [request(0, 'm1'), request(20, 'y')])]);
    expect([a.requests.length, b.requests.length]).toEqual([2, 2]);
  });
  it('links a fork of a fork to its direct source', () => {
    const a = session('a', [request(0, 'm1')]);
    const b = session('b', [request(0, 'm1', 30_000), request(10, 'm2')]);
    const c = session('c', [request(0, 'm1', 60_000), request(10, 'm2', 60_000), request(30, 'm3')]);
    const out = withInheritedTurnsRemoved([a, b, c]);
    expect(out.map(s => [s.sessionId, s.forkedFromId, s.inheritedTurns])).toEqual([['a', undefined, undefined], ['b', 'a', 1], ['c', 'b', 2]]);
  });

  it('makes every tab and the export count a copied turn once', () => {
    const analyzer = new Analyzer([session('src', [request(0, 'm1'), request(5, 'm2')]), session('fork', [request(0, 'm1', 500), request(5, 'm2', 500), request(20, 'm3')])], new Map());
    const report = buildSummaryExportFromAnalyzer(analyzer);
    const autonomy = report.autonomy;
    expect(report.totals.requests).toBe(3);
    expect((autonomy?.typedTurns ?? 0) + (autonomy?.automatedTurns ?? 0)).toBe(3);
  });

  it('keeps a fork’s detail view, read again from disk, to the turns the analysis kept', () => {
    const full = session('fork', [request(0, 'm1', 500), request(20, 'm3')]);
    const [, analyzed] = withInheritedTurnsRemoved([session('src', [request(0, 'm1')]), full]);
    const detail = withAnalyzedTurns(full, analyzed);
    expect([detail.requests.map(r => r.requestId), detail.requestCount, detail.inheritedTurns, detail.forkedFromId]).toEqual([['m3'], 1, 1, 'src']);
    const plain = session('plain', [request(0, 'x')]);
    expect(withAnalyzedTurns(plain, plain)).toBe(plain);
  });
});