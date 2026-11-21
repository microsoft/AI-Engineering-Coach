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

/** A turn the transcript logged as it ran (its queue, API request or cost records): never a fork's copy. */
const live = (r: SessionRequest): SessionRequest => ({ ...r, loggedLive: true });

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

  it('finds a fork without a clock lead by the ordered history it shares with its source, which logged it live', () => {
    // The fork's preamble is missing, so its copies look like its own: the source holds the same prompts in the same
    // order, logged as they ran; the fork holds only the conversation lines.
    const source = session('src', [live(request(0, 'm1')), live(request(5, 'm2')), live(request(9, 'm3')), live(request(40, 'm5'))]);
    const fork = session('fork', [request(0, 'm1'), request(5, 'm2'), request(9, 'm3'), live(request(20, 'm4'))]);
    const [s, f] = withInheritedTurnsRemoved([source, fork]);
    expect([s.requests.length, f.requests.map(r => r.userEventId), f.inheritedTurns, f.forkedFromId]).toEqual([4, ['m4'], 3, 'src']);
    // The source went on first after the shared history: the live records, not the order, say which is the fork (B7).
    const early = session('src', [live(request(0, 'm1')), live(request(5, 'm2')), live(request(9, 'm3')), live(request(19, 'm5'))]);
    const [s3, f3] = withInheritedTurnsRemoved([early, fork]);
    expect([s3.requests.map(r => r.userEventId), f3.requests.map(r => r.userEventId), f3.forkedFromId]).toEqual([['m1', 'm2', 'm3', 'm5'], ['m4'], 'src']);
    // With no such records on either side, both went on, and nothing says which copied: both keep their turns.
    const [a3, b3] = withInheritedTurnsRemoved([session('a', [request(0, 'm1'), request(19, 'x')]), session('b', [request(0, 'm1'), request(20, 'y')])]);
    expect([a3.requests.length, b3.requests.length, a3.forkedFromId, b3.forkedFromId]).toEqual([2, 2, undefined, undefined]);
    // Without them, which one went on is no proof of direction either way: a source can go on after a fork that held only
    // the copies, or the other way round. Neither is a fork, and both keep the shared prompts (C5).
    const [s2, f2] = withInheritedTurnsRemoved([session('src', [request(0, 'm1')]), session('fork', [request(0, 'm1'), request(20, 'm4')])]);
    expect([s2.requests.length, f2.requests.length, s2.forkedFromId, f2.forkedFromId]).toEqual([1, 2, undefined, undefined]);
    const shared = () => [request(0, 'm1'), request(5, 'm2'), request(9, 'm3')];
    const [s4, f4] = withInheritedTurnsRemoved([session('src', [...shared(), request(30, 'm4'), request(35, 'm5')]), session('fork', shared())]);
    expect([s4.requests.length, f4.requests.length, s4.forkedFromId, f4.forkedFromId]).toEqual([5, 3, undefined, undefined]);
    // Two transcripts that went on at the same moment: no way to tell, so both keep their turns.
    const [a, b] = withInheritedTurnsRemoved([session('a', [request(0, 'm1'), request(20, 'x')]), session('b', [request(0, 'm1'), request(20, 'y')])]);
    expect([a.requests.length, b.requests.length]).toEqual([2, 2]);
  });
});

describe('withInheritedTurnsRemoved with sub-agent turns', () => {
  it('compares only coordinator turns when the source has a sub-agent turn between the copied prompts', () => {
    const sub = { ...request(3, 'sub1'), nonHumanKind: 'subagent' as const };
    const source = session('src', [live(request(0, 'm1')), sub, live(request(5, 'm2')), live(request(40, 'm5'))]);
    const fork = session('fork', [request(0, 'm1'), request(5, 'm2'), request(20, 'm4')]);
    const [s, f] = withInheritedTurnsRemoved([source, fork]);
    // The sub-agent's work stays in the session that ran it.
    expect([s.requests.map(r => r.userEventId), f.requests.map(r => r.userEventId), f.inheritedTurns, f.forkedFromId])
      .toEqual([['m1', 'sub1', 'm2', 'm5'], ['m4'], 2, 'src']);
    // A sub-agent turn the fork copied (same message and time) is a copy too; one it ran itself is its own.
    const own = { ...request(25, 'sub2'), nonHumanKind: 'subagent' as const };
    const [, f2] = withInheritedTurnsRemoved([source, session('fork', [request(0, 'm1'), { ...sub }, request(5, 'm2'), request(20, 'm4'), own])]);
    expect([f2.requests.map(r => r.userEventId), f2.inheritedTurns]).toEqual([['m4', 'sub2'], 3]);
  });
});

describe('withInheritedTurnsRemoved for forks of forks', () => {
  it('links a fork without a lead to the fork it copied, even when that one has a lead', () => {
    const a = session('a', [live(request(0, 'm1')), live(request(5, 'm2'))]);
    const b = session('b', [request(0, 'm1', 30_000), request(5, 'm2', 30_000), live(request(10, 'm3'))]);
    const c = session('c', [request(0, 'm1'), request(5, 'm2'), request(10, 'm3'), live(request(20, 'm4'))]);
    const out = withInheritedTurnsRemoved([a, b, c]);
    expect(out.map(s => [s.sessionId, s.requests.map(r => r.userEventId), s.inheritedTurns, s.forkedFromId]))
      .toEqual([['a', ['m1', 'm2'], undefined, undefined], ['b', ['m3'], 2, 'a'], ['c', ['m4'], 3, 'b']]);
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

  it('keeps a fork that holds only copied turns in the Sessions list (B11)', () => {
    const analyzer = new Analyzer([session('src', [request(0, 'm1')]), session('fork', [request(0, 'm1', 500)])], new Map());
    expect(analyzer.getSessions(1, 50).sessions.map(s => [s.sessionId, s.requestCount])).toEqual([['src', 1], ['fork', 0]]);
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