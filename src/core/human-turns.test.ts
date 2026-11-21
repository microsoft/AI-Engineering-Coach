/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, it, expect, expectTypeOf, vi } from 'vitest';
import { humanFollowUpGaps, isHumanTurn, markNonHuman, NON_HUMAN_KINDS, splitHumanTurns } from './human-turns';
import { detectCuriosity } from './curiosity';
import { createRequest, setCuriosityDetector } from './parser-shared';
import type { NonHumanKind } from './types';

describe('NON_HUMAN_KINDS', () => {
  it('lists every NonHumanKind once', () => {
    expectTypeOf<(typeof NON_HUMAN_KINDS)[number]>().toEqualTypeOf<NonHumanKind>();
    expect(new Set(NON_HUMAN_KINDS).size).toBe(NON_HUMAN_KINDS.length);
  });
});

describe('isHumanTurn', () => {
  it('treats a turn without a marker as typed', () => {
    expect(isHumanTurn({})).toBe(true);
    expect(isHumanTurn({ nonHumanKind: undefined })).toBe(true);
    expect(isHumanTurn({ nonHumanKind: null })).toBe(true);
    expect(isHumanTurn({ nonHumanKind: 'agent' })).toBe(false);
  });

  it('ignores Curiosity: a typed turn the detector leaves out stays typed', () => {
    const codeOnly = createRequest({ messageText: '```ts\nconst x = 1;\n```', responseText: '', curiosity: { kind: 'excluded', excerpts: [] } });
    expect(isHumanTurn(codeOnly)).toBe(true);
  });
});

describe('markNonHuman', () => {
  it('records the kind and leaves the turn out of Curiosity', () => {
    const request = createRequest({
      messageText: 'Why does it fail?', responseText: '',
      curiosity: { kind: 'analyzed', features: { question: { count: 1, excerpts: [] } }, repeatedQuestions: [] },
    });
    markNonHuman(request, 'subagent');
    expect(request.nonHumanKind).toBe('subagent');
    expect(request.curiosity).toEqual({ kind: 'excluded', excerpts: [] });
  });
});

describe('createRequest', () => {
  afterEach(() => setCuriosityDetector(undefined));

  it('leaves a marked turn out of Curiosity without running the detector', () => {
    const detector = vi.fn(detectCuriosity);
    setCuriosityDetector(detector);
    expect(createRequest({ messageText: 'Why does it fail?', responseText: '', nonHumanKind: 'system' }).curiosity)
      .toEqual({ kind: 'excluded', excerpts: [] });
    expect(detector).not.toHaveBeenCalled();
    expect(createRequest({ messageText: 'Why does it fail?', responseText: '' }).curiosity?.kind).toBe('analyzed');
    expect(detector).toHaveBeenCalledTimes(1);
  });
});

describe('splitHumanTurns', () => {
  it('keeps typed turns in order and counts the rest by kind', () => {
    const turns = [
      { id: 1 }, { id: 2, nonHumanKind: 'agent' as const }, { id: 3, nonHumanKind: 'autopilot' as const },
      { id: 4 }, { id: 5, nonHumanKind: 'agent' as const },
    ];
    const { human, basis } = splitHumanTurns(turns);
    expect(human.map(turn => turn.id)).toEqual([1, 4]);
    expect(basis).toEqual({ humanTurns: 2, automatedTurns: 3, automatedByKind: { agent: 2, autopilot: 1 } });
  });

  it('reports an empty basis for no turns', () => {
    expect(splitHumanTurns([])).toEqual({ human: [], basis: { humanTurns: 0, automatedTurns: 0, automatedByKind: {} } });
  });
});

describe('humanFollowUpGaps', () => {
  interface Turn { start: number; end: number; human: boolean }
  const typed = (start: number, end: number): Turn => ({ start, end, human: true });
  const automated = (start: number, end: number): Turn => ({ start, end, human: false });
  const gaps = (turns: Turn[]) => humanFollowUpGaps(turns, turn => turn.start, turn => turn.end, turn => turn.human);

  it('is the gap between consecutive turns when every turn is typed', () => {
    expect(gaps([typed(0, 10), typed(15, 30), typed(40, 45)])).toEqual([5, 10]);
  });

  it('measures from the end of automated work to the next typed turn', () => {
    expect(gaps([typed(0, 10), automated(12, 40), automated(41, 60), typed(70, 80)])).toEqual([10]);
  });

  it('keeps the latest end when an automated turn ends before the typed one', () => {
    expect(gaps([typed(0, 50), automated(10, 20), typed(60, 70)])).toEqual([10]);
  });

  it('gives a typed turn after automated work a gap, but not the first turn', () => {
    expect(gaps([automated(0, 20), typed(30, 35)])).toEqual([10]);
    expect(gaps([typed(0, 10)])).toEqual([]);
  });

  it('never starts a gap at an automated turn', () => {
    expect(gaps([typed(0, 10), automated(100, 110), automated(500, 510)])).toEqual([]);
  });

  it('keeps automated work that runs across typed turns, such as a sub-agent', () => {
    expect(gaps([typed(0, 10), automated(5, 600), typed(20, 30), typed(610, 620)])).toEqual([0, 10]);
  });

  it('gives a turn typed while automated work still runs a gap of 0', () => {
    expect(gaps([typed(0, 10), automated(12, 100), typed(50, 60)])).toEqual([0]);
    expect(gaps([automated(0, 100), typed(50, 60)])).toEqual([0]);
  });

  it('returns a negative gap when a typed turn starts before the work ends', () => {
    expect(gaps([typed(0, 100), typed(50, 60)])).toEqual([-50]);
  });
});
