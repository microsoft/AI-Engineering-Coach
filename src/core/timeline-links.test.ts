/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { resolveForkLinks, resolveParentLinks, type ForkableSession, type LinkableSession } from './timeline-links';

const s = (sessionId: string, creationDate: number, extra: Partial<LinkableSession> = {}): LinkableSession =>
  ({ sessionId, creationDate, ...extra });

describe('resolveParentLinks', () => {
  it('links the sessions a session started, then sessions whose first message was relayed', () => {
    const links = resolveParentLinks([
      s('coord', 1, { childSessionIds: ['CHILD', 'unknown-session'] }),
      s('child', 2, { relaySenderId: 'other' }),
      s('relayed', 3, { relaySenderId: 'child' }),
      s('other', 4),
    ]);
    expect(Object.fromEntries(links)).toEqual({
      child: { parent: 'coord', via: 'create' },
      relayed: { parent: 'child', via: 'relay' },
    });
  });

  it('takes the parent a harness logged before a relay, and the earliest creator when two report the same child', () => {
    const links = resolveParentLinks([
      s('late', 5, { childSessionIds: ['kid'] }),
      s('early', 1, { childSessionIds: ['kid'] }),
      s('kid', 6),
      s('thread', 7, { parentSessionId: 'late', relaySenderId: 'early' }),
    ]);
    expect(links.get('kid')).toEqual({ parent: 'early', via: 'create' });
    expect(links.get('thread')).toEqual({ parent: 'late', via: 'harness' });
  });

  it('drops the relay links of a cycle, so a coordinator receiving reports never becomes its child’s child', () => {
    const links = resolveParentLinks([
      s('coord', 1, { childSessionIds: ['kid'], relaySenderId: 'kid' }),
      s('kid', 2),
    ]);
    expect(Object.fromEntries(links)).toEqual({ kid: { parent: 'coord', via: 'create' } });
    const loop = resolveParentLinks([s('a', 1, { childSessionIds: ['b'] }), s('b', 2, { childSessionIds: ['a'] })]);
    expect([...loop.keys()]).toEqual(['b']);
  });
});

describe('resolveForkLinks', () => {
  const fork = (sessionId: string, ids: string[], extra: Partial<ForkableSession> = {}): ForkableSession =>
    ({ sessionId, requests: ids.map(userEventId => ({ userEventId })), ...extra });

  it('links a Codex fork by its logged source, and a Claude Code fork by the prompts it copied', () => {
    const links = resolveForkLinks([
      fork('src', ['m1', 'm2', 'm3']),
      fork('claude-fork', ['m1', 'm2', 'm4'], { copiesHistory: true }),
      fork('fork-of-fork', ['m1', 'm2', 'm4', 'm5'], { copiesHistory: true }),
      fork('codex-fork', ['c9'], { forkedFromId: 'SRC' }),
      // Shares a prompt ID but copied nothing: not a fork.
      fork('lookalike', ['m1']),
    ]);
    expect(Object.fromEntries([...links].map(([id, l]) => [id, [l.source, [...l.copied]]]))).toEqual({
      'claude-fork': ['src', ['m1', 'm2']],
      // A fork of a fork goes to the session the copied history started in.
      'fork-of-fork': ['src', ['m1', 'm2']],
      'codex-fork': ['src', []],
    });
  });

  it('links nothing for a session that copies history from no known session', () => {
    expect(resolveForkLinks([fork('a', ['x'], { copiesHistory: true }), fork('b', ['y'], { forkedFromId: 'gone' })]).size).toBe(0);
  });
});