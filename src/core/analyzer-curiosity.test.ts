/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { CuriosityAnalyzer } from './analyzer-curiosity';
import { curiosityBalance } from './curiosity-balance';
import { activityCount } from './curiosity-activity';
import { curiosityAntiPatterns } from './curiosity-patterns';
import { sessionReference } from './curiosity-context';
import { createRequest, createSession, stripSingleSession } from './parser-shared';
import { detectCuriosity } from './curiosity';
import type { SessionRequest } from './types';

const TIME = Date.parse('2026-09-30T12:00:00Z');
let serial = 0;
function request(text = 'Why does this happen?', overrides: Partial<SessionRequest> = {}) {
  const id = `event-${++serial}`;
  return createRequest({ requestId: id, userEventId: id, timestamp: TIME,
    messageText: text, responseText: 'A recorded answer.', answerEvidence: 'final',
    curiosity: detectCuriosity(text), ...overrides });
}
function session(id: string, requests: SessionRequest[], workspace = 'project', harness = 'GitHub Copilot App') {
  return createSession({ sessionId: id, workspaceId: workspace, workspaceName: workspace, harness, requests });
}
function analyze(requests: SessionRequest[]) {
  return new CuriosityAnalyzer([session('s', requests)], new Map()).getCuriosity();
}

describe('Curiosity activity', () => {
  it('caches equivalent filters independently of property order and empty filter values', () => {
    const source = session('s', [request(undefined, { referencedFiles: ['src/a.py'] })]);
    const analyzer = new CuriosityAnalyzer([source], new Map());
    expect(analyzer.getCuriosity()).toBe(analyzer.getCuriosity({}));
    expect(analyzer.getCuriosity({ language: '' })).toBe(analyzer.getCuriosity());
    const filtered = analyzer.getCuriosity({ workspaceId: 'project', language: 'Python' });
    expect(analyzer.getCuriosity({ language: 'Python', workspaceId: 'project' })).toBe(filtered);
    expect(analyzer.getCuriosity({ language: 'TypeScript', workspaceId: 'project' })).not.toBe(filtered);
    expect(filtered.counts.direct).toBe(1);
    expect(analyzer.getCuriosity({ language: 'TypeScript', workspaceId: 'project' }).counts.direct).toBe(0);
  });

  it('keeps every supported filter in the cache key', () => {
    const analyzer = new CuriosityAnalyzer([session('s', [request()])], new Map());
    const all = analyzer.getCuriosity();
    for (const filter of [
      { fromDate: '2026-10-01' }, { toDate: '2026-09-29' },
      { workspaceId: 'other' }, { harness: 'Claude' }, { language: 'Python' },
    ]) {
      const filtered = analyzer.getCuriosity(filter);
      expect(filtered).not.toBe(all);
      expect(filtered.coverage.human).toBe(0);
      expect(analyzer.getCuriosity(filter)).toBe(filtered);
    }
  });

  it('bounds cached summaries and resets them with each analyzer snapshot', () => {
    const source = session('s', [request()]);
    const analyzer = new CuriosityAnalyzer([source], new Map());
    const first = analyzer.getCuriosity();
    for (let index = 0; index < 32; index++) analyzer.getCuriosity({ workspaceId: `other-${index}` });
    expect(analyzer.getCuriosity()).not.toBe(first);
    expect(analyzer.getCuriosity()).toEqual(first);
    expect(new CuriosityAnalyzer([], new Map()).getCuriosity().coverage.human).toBe(0);
  });

  it('refreshes cached summaries when the local calendar date changes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-30T12:00:00'));
      const analyzer = new CuriosityAnalyzer([session('s', [request()])], new Map());
      const first = analyzer.getCuriosity();
      expect(analyzer.getCuriosity()).toBe(first);
      vi.setSystemTime(new Date('2026-10-01T12:00:00'));
      expect(analyzer.getCuriosity()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts one activity per turn and keeps question-led actions in project action', () => {
    const data = analyze([
      request('Why? How?'), request(undefined, { toolsUsed: ['web_search'] }),
      request(undefined, { toolsUsed: ['rg', 'web_fetch'] }),
      request('Can you fix it?', { toolsUsed: ['apply_patch'] }),
      request('Run it.', { toolsUsed: ['bash'] }), request('Yes'),
    ]);
    expect(data.counts).toEqual({ direct: 1, web: 1, repository: 1, action: 2 });
    expect(data.questionLedActions).toBe(1);
    expect(data.coverage).toMatchObject({ human: 6, classified: 5, unclassified: 1, reasons: { noQuestion: 1 } });
    expect(data.daily[0].counts).toEqual(data.counts);
    expect(data.evidence.repository[0]).toMatchObject({ sessionId: 's', date: '2026-09-30' });
  });

  it('includes bounded unique session names in source, language and daily hover samples', () => {
    const requests = [request('Why does the cache expire?', { toolsUsed: ['web_search'], referencedFiles: ['cache.ts'] }),
      request('How can I inspect it?', { toolsUsed: ['web_search'] })];
    const data = new CuriosityAnalyzer([session('a', requests), session('b', requests.map(item => ({ ...item })))], new Map()).getCuriosity();
    expect(data.daily[0].sessions?.web).toMatchObject([{ sessionId: 'a', name: 'Why does the cache expire?' }]);
    expect(data.daily[0].sessions?.web).toHaveLength(1);
    expect(data.research.web.sessionSamples).toHaveLength(1);
    expect(data.languages[0].sessionSamples).toHaveLength(1);
    expect(data.evidence.web[0]).toEqual({
      sessionId: 'a', name: 'Why does the cache expire?', timestamp: TIME, date: '2026-09-30',
      promptPreview: requests[0].messageText, promptTruncated: false,
      requestId: requests[0].requestId, workspaceId: 'project', workspace: 'project', harness: 'GitHub Copilot App',
    });

    expect(data.research.web).not.toHaveProperty('examples');
    const many = new CuriosityAnalyzer(Array.from({ length: 20 }, (_, index) =>
      session(`s-${index}`, [request(undefined, { toolsUsed: ['web_search'], timestamp: TIME + index })])), new Map()).getCuriosity();
    expect(many.daily[0].sessions?.web).toHaveLength(8);
    expect(many.research.web.sessionSamples).toHaveLength(8);
  });

  it('retains the sampled prompt and request identity even when timestamps tie', () => {
    const first = request('How does the initial request work?');
    const later = request('Why does the later request need research?', {
      toolsUsed: ['web_fetch'], webDomains: ['example.org'], referencedFiles: ['src/cache.ts'],
    });
    const data = analyze([first, later, request('Run the tests.', { toolsUsed: ['powershell'] })]);
    for (const sample of [data.daily[0].sessions?.web[0], data.research.web.sessionSamples[0], data.evidence.web[0]]) {
      expect(sample).toMatchObject({ requestId: later.requestId, workspaceId: 'project',
        name: first.messageText, promptPreview: later.messageText });
    }
    for (const sample of [data.chains.examples[0].session, data.languages[0].sessionSamples[0]]) {
      expect(sample).toMatchObject({ requestId: first.requestId, promptPreview: first.messageText });
    }
    expect(data.counts.action).toBe(1);
  });

  it('bounds and normalizes sampled previews without substituting the session title for missing text', () => {
    const first = request('How does the initial request work?');
    const later = request(`  Why does this sampled follow-up differ?\n\t${'Additional recorded context. '.repeat(5)}`);
    const source = session('previews', [first, later]);
    const sample = sessionReference(source, later);
    expect(sample).toMatchObject({ name: first.messageText, requestId: later.requestId,
      promptPreview: later.messageText.replaceAll(/\s+/g, ' ').trim().slice(0, 80), promptTruncated: true });
    expect(sample.promptPreview).toHaveLength(80);
    expect(sessionReference(source, request('')).promptPreview).toBe('');
  });

  it.each([79, 80, 81])('marks a %i-character prompt as truncated only when it exceeds the preview limit', length => {
    const turn = request('x'.repeat(length));
    const sample = sessionReference(session('limits', [turn]), turn);
    expect(sample.promptPreview).toBe(turn.messageText.slice(0, 80));
    expect(sample.promptTruncated).toBe(length > 80);
  });

  it('does not treat normalized whitespace as truncated prompt content', () => {
    const turn = request(`  ${'x'.repeat(80)}\n\t`);
    expect(sessionReference(session('whitespace', [turn]), turn)).toMatchObject({
      promptPreview: 'x'.repeat(80), promptTruncated: false,
    });
  });

  it('allows a reader when stored text is incomplete even if its normalized preview is short', () => {
    const turn = request(`Recorded prefix.${' '.repeat(600)}More recorded content.`);
    const source = session('stored-preview', [turn]);
    stripSingleSession(source);
    expect(sessionReference(source, turn)).toMatchObject({ promptPreview: 'Recorded prefix.', promptTruncated: true });
  });

  it('does not group Map and Set inquiries but still finds genuine repeats across sessions', () => {
    const map = 'How does `Map` store values in JavaScript?';
    const set = 'How does `Set` store values in JavaScript?';
    const sessions = [session('map', [request(map)]), session('set', [request(set)])];
    const distinct = new CuriosityAnalyzer(sessions, new Map()).getCuriosity();
    expect(distinct.repeated).toEqual([]);
    expect(curiosityAntiPatterns(distinct).some(pattern => pattern.id === 'curiosity-repeated-wording')).toBe(false);
    const repeated = new CuriosityAnalyzer([...sessions, session('repeat', [request(map)])], new Map()).getCuriosity();
    expect(repeated.repeated).toMatchObject([{ text: 'how does map store values in javascript', count: 2, sessions: 2 }]);
  });

  it('adds bounded source and relative-path tags, counting distinct selected human turns', () => {
    const first = request(undefined, {
      toolsUsed: ['web_fetch', 'view'], webDomains: ['docs.python.org', 'docs.python.org'],
      referencedFiles: ['src/core/a.ts', '/repo/src/core/b.ts', 'tests/e2e/a.ts', '/private/user/a.ts', '../secret/a.ts'],
    });
    const source = { ...session('tags', [
      first, { ...first }, request(undefined, { toolsUsed: ['view'], referencedFiles: ['file:///repo/src/core/c.ts'] }),
      request(undefined, { timestamp: TIME - 86_400_000, toolsUsed: ['web_fetch'], webDomains: ['old.example.org'] }),
      request('<relayed_message>Done</relayed_message>', { toolsUsed: ['web_fetch'], webDomains: ['excluded.example.org'] }),
      request(undefined, { referencedFiles: ['invented/topic.ts'], webDomains: ['invented.example.org'] }),
    ]), workspaceRootPath: '/repo' };
    const data = new CuriosityAnalyzer([source], new Map()).getCuriosity({ fromDate: '2026-09-30' });
    const expected = [
      { kind: 'web', label: 'docs.python.org', turns: 1 },
      { kind: 'repository', label: 'src/core/', turns: 2 },
      { kind: 'repository', label: 'tests/e2e/', turns: 1 },
    ];
    expect(data.evidence.repository[0].context).toEqual(expected);
    expect(data.research.web.sessionSamples[0].context).toEqual(expected);
    expect(data.languages[0].sessionSamples[0].context).toEqual(expected);
    expect(data.daily[0].sessions?.repository[0].context).toEqual(expected);
    expect(data.chains.examples[0].session.context).toEqual(expected);
    expect(data.coverage.duplicates).toBe(1);
  });

  it('normalizes Windows paths and omits absolute paths with no recorded workspace root', () => {
    const source = { ...session('windows', [request(undefined, {
      toolsUsed: ['view'], referencedFiles: ['C:\\Repo\\src\\core\\a.ts', 'file:///c:/repo/src/core/b.ts',
        'C:\\Other\\private.ts', 'src/core/*.ts', 'https://example.org/a.ts', 'README.md',
        'file://private/share/secret.ts', 'src/hidden%0a/folder/a.ts'],
    })]), workspaceRootPath: 'C:\\Repo' };
    expect(new CuriosityAnalyzer([source], new Map()).getCuriosity().evidence.repository[0].context)
      .toEqual([{ kind: 'repository', label: 'src/core/', turns: 1 }]);
    expect(new CuriosityAnalyzer([{ ...source, workspaceRootPath: undefined }], new Map()).getCuriosity().evidence.repository[0])
      .not.toHaveProperty('context');
  });

  it('limits each source type to two tags, without using prompt text', () => {
    const data = analyze([request('Why does authentication use Python?', {
      toolsUsed: ['web_fetch', 'view'], webDomains: ['c.example', 'a.example', 'b.example'],
      referencedFiles: ['src/c/a.ts', 'src/a/a.ts', 'src/b/a.ts'],
    })]);
    expect(data.evidence.repository[0].context).toEqual([
      { kind: 'web', label: 'a.example', turns: 1 }, { kind: 'web', label: 'b.example', turns: 1 },
      { kind: 'repository', label: 'src/a/', turns: 1 }, { kind: 'repository', label: 'src/b/', turns: 1 },
    ]);
  });

  it('gates balance checks on days, classified turns and coverage', () => {
    expect(curiosityBalance({ direct: 2, web: 0, repository: 0, action: 48 }, 50, 7))
      .toMatchObject({ status: 'flagged', warnings: [{ id: 'little-inquiry' }] });
    expect(curiosityBalance({ direct: 16, web: 16, repository: 16, action: 2 }, 50, 7))
      .toMatchObject({ status: 'flagged', warnings: [{ id: 'little-execution' }] });
    expect(curiosityBalance({ direct: 70, web: 0, repository: 0, action: 0 }, 100, 7).status).toBe('flagged');
    expect(curiosityBalance({ direct: 70, web: 0, repository: 0, action: 0 }, 101, 7).status).toBe('insufficient');
    for (const [human, days] of [[100, 7], [50, 6]]) {
      expect(curiosityBalance({ direct: 50, web: 0, repository: 0, action: 0 }, human, days).status).toBe('insufficient');
    }
    expect(curiosityBalance({ direct: 49, web: 0, repository: 0, action: 0 }, 49, 7).status).toBe('insufficient');
    expect(curiosityBalance({ direct: 0, web: 0, repository: 0, action: 0 }, 0, 7).status).toBe('insufficient');
    expect(curiosityBalance({ direct: 20, web: 0, repository: 0, action: 30 }, 0, 7).status).toBe('insufficient');
  });

  it('uses inclusive 10-50 percent coaching bounds and keeps extreme warnings distinct', () => {
    expect(curiosityBalance({ direct: 2, web: 3, repository: 5, action: 90 }, 100, 7))
      .toMatchObject({ workStatus: 'clear', investigationStatus: 'insufficient', warnings: [] });
    expect(curiosityBalance({ direct: 10, web: 15, repository: 25, action: 50 }, 100, 7))
      .toMatchObject({ status: 'clear', workStatus: 'clear', investigationStatus: 'clear', warnings: [] });
    expect(curiosityBalance({ direct: 9, web: 0, repository: 0, action: 91 }, 100, 7).warnings)
      .toEqual([expect.objectContaining({ id: 'build-heavy' })]);
    expect(curiosityBalance({ direct: 10, web: 16, repository: 25, action: 49 }, 100, 7).warnings)
      .toEqual([expect.objectContaining({ id: 'inquiry-heavy' })]);
    expect(curiosityBalance({ direct: 5, web: 0, repository: 0, action: 95 }, 100, 7).warnings[0].id).toBe('build-heavy');
    expect(curiosityBalance({ direct: 30, web: 30, repository: 35, action: 5 }, 100, 7).warnings[0].id).toBe('inquiry-heavy');
    expect(curiosityBalance({ direct: 2, web: 0, repository: 0, action: 98 }, 100, 7).warnings[0].id).toBe('little-inquiry');
    expect(curiosityBalance({ direct: 32, web: 32, repository: 32, action: 4 }, 100, 7).warnings[0].id).toBe('little-execution');
  });

  it('needs twenty inquiries and flags only shares strictly above eighty percent', () => {
    expect(curiosityBalance({ direct: 19, web: 0, repository: 0, action: 31 }, 50, 7))
      .toMatchObject({ workStatus: 'clear', investigationStatus: 'insufficient', warnings: [] });
    expect(curiosityBalance({ direct: 16, web: 4, repository: 0, action: 30 }, 50, 7))
      .toMatchObject({ status: 'clear', investigationStatus: 'clear', warnings: [] });
    for (const activity of ['direct', 'web', 'repository'] as const) {
      const counts = { direct: 1, web: 1, repository: 1, action: 30 };
      counts[activity] = 18;
      expect(curiosityBalance(counts, 50, 7)).toMatchObject({
        workStatus: 'clear', investigationStatus: 'flagged',
        warnings: [{ id: 'investigation-concentrated', activity }],
      });
    }
    expect(curiosityBalance({ direct: 17, web: 3, repository: 0, action: 30 }, 72, 7))
      .toMatchObject({ status: 'insufficient', investigationStatus: 'insufficient', warnings: [] });
  });

  it('applies balance gates to deduplicated filtered turns and active dates, not filled empty dates', () => {
    const requests = Array.from({ length: 70 }, (_, index) => request(undefined, {
      timestamp: TIME - (index % 7) * 86_400_000,
      ...(index % 2 ? { toolsUsed: ['bash'] } : {}),
    }));
    const analyzer = new CuriosityAnalyzer([
      session('a', requests), session('copy', requests.map(request => ({ ...request }))),
    ], new Map());
    const data = analyzer.getCuriosity();
    expect(data.balance).toMatchObject({ workStatus: 'clear', investigationStatus: 'flagged', activeDays: 7 });
    expect(data.coverage.classified).toBe(70);
    expect(analyzer.getCuriosity({ fromDate: '2026-09-25' }).balance)
      .toMatchObject({ status: 'insufficient', activeDays: 6, warnings: [] });
  });

  it('does not treat unknown tools, missing answers, or AI clarification as inquiry', () => {
    const missing = request(); delete missing.curiosity;
    const data = analyze([
      request(undefined, { toolsUsed: ['unknown_mcp_tool', 'view'] }),
      request(undefined, { toolsUsed: ['ask_user'] }),
      request(undefined, { answerEvidence: 'missing' }),
      request(undefined, { isCanceled: true }), request(''), missing,
    ]);
    expect(data.coverage).toMatchObject({ human: 5, classified: 0, unclassified: 4, excluded: 1, unscanned: 1,
      reasons: { unknownTool: 1, clarification: 1, noAnswer: 1, canceled: 1 } });
    expect(data.chains.total).toBe(0);
  });

  it('records observable actions even when a request is canceled or has unknown companion tools', () => {
    const data = analyze([request(), request(undefined, { editedFiles: ['a.ts'], isCanceled: true, toolsUsed: ['unknown'] }), request()]);
    expect(data.counts.action).toBe(1);
    expect(data.chains.total).toBe(0);
  });

  it('measures inquiry presence per unique human session, including mixed work and unclassified sessions', () => {
    const original = request();
    const data = new CuriosityAnalyzer([
      session('a', [original, request('Run it.', { toolsUsed: ['bash'] })]),
      session('b', [{ ...original }]),
      session('c', [request('Yes')]),
      session('d', [request('<relayed_message>Done</relayed_message>')]),
      session('e', [request('Apply it.', { toolsUsed: ['apply_patch'] })]),
    ], new Map()).getCuriosity();
    expect(data.sessionCounts).toEqual({ human: 3, inquiry: 1, action: 2, mixed: 1 });
    expect(data.sessions).toBe(2);
    expect(data.coverage.duplicates).toBe(1);
  });

  it('retains overlapping research evidence within actions, without counting delegation as a source', () => {
    const research = request('Investigate it.', { toolsUsed: ['web_search', 'view', 'bash'],
      investigationDelegations: ['research', 'explore'] });
    const data = new CuriosityAnalyzer([
      session('a', [research, request('Read it.', { toolsUsed: ['view'] })]),
      session('b', [{ ...research }]),
      session('c', [request('Research it.', { toolsUsed: ['task'], investigationDelegations: ['research'] })]),
      session('d', [request('<relayed_message>Done</relayed_message>', { toolsUsed: ['web_search'] })]),
    ], new Map()).getCuriosity();
    expect(data.counts).toEqual({ direct: 0, web: 0, repository: 0, action: 1 });
    expect(data.research.web).toMatchObject({ turns: 1, sessions: 1, withinAction: 1 });
    expect(data.research.repository).toMatchObject({ turns: 2, sessions: 1, withinAction: 1 });
    expect(data.research.delegated).toMatchObject({ turns: 2, sessions: 2, withinAction: 1 });
    expect(data.coverage.reasons.unknownTool).toBe(1);
  });

  it('keeps answer evidence after memory stripping and distinguishes legacy evidence', () => {
    const source = session('s', [request(undefined, { answerEvidence: 'legacy' }), request()]);
    stripSingleSession(source);
    const data = new CuriosityAnalyzer([source], new Map()).getCuriosity();
    expect(data.counts.direct).toBe(2);
    expect(data.coverage.legacyAnswers).toBe(1);
  });

  it('deduplicates original IDs across Copilot App/CLI without deduplicating wording', () => {
    const original = request('Why does the parser fail?');
    const repeated = request('Why does the parser fail?');
    const data = new CuriosityAnalyzer([
      session('a', [original]), session('b', [{ ...original }, repeated], 'project', 'GitHub Copilot CLI'),
    ], new Map()).getCuriosity();
    expect(data.coverage).toMatchObject({ human: 2, classified: 2, duplicates: 1 });
    expect(data.repeated).toMatchObject([{ count: 2, sessions: 2 }]);
  });

  it('shows the matching question rather than the first question in a multi-question turn', () => {
    const data = new CuriosityAnalyzer([
      session('a', [request('What is the cache lifetime? Why does the parser fail?')]),
      session('b', [request('How can I trace failures? Why does the parser fail?')]),
    ], new Map()).getCuriosity();
    expect(data.repeated).toMatchObject([{ text: 'why does the parser fail', count: 2, sessions: 2 }]);
    expect(data.repeated).toHaveLength(1);
  });

  it('never globally deduplicates generated request indices or unrelated harness IDs', () => {
    const first = request(undefined, { requestId: 'generated-0', userEventId: undefined, timestamp: TIME });
    const second = { ...first };
    const native = request(undefined, { userEventId: 'native', timestamp: TIME });
    const data = new CuriosityAnalyzer([
      session('a', [first, native]), session('b', [second, { ...native }], 'project', 'Claude'),
    ], new Map()).getCuriosity();
    expect(data.coverage.classified).toBe(4);
    expect(data.coverage.duplicates).toBe(0);
  });

  it('preserves forked follow-ups without counting copied prefixes or cross-session joins', () => {
    const prefix = [request(), request(undefined, { toolsUsed: ['view'] })];
    const data = new CuriosityAnalyzer([
      session('a', [...prefix, request('Implement it.', { toolsUsed: ['edit'] })]),
      session('b', [...prefix.map(item => ({ ...item })), request(undefined, { toolsUsed: ['web_search'] })]),
      session('c', [request()]),
    ], new Map()).getCuriosity();
    expect(data.coverage.classified).toBe(5);
    expect(data.coverage.duplicates).toBe(2);
    expect(data.counts).toEqual({ direct: 2, web: 1, repository: 1, action: 1 });
    expect(data.chains).toMatchObject({ total: 1, sustained: 1, exchanges: 3 });
    expect(data).not.toHaveProperty('pathways');
  });

  it('does not bridge short replies, missing analysis, unknown tools, AI gates or long pauses', () => {
    for (const boundary of [
      request('Yes'), request(undefined, { curiosity: undefined }), request(undefined, { toolsUsed: ['task'] }),
      request(undefined, { toolsUsed: ['ask_user'] }), request(undefined, { answerEvidence: 'missing' }),
      request(undefined, { isCanceled: true }), request(undefined, { endState: 'errored' }),
      request(undefined, { endState: 'pending' }),
    ]) expect(analyze([request(), boundary, request()]).chains.total).toBe(0);
    const data = analyze([request(undefined, { timestamp: TIME }),
      request(undefined, { timestamp: TIME + 86_400_000 }), request(undefined, { timestamp: TIME + 172_800_001 })]);
    expect(data.chains).toMatchObject({ total: 1, sustained: 0 });
  });

  it('skips empty transport context but breaks at excluded automation that performs tools', () => {
    expect(analyze([request(), request('<system_reminder>Note</system_reminder>'), request()]).chains.total).toBe(1);
    expect(analyze([request(), request('<relayed_message>Done</relayed_message>', { toolsUsed: ['bash'] }), request()]).chains.total).toBe(0);
  });

  it('distinguishes a two-turn follow-up from a longer three-turn inquiry, not question sentences', () => {
    expect(analyze([request('Why? How? What?')]).chains.total).toBe(0);
    expect(analyze([request(), request()]).chains).toMatchObject({ total: 1, sustained: 0, exchanges: 2 });
    const data = analyze([request(), request(), request(), request(), request('Yes')]);
    expect(data.chains).toMatchObject({ total: 1, sustained: 1, exchanges: 4, examples: [{ exchanges: 4 }] });
  });

  it('deduplicates identical and prefix-copy chains while preserving distinct later questions', () => {
    const shared = [request(), request(), request()];
    const data = new CuriosityAnalyzer([
      session('a', shared), session('b', [...shared.map(item => ({ ...item })), request(), request()]),
    ], new Map()).getCuriosity();
    expect(data.chains).toMatchObject({ total: 1, exchanges: 5, examples: [{ exchanges: 5 }] });
    expect(data.coverage).toMatchObject({ classified: 5, duplicates: 3 });
  });

  it('measures the full response span while retaining only a copied follow-up session reference', () => {
    const questions = Array.from({ length: 8 }, (_, index) =>
      request(undefined, { timestamp: TIME + index * 60_000, totalElapsed: 30_000 }));
    const data = new CuriosityAnalyzer([
      session('a', questions.slice(0, 6)), session('b', questions.map(item => ({ ...item }))),
    ], new Map()).getCuriosity();
    expect(data.chains).toMatchObject({ total: 1, exchanges: 8,
      examples: [{ exchanges: 8, elapsedMs: 450_000 }] });
    expect(data.chains.examples[0].session).toMatchObject({ sessionId: 'b', timestamp: TIME });
    expect(data.chains.examples[0]).not.toHaveProperty('questions');
    expect(data.coverage).toMatchObject({ classified: 8, duplicates: 6 });
  });

  it('includes response waits and idle gaps, using the latest response end if replies overlap', () => {
    expect(analyze([
      request(undefined, { timestamp: TIME, totalElapsed: 300_000 }),
      request(undefined, { timestamp: TIME + 60_000, totalElapsed: 10_000 }),
    ]).chains.examples[0].elapsedMs).toBe(300_000);
    expect(analyze([
      request(undefined, { timestamp: TIME, totalElapsed: 30_000 }),
      request(undefined, { timestamp: TIME + 7_200_000, totalElapsed: 45_000 }),
    ]).chains.examples[0].elapsedMs).toBe(7_245_000);
  });

  it.each([null, 0, -1, NaN, Infinity])('omits elapsed spans when any response timing is %s', totalElapsed => {
    for (const missing of [0, 1]) {
      const data = analyze([0, 1].map(index => request(undefined, {
        timestamp: TIME + index * 60_000, totalElapsed: index === missing ? totalElapsed : 30_000,
      })));
      expect(data.chains.total).toBe(1);
      expect(data.chains.examples[0].elapsedMs).toBeUndefined();
    }
  });

  it('does not infer elapsed time from indistinguishable question timestamps', () => {
    const data = analyze([request(undefined, { totalElapsed: 30_000 }), request(undefined, { totalElapsed: 30_000 })]);
    expect(data.chains.total).toBe(1);
    expect(data.chains.examples[0].elapsedMs).toBeUndefined();
  });

  it('resets incomplete timing at action boundaries and measures only the selected date window', () => {
    const data = analyze([
      request(undefined, { timestamp: TIME }), request(undefined, { timestamp: TIME + 60_000, totalElapsed: 30_000 }),
      request('Implement it.', { timestamp: TIME + 120_000, toolsUsed: ['edit'] }),
      request(undefined, { timestamp: TIME + 180_000, totalElapsed: 30_000 }),
      request(undefined, { timestamp: TIME + 240_000, totalElapsed: 30_000 }),
    ]);
    expect(data.chains.examples.map(chain => chain.elapsedMs)).toEqual([90_000, undefined]);
    const analyzer = new CuriosityAnalyzer([session('s', [0, 12, 13].map(hours =>
      request(undefined, { timestamp: TIME + hours * 3_600_000, totalElapsed: 30_000 })))], new Map());
    expect(analyzer.getCuriosity({ fromDate: '2026-10-01' }).chains.examples[0].elapsedMs).toBe(3_630_000);
  });

  it('uses source-file extensions as overlapping session contexts, never code-block or prompt topics', () => {
    const data = analyze([
      request('Why does Rust do this?', { referencedFiles: ['src/main.tsx', 'src/main.tsx', 'src/a.jsx'] }),
      request(undefined, { editedFiles: ['lib/run.PY', 'package.json', 'README.md'] }),
      request('What does this mean?', { aiCode: [{ language: 'rust', loc: 200 }] }),
    ]);
    expect(data.languages.map(row => row.language).sort()).toEqual(['JavaScript', 'Python', 'TypeScript']);
    for (const row of data.languages) expect(activityCount(row.counts)).toBe(3);
    expect(data.languages.find(row => row.language === 'TypeScript')?.files).toBe(1);
  });

  it('includes recorded files outside the main project, but not globs, config or automated evidence', () => {
    const source = session('s', [
      request(undefined, { referencedFiles: ['/repo/src/main.ts', '/outside/test.py', 'src/*.rs', '../other/x.go',
        'package.json', 'README.md'] }),
      request('<relayed_message>Done</relayed_message>', { referencedFiles: ['/repo/x.java'] }),
    ]);
    source.workspaceRootPath = '/repo';
    const data = new CuriosityAnalyzer([source], new Map()).getCuriosity();
    expect(data.languages.map(row => row.language).sort()).toEqual(['Go', 'Python', 'TypeScript']);
    expect(data.languages.every(row => row.sessions === 1)).toBe(true);
    expect(new CuriosityAnalyzer([source], new Map()).getCuriosity({ language: 'Python' }).counts.direct).toBe(1);
  });

  it('does not share touched languages between sessions in the same project', () => {
    const ts = session('ts-session', [request(undefined, { referencedFiles: ['src/a.ts'] }), request()]);
    const py = session('py-session', [request('Run it.', { editedFiles: ['src/a.py'], toolsUsed: ['edit'] })]);
    const neither = session('no-files', [request('Why does Rust do this?', { aiCode: [{ language: 'rust', loc: 20 }] })]);
    for (const source of [ts, py, neither]) source.workspaceRootPath = '/same-project';
    const analyzer = new CuriosityAnalyzer([ts, py, neither], new Map());
    const data = analyzer.getCuriosity();
    expect(data.languages).toMatchObject([
      { language: 'TypeScript', sessions: 1, inquirySessions: 1, counts: { direct: 2, action: 0 },
        sessionSamples: [{ sessionId: 'ts-session' }] },
      { language: 'Python', sessions: 1, inquirySessions: 0, counts: { direct: 0, action: 1 },
        sessionSamples: [{ sessionId: 'py-session' }] },
    ]);
    expect(data.coverage.withoutLanguage).toBe(1);
    expect(analyzer.getCuriosity({ language: 'TypeScript' }).coverage.human).toBe(2);
    expect(analyzer.getCuriosity({ language: 'Python' }).coverage.human).toBe(1);
    expect(analyzer.getCuriosity({ language: 'unrecorded' }).coverage.human).toBe(1);
  });

  it('deduplicates relative, absolute and file-URI paths to the same file in another project', () => {
    const source = session('s', [request(undefined, {
      referencedFiles: ['../external/tool.py', '/external/tool.py', 'file:///external/tool.py'],
      editedFiles: ['/external/tool.py'],
    })]);
    source.workspaceRootPath = '/repo';
    expect(new CuriosityAnalyzer([source], new Map()).getCuriosity().languages)
      .toMatchObject([{ language: 'Python', files: 1, sessions: 1 }]);
  });

  it('keeps dynamic-route filenames and deduplicates relative, absolute and file-URI evidence', () => {
    const source = session('s', [request(undefined, {
      referencedFiles: ['src/[id].tsx', '/repo/src/[id].tsx', 'file:///repo/src/%5Bid%5D.tsx'],
    })]);
    source.workspaceRootPath = '/repo';
    expect(new CuriosityAnalyzer([source], new Map()).getCuriosity().languages)
      .toMatchObject([{ language: 'TypeScript', files: 1 }]);
  });

  it('retains recorded language context even without classified activity', () => {
    const source = session('s', [request(undefined, { answerEvidence: 'missing', referencedFiles: ['src/a.py'] })]);
    const data = new CuriosityAnalyzer([source], new Map()).getCuriosity({ language: 'Python' });
    expect(data.coverage).toMatchObject({ human: 1, classified: 0, unclassified: 1 });
    expect(data.languages).toMatchObject([{ language: 'Python', sessions: 1, files: 1,
      counts: { direct: 0, web: 0, repository: 0, action: 0 } }]);
  });

  it('applies language, workspace, harness and request-date filters to turns and follow-ups', () => {
    const ts = session('a', [request(undefined, { timestamp: TIME - 86_400_000, referencedFiles: ['x.ts'] }),
      request(undefined, { timestamp: TIME })]);
    const py = session('b', [request(undefined, { referencedFiles: ['x.py'] }), request()], 'other', 'Claude');
    const analyzer = new CuriosityAnalyzer([ts, py], new Map());
    expect(analyzer.getCuriosity({ language: 'Python' }).counts.direct).toBe(2);
    expect(analyzer.getCuriosity({ workspaceId: 'project', harness: 'GitHub Copilot App', fromDate: '2026-09-30' }).chains.total).toBe(0);
    expect(analyzer.getCuriosity({ fromDate: '2026-09-30', language: 'TypeScript' }).coverage.human).toBe(0);
    expect(analyzer.getCuriosity({ fromDate: '2026-09-30', language: 'unrecorded', workspaceId: 'project' }).counts.direct).toBe(1);
  });

  it('retains zero-data days and keeps zero inquiries distinct from no classified activity', () => {
    const data = analyze([
      request('Run it.', { timestamp: TIME - 172_800_000, toolsUsed: ['bash'] }),
      request(undefined, { timestamp: TIME, curiosity: { kind: 'unscanned', excerpts: [] } }),
    ]);
    expect(data.counts).toEqual({ direct: 0, web: 0, repository: 0, action: 1 });
    expect(data.daily).toHaveLength(3);
    expect(activityCount(data.daily[1].counts)).toBe(0);
    expect(analyze([]).coverage.classified).toBe(0);
  });

  it('bounds evidence independently of exact activity and follow-up totals', () => {
    const data = analyze(Array.from({ length: 100 }, () => request()));
    expect(data.coverage.classified).toBe(100);
    expect(data.chains).toMatchObject({ total: 1, sustained: 1, exchanges: 100 });
    expect(data.evidence.direct).toHaveLength(20);
    expect(data.chains.examples[0].session).toMatchObject({ sessionId: 's', timestamp: TIME });
    expect(data.chains.examples[0]).not.toHaveProperty('questions');
    expect(data.chains.examples[0].exchanges).toBe(100);
  });

  it('deduplicates escaped event IDs and copied prefixes without dropping forked follow-ups', () => {
    const turns = ['id"],\\"', 'id,[]', 'id-prefix', 'id-prefix-extra'].map(userEventId => request(undefined, { userEventId }));
    const sources = [
      session('original', turns.slice(0, 2)),
      session('fork-a', turns.slice(0, 3)),
      session('fork-b', [turns[0], turns[1], turns[3]]),
      session('fork-a-copy', turns.slice(0, 3), 'project', 'GitHub Copilot CLI'),
    ].map(source => ({ ...source, requests: source.requests.map(turn => ({ ...turn })) }));
    const data = new CuriosityAnalyzer(sources, new Map()).getCuriosity();
    expect(data.coverage).toMatchObject({ human: 4, duplicates: 7 });
    expect(data.chains).toMatchObject({ total: 2, sustained: 2, exchanges: 4 });
    expect(data.chains.examples.map(row => row.session.sessionId).sort()).toEqual(['fork-a-copy', 'fork-b']);
  });

  it('handles long copied follow-up sequences without recursive traversal', () => {
    const turns = Array.from({ length: 10_000 }, (_, index) => request(undefined, {
      userEventId: `long-${index}`, timestamp: TIME + index * 1000, totalElapsed: 500,
    }));
    const data = new CuriosityAnalyzer([
      session('original', turns), session('copy', turns.slice(0, 5_000).map(turn => ({ ...turn })), 'project', 'GitHub Copilot CLI'),
    ], new Map()).getCuriosity();
    expect(data.chains).toMatchObject({ total: 1, sustained: 1, exchanges: 10_000 });
    expect(data.chains.examples[0]).toMatchObject({ exchanges: 10_000, elapsedMs: 9_999_500 });
  });
});
