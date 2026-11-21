/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The text behind one session's Timeline lane: the message that started each turn, the end of the agent's reply, and what
 * each question, relayed question and permission prompt asked and what you answered. Built from a session re-read in
 * full when its lane is opened (the analyzers hold no such text), scrubbed, and sent only to the local Timeline panel:
 * never to the chat tool, the summary export or anywhere else. */

import type { Session, TimelineSessionText, TimelineTextTurn, TimelineTextWait, UserWait, UserWaitText } from './types';
import { turnSender } from './analyzer-timeline';
import { scrubText, type ScrubContext } from './session-labels';

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
  if (text.tool) out.tool = text.tool;
  if (text.choices?.length) out.choices = text.choices.slice(0, 20).map(c => cutHead(scrubText(c, labels), 300)[0]);
  if (cut) out.cut = true;
  return out;
}

/** The text of `session`'s turns and stops, scrubbed with `labels`. `session` is the full session, re-read from its
 *  log with the turns the analysis kept. Compaction and system turns carry no prompt text (a summary or a harness
 *  message, not an instruction). */
export function timelineSessionText(session: Session, labels: ScrubContext): TimelineSessionText {
  const turns: TimelineTextTurn[] = [];
  const waits: TimelineTextWait[] = [];
  for (const r of session.requests) {
    for (const w of r.userWaits ?? []) waits.push(waitText(w, labels));
    if (!r.timestamp) continue;
    const k = turnSender(r.nonHumanKind);
    const turn: TimelineTextTurn = { t: r.timestamp, k };
    let cut = false;
    if (k !== 'compaction' && k !== 'other' && r.messageText.trim()) {
      const [v, c] = cutHead(scrubText(r.messageText.trim(), labels), MAX_TEXT);
      turn.prompt = v;
      cut ||= c;
    }
    if (r.responseText.trim()) {
      const [v, c] = cutTail(scrubText(r.responseText.trim(), labels), MAX_REPLY);
      turn.reply = v;
      cut ||= c;
    }
    if (cut) turn.cut = true;
    turns.push(turn);
  }
  for (const w of session.userWaits ?? []) waits.push(waitText(w, labels));
  return { sessionId: session.sessionId, turns: turns.sort((a, b) => a.t - b.t), waits: waits.sort((a, b) => a.s - b.s) };
}
