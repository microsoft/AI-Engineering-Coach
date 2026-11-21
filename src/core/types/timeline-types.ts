/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline dataset: every session in range with its turns, as counts and timings only (no prompt or response text).
 * The analyzer builds it; `timeline-model.ts` derives the Day, Week and Families views from it. */

/** Who sent a turn: you typed it (`you`), another agent or session sent it (`agent`), autopilot continued
 *  (`autopilot`), a compaction request (`compaction`), or the harness (`other`). */
export type TurnSender = 'you' | 'agent' | 'autopilot' | 'compaction' | 'other';

export interface TimelineTurn {
  /** When the turn's prompt was logged (epoch ms). */
  t: number;
  /** The turn's span: its `totalElapsed`, from its prompt to the last assistant message (ms); 0 when not logged.
   *  Agent time is this span minus `w`, the time the turn waited on you. */
  d: number;
  k: TurnSender;
  /** Sub-agent runs the turn launched. */
  sub: number;
  /** The context was compacted during the turn. */
  comp: boolean;
  /** AI credits logged for the turn (Copilot CLI and Copilot App); 0 elsewhere. */
  cr: number;
  /** Tokens logged for the turn: Copilot usage records, else the turn's prompt and completion tokens. */
  tok: number;
  /** The harness logged no duration for the turn, so when its work ended is unknown (`d` is 0). */
  noDuration?: boolean;
  /** When the turn stopped for your answer to a question or a permission prompt: absolute spans in order, not
   *  overlapping. Each ended with your answer. Usually inside [t, t + d]; one can outlast the turn's last message. */
  w?: TimelineTurnWait[];
}

export interface TimelineTurnWait {
  s: number;
  e: number;
  k: 'question' | 'permission';
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
  /** Index of the parent session in `TimelineDataset.sessions`; -1 when it has none in range. */
  parent: number;
  via: TimelineLinkKind | null;
  /** Index of the session it was forked from (Codex, Claude Code); -1 or absent when it isn't a linked fork or the
   *  source has no turn in range. Not a family link. */
  fork?: number;
  /** Prompts copied from the fork source, left out of `turns` so they count once. */
  copiedTurns?: number;
  /** Turns in range, in time order. */
  turns: TimelineTurn[];
  /** Turns that started before the range: the last one, and any still running at its start. They give the waits and
   *  agent work that cross into the range; only their part inside the range counts, and they aren't counted as turns. */
  context?: TimelineTurn[];
}

export interface TimelineDataset {
  sessions: TimelineSessionRecord[];
  /** Sessions in range whose harness counted a fork without logging its source (Copilot `fork_count`). */
  forkedSessions: number;
  /** The range (epoch ms, local midnights): its start, and the end of its last day. Absent for an open bound. */
  from?: number;
  to?: number;
}
