/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline dataset: every session in range with its turns, as counts and timings only (no prompt or response text).
 * The analyzer builds it; `timeline-model.ts` derives the Day, Week and Families views from it. */

/** Who sent a turn: no harness marker says it was automated, so it came from you (`you`: typed or scripted by you),
 *  another agent or session sent it (`agent`), autopilot continued (`autopilot`), a compaction request
 *  (`compaction`), or the harness (`other`). */
export type TurnSender = 'you' | 'agent' | 'autopilot' | 'compaction' | 'other';

export interface TimelineTurn {
  /** When the turn's prompt was logged (epoch ms). */
  t: number;
  /** The turn's span: its `totalElapsed`, from its prompt to its last logged agent activity (ms); 0 when not logged.
   *  Agent time is this span minus `w`, the time the turn was stopped on a question or a permission prompt. */
  d: number;
  k: TurnSender;
  /** Sub-agent launches the turn recorded (Copilot sub-agent runs, Claude Code `Agent`/`Task` and Codex
   *  `spawn_agent` calls). */
  sub: number;
  /** The context was compacted during the turn. */
  comp: boolean;
  /** AI credits logged for the turn (Copilot CLI and Copilot App); 0 elsewhere. */
  cr: number;
  /** Tokens logged for the turn: Copilot usage records, else the turn's prompt and completion tokens. */
  tok: number;
  /** The request's ID, to join the text read on demand to the turn (two turns can share a time). No text itself. */
  id?: string;
  /** The harness logged no duration for the turn, so when its work ended is unknown (`d` is 0). */
  noDuration?: boolean;
  /** When the turn was stopped on a question or a permission prompt (absolute ms, in order; they can overlap, and one
   *  can outlast the turn's last message). `a`: you answered it: at `at` when the harness recorded your answer,
   *  otherwise at `e` (which can equal `s`). */
  w?: TimelineTurnWait[];
}

export interface TimelineTurnWait {
  s: number;
  e: number;
  /** `relay`: a child session's question the coordinator relayed to you; the child logs the same answer. */
  k: 'question' | 'relay' | 'permission';
  a: boolean;
  /** When the harness recorded your answer, when that differs from `e`. It can precede `s`. */
  at?: number;
  /** The request it answered (see `UserWait.requestId`): pairs a relay with the child's own answer. */
  rid?: string;
  /** Relays only: paired over the whole log with a child's own record of the same answer (counted there, so this is no
   *  answer, input or activity of the relaying session). Absent when the pairing is left to the model. */
  pr?: boolean;
}

/** How a child session's parent was found: a `create_session`-style tool result (`create`), the relayed first message
 *  (`relay`), or the harness's own parent field (`harness`: Codex, OpenCode). */
export type TimelineLinkKind = 'create' | 'relay' | 'harness';

export interface TimelineSessionRecord {
  id: string;
  /** Display name as logged, scrubbed; empty when the harness logged none. */
  name: string;
  /** Branch, scrubbed, without the user's handle; empty when not logged. */
  branch: string;
  /** Repository or folder name, never a path. */
  repo: string;
  /** Short harness label (`Copilot App`, `Claude Code`). */
  harness: string;
  /** The model most of the session's turns in range used; empty when none was logged. */
  model: string;
  /** Index of the parent session in `TimelineDataset.sessions`; -1 when no parent is linked. A parent with no activity
   *  in range, or hidden by the sidebar filters, is still in the dataset, as a context record. */
  parent: number;
  via: TimelineLinkKind | null;
  /** When its parent requested it: the earlier of the parent's two records of its `create_session` call (epoch ms).
   *  Not when the child began, which its own log records later. Absent when no such call logged it. */
  created?: number;
  /** The session is a fork (Codex, Claude Code): the index of its source in the dataset, or -1 when the source has no
   *  activity in range. `forkSource`: whether the source is in these logs (`ambiguous`: several loaded sessions hold
   *  its copied history equally, so which one it came from can't be told). Not a family link. */
  fork?: number;
  forkSource?: 'loaded' | 'missing' | 'ambiguous';
  /** Turns the fork copied from its source. They count once, in the source, so they aren't in `turns`. */
  inheritedTurns?: number;
  /** Turns in range, in time order. */
  turns: TimelineTurn[];
  /** Turns just outside the range that its totals need: those before it back to the last prompt or answer from you,
   *  any still running into it, and the first turn after it (which ends a wait that started inside). Only their work
   *  and waits inside the range count; they are never counted as turns. */
  context?: TimelineTurn[];
  /** Stops for you that no turn owns: the session logged only your answer to a permission prompt or a question. */
  stops?: TimelineTurnWait[];
  /** A context record: a member of a shown family with no activity in range, or hidden by the sidebar's workspace or
   *  harness filter. Its turns are all `context`; it gives the family its structure, inputs and work, never a lane. */
  ctx?: boolean;
}

export interface TimelineDataset {
  sessions: TimelineSessionRecord[];
  /** Sessions in range whose harness counted a fork without logging its source (Copilot `fork_count`). */
  forkedSessions: number;
  /** The range (epoch ms, local midnights): its start, and the end of its last day. Absent for an open bound. Work and
   *  waits outside it never count. */
  from?: number;
  to?: number;
}

/** What one lane's detail panel shows, so the text read returns that and no more: its window [`from`, `to`) and the
 *  turns it lists (by identity, else time), with the turn before each wait for your next prompt. */
export interface TimelineTextScope {
  from: number;
  to: number;
  turns: { t: number; id?: string }[];
}

/** The text behind one session's turns and stops, for the Timeline detail panel: loaded when a lane is opened, never
 *  part of the dataset, the chat tool or the export. Scrubbed of links, email addresses, the home directory, the user's
 *  names and credentials; long text is cut, with `cut` set. Read for one lane's scope: nothing it doesn't show. */
export interface TimelineSessionText {
  sessionId: string;
  /** Turns by start time (`t`, as in `TimelineTurn`): the prompt that started each one, and the end of the agent's reply. */
  turns: TimelineTextTurn[];
  /** Questions, relayed questions and permission prompts by start time (`s`, as in `TimelineTurnWait`). */
  waits: TimelineTextWait[];
}

export interface TimelineTextTurn {
  t: number;
  k: TurnSender;
  /** The request's ID: joins the text to its turn (`TimelineTurn.id`); turns can share a time. */
  id?: string;
  /** The message that started the turn. Left out for compaction and system turns. */
  prompt?: string;
  /** The end of the agent's reply in the turn. */
  reply?: string;
  cut?: boolean;
}

export interface TimelineTextWait extends TimelineTurnWait {
  ask?: string;
  choices?: string[];
  answer?: string;
  tool?: string;
  intention?: string;
  before?: string;
  cut?: boolean;
}
