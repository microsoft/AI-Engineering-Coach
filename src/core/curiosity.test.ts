/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nlp from 'compromise';
import { detectCuriosity } from './curiosity';
import { createRequest, createSession, setCuriosityDetector, stripSingleSession } from './parser-shared';
import { SessionSchema } from './schemas';

vi.mock('compromise', async importOriginal => {
  const original = await importOriginal<typeof import('compromise')>();
  return {
    ...original,
    default: Object.assign(vi.fn(original.default), original.default, { _world: original.default.world() }),
  };
});

function analyzed(text: string) {
  const signal = detectCuriosity(text);
  if (signal.kind !== 'analyzed') throw new Error(`Expected analyzed input, got ${signal.kind}`);
  return signal;
}

describe('native Compromise questions', () => {
  it.each([
    'Why does this fail?', 'Why does this fail', 'How would you fix this?',
    'Explain this', 'Explain why it failed.', 'Can you explain this?',
    'Can you fix this?', 'Could you please run the tests?', 'Is this safe to merge?',
    'How are you today?', 'Do not change the cache.', 'The cache did not fail.',
    'The build failed yesterday.', 'Not bad.', 'Yes please', '/code-review',
    'Could you excise the redundant declaration?', 'pls explain this',
  ])('uses the library result without intent overrides: %s', text => {
    const doc = nlp(text);
    const features = analyzed(text).features;
    expect(features.question.count).toBe(Number(doc.sentences().isQuestion().found));
    expect(Object.keys(features)).toEqual(['question']);
  });

  it('does not equate question form with learning or treat directives as questions', () => {
    expect(analyzed('Can you fix this?').features.question.count).toBe(1);
    expect(analyzed('Explain the parser.').features.question.count).toBe(0);
    expect(analyzed('Fix the parser.').features.question.count).toBe(0);
  });

  it('counts question sentences and retains only their evidence', () => {
    const { features } = analyzed('Do not change the cache. Why does it fail? Is it broken?');
    expect(features.question).toEqual({ count: 2, excerpts: ['Why does it fail?', 'Is it broken?'] });
    expect(Object.keys(features)).toEqual(['question']);
  });

  it('does not infer that an unmarked article is context from its opening words', () => {
    expect(analyzed('Rewrite this article\n\nWhy does the parser fail?').features.question.count).toBe(1);
  });

  it.each([
    '<relayed_message>Why?</relayed_message>',
    '<system_reminder>Run tests</system_reminder>',
    '<panel-context>Why?</panel-context>',
    '```ts\nWhy does this fail?\n```',
    '~~~~\nWhy?\n~~~\nWhat?\n~~~~',
    '```ts\nWhy?',
    '> Why does this fail?',
    '"Why?" `how?` https://example.com/?what', '',
  ])('excludes structured context: %s', text => {
    expect(detectCuriosity(text)).toEqual({ kind: 'excluded', excerpts: [] });
  });

  it('keeps questions after code and harness context', () => {
    expect(analyzed('<system_reminder>Fix this</system_reminder>\n```\nWhat?\n```\nWhy does it fail?').features.question)
      .toEqual({ count: 1, excerpts: ['Why does it fail?'] });
    expect(analyzed('<file-ref path="a.ts">Why?</file-ref> <file-ref path="b.ts"> Why does it fail?').features.question)
      .toEqual({ count: 1, excerpts: ['Why does it fail?'] });
  });

  it('counts only the latest user turn of a replayed transcript', () => {
    const history = 'Recent conversation:\nAssistant: What do you want to do?\nUser: Why does the cache fail?\n';
    expect(analyzed(history).features.question.excerpts).toEqual(['Why does the cache fail?']);
    const current = analyzed(`${history}Assistant: I can fix it.\nUser: Fix the parser.\nAssistant: Done. Anything else?`);
    expect(current.features.question.count).toBe(0);
    expect(analyzed('Human: Fix it.\nAI: Fixed. Why?\nHuman: Why did it fail?').features.question.count).toBe(1);
  });

  it.each(['x'.repeat(256_001), 'x'.repeat(32_001), 'Background.\n'.repeat(257)])('reports input limits', text => {
    expect(detectCuriosity(text)).toEqual({ kind: 'unscanned', excerpts: [] });
  });

  it('bounds evidence without capping feature counts', () => {
    const signal = analyzed(`Why ${'the reason '.repeat(50)}? Why? What is a worker? How does it start?`);
    expect(signal.features.question.count).toBe(4);
    expect(signal.features.question.excerpts).toHaveLength(3);
    expect(signal.features.question.excerpts[0]).toHaveLength(240);
    expect(signal.repeatedQuestions).toEqual([]);
  });

  it('uses native text normalization for complete short questions, not semantic similarity', () => {
    expect(analyzed('Why does the parser fail?').repeatedQuestions).toEqual(['why does the parser fail']);
    expect(analyzed('why does the parser fail').repeatedQuestions).toEqual(['why does the parser fail']);
    expect(analyzed('Why does /a fail here?').repeatedQuestions).not.toEqual(analyzed('Why does /b fail here?').repeatedQuestions);
    expect(analyzed('Why does v1 fail here?').repeatedQuestions).not.toEqual(analyzed('Why does v2 fail here?').repeatedQuestions);
    expect(analyzed('Why?').repeatedQuestions).toEqual([]);
  });

  it('keeps inline identifiers in question evidence and exact repetition keys', () => {
    const map = analyzed('How does `Map` store values in JavaScript?');
    const set = analyzed('How does `Set` store values in JavaScript?');
    expect(map.features.question).toEqual({ count: 1, excerpts: ['How does Map store values in JavaScript?'] });
    expect(map.repeatedQuestions).toEqual(['how does map store values in javascript']);
    expect(set.repeatedQuestions).toEqual(['how does set store values in javascript']);
    expect(analyzed('how does Map store values in JavaScript').repeatedQuestions).toEqual(map.repeatedQuestions);
    expect(analyzed('Why does `cache.get` return nothing?').repeatedQuestions)
      .not.toEqual(analyzed('Why does `cache.set` return nothing?').repeatedQuestions);
    expect(detectCuriosity('`Map`')).toEqual({ kind: 'excluded', excerpts: [] });
    expect(analyzed('Recorded code: `Why does Map store values?`').features.question.count).toBe(0);
  });
});

describe('curiosity persistence', () => {
  beforeEach(() => setCuriosityDetector(detectCuriosity));
  afterEach(() => setCuriosityDetector(undefined));

  it('does not load NLP or classify text in host-side detail reads', () => {
    setCuriosityDetector(undefined);
    expect(createRequest({ messageText: 'Why?', responseText: '' }).curiosity).toBeUndefined();
  });

  it('analyzes raw text before storage and memory truncation', () => {
    const context = 'The application stores its data in a local database shared by its background workers. ';
    const raw = context.repeat(160) + '\nWhy does the cache fail?\n' + context.repeat(60) + '\nHow do I fix it?';
    const request = createRequest({ messageText: raw, responseText: '' });
    const session = createSession({ sessionId: 's', workspaceId: 'w', workspaceName: 'w', harness: 'test', requests: [request] });
    expect(request.messageText).not.toContain('Why does the cache fail?');
    stripSingleSession(session);
    const cached = SessionSchema.parse(JSON.parse(JSON.stringify(session)));
    expect(cached.requests[0].messageText.length).toBeLessThanOrEqual(500);
    expect(cached.requests[0].curiosity).toMatchObject({
      kind: 'analyzed', features: { question: { count: 2, excerpts: ['Why does the cache fail?', 'How do I fix it?'] } },
    });
  });

  describe('bounded sentence caching', () => {
    async function coldDetector() {
      vi.resetModules();
      vi.mocked(nlp).mockClear();
      return (await import('./curiosity')).detectCuriosity;
    }

    it('reuses exact sentence analysis without combining recorded questions', async () => {
      const detect = await coldDetector();
      const text = 'Why does the bounded cache expire?';
      const first = detect(text);
      expect(vi.mocked(nlp)).toHaveBeenCalledTimes(1);
      expect(detect(`${text} ${text}`)).toMatchObject({
        features: { question: { count: 2, excerpts: [text, text] } },
      });
      expect(vi.mocked(nlp)).toHaveBeenCalledTimes(1);
      expect(detect(text)).toEqual(first);
      expect(vi.mocked(nlp)).toHaveBeenCalledTimes(1);
    });

    it('keeps repetition eligibility specific to each complete message', async () => {
      const detect = await coldDetector();
      const text = 'Why does the bounded cache expire?';
      expect(detect('Recorded background. '.repeat(30) + text)).toMatchObject({ repeatedQuestions: [] });
      vi.mocked(nlp).mockClear();
      expect(detect(text)).toMatchObject({ repeatedQuestions: ['why does the bounded cache expire'] });
      expect(vi.mocked(nlp)).not.toHaveBeenCalled();
    });

    it('does not share mutable signal arrays between calls', async () => {
      const detect = await coldDetector();
      const text = 'Why does the bounded cache expire?';
      const first = detect(text);
      if (first.kind !== 'analyzed') throw new Error('Expected analyzed signal');
      first.features.question.excerpts.length = 0;
      first.repeatedQuestions.length = 0;
      expect(detect(text)).toMatchObject({
        features: { question: { count: 1, excerpts: [text] } },
        repeatedQuestions: ['why does the bounded cache expire'],
      });
    });

    it('evicts old entries when the sentence-count limit is reached', async () => {
      const detect = await coldDetector();
      const text = 'Why does the oldest cache entry expire?';
      const expected = detect(text);
      for (let index = 0; index < 4096; index++) detect(`This is cached statement ${index}.`);
      vi.mocked(nlp).mockClear();
      expect(detect(text)).toEqual(expected);
      expect(vi.mocked(nlp)).toHaveBeenCalledTimes(1);
    });

    it('bounds cached text independently of the number of sentences', async () => {
      const detect = await coldDetector();
      const text = 'Why does the oldest cache entry expire?';
      const expected = detect(text);
      for (let index = 0; index < 32; index++) detect('x'.repeat(31_950) + index);
      vi.mocked(nlp).mockClear();
      expect(detect(text)).toEqual(expected);
      expect(vi.mocked(nlp)).toHaveBeenCalledTimes(1);
    });
  });

  it('preserves metadata-supplied non-user exclusions', () => {
    expect(createRequest({
      messageText: 'Why?', responseText: '', curiosity: { kind: 'excluded', excerpts: [] },
    }).curiosity?.kind).toBe('excluded');
  });

  it('rejects stale intent data and incomplete or oversized feature data', () => {
    const base = createSession({ sessionId: 's', workspaceId: 'w', workspaceName: 'w', harness: 'test', requests: [] });
    const raw = createRequest({ messageText: 'Why?', responseText: '' });
    for (const curiosity of [
      { kind: 'learn', excerpts: ['Why?'] },
      { kind: 'analyzed', features: {}, repeatedQuestions: [] },
      { ...analyzed('Why?'), features: { ...analyzed('Why?').features, negative: { count: 0, excerpts: [] } } },
      { ...analyzed('Why?'), repeatedQuestions: ['x'.repeat(240)] },
    ]) {
      expect(SessionSchema.safeParse({ ...base, requests: [{ ...raw, curiosity }] }).success).toBe(false);
    }
  });
});
