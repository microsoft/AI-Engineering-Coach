/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The text behind one session's Timeline lane: the message that started each turn, the end of the agent's reply, and what
 * each question, relayed question and permission prompt asked and what you answered. Built from a session re-read in
 * full when its lane is opened (the analyzers hold no such text), scrubbed, and sent only to the local Timeline panel:
 * never to the chat tool, the summary export or anywhere else. */

import type { Session, SessionRequest, TimelineSessionText, TimelineTextScope, TimelineTextTurn, TimelineTextWait, UserWait, UserWaitText } from './types';
import { turnSender } from './analyzer-timeline';
import { turnIdentity } from './fork-ownership';
import { scrubText, type ScrubContext } from './session-labels';
import { textTurnFinder, waitInWindow } from './timeline-model';

/** Longest prompt, question or answer shown; the rest is cut. */
export const MAX_TEXT = 4000;
/** How much of the end of the agent's reply is shown. */
const MAX_REPLY = 1500;

function cutHead(value: string, max: number): [string, boolean] {
  return value.length > max ? [value.slice(0, max).trimEnd() + ' …', true] : [value, false];
}

/** The end of a reply, from a paragraph start when there is one near the cut. */
function cutTail(value: string, max: number): [string, boolean] {
  if (value.length <= max) return [value, false];
  const tail = value.slice(-max);
  const para = tail.indexOf('\n\n');
  return ['… ' + (para >= 0 && para < max / 3 ? tail.slice(para + 2) : tail).trimStart(), true];
}

function waitText(w: UserWait, labels: ScrubContext): TimelineTextWait {
  const out: TimelineTextWait = {
    s: w.start, e: w.end, k: w.kind, a: w.answered, ...(w.answered && w.answeredAt !== undefined && w.answeredAt !== w.end ? { at: w.answeredAt } : {}),
  };
  const text: UserWaitText = w.text ?? {};
  let cut = false;
  for (const key of ['ask', 'answer', 'intention'] as const) {
    const value = text[key]?.trim();
    if (!value) continue;
    const [v, c] = cutHead(scrubText(value, labels), MAX_TEXT);
    out[key] = v;
    cut ||= c;
  }
  if (text.before?.trim()) {
    const [v, c] = cutTail(scrubText(text.before.trim(), labels), MAX_REPLY);
    out.before = v;
    cut ||= c;
  }
  if (text.tool) out.tool = cutHead(scrubText(text.tool, labels), 40)[0];
  if (text.choices?.length) out.choices = text.choices.slice(0, 20).map(c => cutHead(scrubText(c, labels), 300)[0]);
  if (cut) out.cut = true;
  return out;
}

/** The text of `session`'s turns and stops, scrubbed with `labels`. `session` is the full session, re-read from its
 *  log. With `scope`, only what that lane shows is built: the turns it lists (matched by identity, else by a time no
 *  other turn has) and the stops that belong to its window; nothing else is scrubbed or returned. With `kept`, only
 *  the turns the analysis kept are read (a fork's copied turns, and their stops, count in their source). Compaction
 *  and system turns carry no prompt text (a summary or a harness message, not an instruction). */
export function timelineSessionText(session: Session, labels: ScrubContext, scope?: TimelineTextScope, kept?: ReadonlySet<string>): TimelineSessionText {
  const requests = kept ? session.requests.filter(r => kept.has(turnIdentity(r))) : session.requests;
  const timed = requests.filter((r): r is SessionRequest & { timestamp: number } => !!r.timestamp)
    .map(r => ({ r, t: r.timestamp, ...(turnIdentity(r) ? { id: turnIdentity(r) } : {}) }));
  let shown = timed;
  if (scope) {
    const find = textTurnFinder(timed);
    const wanted = new Set(scope.turns.map(find));
    shown = timed.filter(x => wanted.has(x));
  }
  const allWaits = [...requests.flatMap(r => r.userWaits ?? []), ...session.userWaits ?? []];
  const waits = scope
    ? allWaits.filter(w => waitInWindow({ s: w.start, e: w.end, k: w.kind, a: w.answered, ...(w.answeredAt != null ? { at: w.answeredAt } : {}) }, scope.from, scope.to))
    : allWaits;
  return {
    sessionId: session.sessionId,
    turns: shown.map(x => textTurn(x.r, x.t, labels)).sort((a, b) => a.t - b.t),
    waits: waits.map(w => waitText(w, labels)).sort((a, b) => a.s - b.s),
  };
}

function textTurn(r: SessionRequest, t: number, labels: ScrubContext): TimelineTextTurn {
  const k = turnSender(r.nonHumanKind);
  const turn: TimelineTextTurn = { t, k, ...(turnIdentity(r) ? { id: turnIdentity(r) } : {}) };
  let cut = false;
  if (k !== 'compaction' && k !== 'other' && r.messageText.trim()) {
    const [v, c] = cutHead(scrubText(r.messageText.trim(), labels), MAX_TEXT);
    turn.prompt = v;
    cut ||= c;
  }
  // The agent's own messages: the code it wrote to files is no reply. A compaction's reply is its summary.
  const reply = k === 'compaction' ? '' : (r.replyText ?? r.responseText).trim();
  if (reply) {
    const [v, c] = cutTail(scrubText(reply, labels), MAX_REPLY);
    turn.reply = v;
    cut ||= c;
  }
  if (cut) turn.cut = true;
  return turn;
}
