/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { resolveParentLinks, type LinkableSession } from './timeline-links';

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

  it('does not take a session that open_pr_session reopened for one it created', () => {
    const minute = 60_000;
    const links = resolveParentLinks([
      s('old', 0),
      s('coord', 10 * minute, { childSessionIds: ['old', 'new'], childSessionCreatedAt: { old: 20 * minute, new: 30 * minute } }),
      s('new', 30 * minute + 5_000),
    ]);
    expect(Object.fromEntries(links)).toEqual({ new: { parent: 'coord', via: 'create' } });
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
