/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, it, expect, expectTypeOf, vi } from 'vitest';
import { isHumanTurn, markNonHuman, NON_HUMAN_KINDS } from './human-turns';
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
