/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Synthetic Copilot CLI logs for end-to-end Timeline tests: write a session's events, parse them, and read a Day view.
 * Each test file calls `afterAll(removeTimelineSessions)`. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Analyzer } from '../core/analyzer';
import { parseCLIEventsFile } from '../core/parser-vscode-cli';
import {
  buildFamilies, buildLanes, buildViewFamilies, createNamer, prepareTimeline, timelineKpis, timelineWindow, viewInsights,
} from '../core/timeline-model';
import type { DateFilter, Session } from '../core/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-timeline-cli-'));
export const removeTimelineSessions = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });

export const M = 60_000;
export const D17 = '2026-11-17';
export const D18 = '2026-11-18';
export const at = (day: number, h = 0, m = 0) => new Date(2026, 10, day, h, m).getTime();
export const sid = (i: number) => 'ed9e0000-0000-4000-8000-' + String(i).padStart(12, '0');
export type Ev = { type: string; timestamp: string; data: Record<string, unknown> };
export const ev = (type: string, t: number, data: Record<string, unknown>): Ev => ({ type, timestamp: new Date(t).toISOString(), data });
export const prompt = (t: number, from?: number) => ev('user.message', t, {
  content: 'Fixture',
  ...(from ? { transformedContent: `<cross_session_message>\nfrom_session_id: ${sid(from)}\n</cross_session_message>\nFixture` } : {}),
});
export const reply = (t: number) => ev('assistant.message', t, { content: 'Done' });
export const start = (t: number, id = 'q', toolName = 'ask_user') => ev('tool.execution_start', t, { toolName, toolCallId: id });
export const end = (t: number, id = 'q', content = 'User selected: Yes') => ev('tool.execution_complete', t, { toolCallId: id, success: true, result: { content } });

/** The folder of session `i`'s log, made when missing: for its `workspace.yaml`. */
export function sessionDir(i: number): string {
  const dir = path.join(root, sid(i));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function session(i: number, events: Ev[], startAt = events[0] ? Date.parse(events[0].timestamp) : at(17), start: Record<string, unknown> = {}): Session | null {
  const dir = sessionDir(i);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [ev('session.start', startAt, { sessionId: sid(i), ...start }), ...events].map(x => JSON.stringify(x)).join('\n'));
  return parseCLIEventsFile(file, 'ws', 'fixture');
}

export const analyzer = (...sessions: (Session | null)[]) => new Analyzer(sessions.filter((s): s is Session => s !== null), new Map());

/** The Day view of `day`, from the dataset of filter `f` (the whole log when absent). */
export function view(an: Analyzer, day: string, f?: DateFilter) {
  const p = prepareTimeline(an.getTimelineData(f));
  const lanes = buildLanes(p, ...timelineWindow('day', day));
  const families = buildViewFamilies(lanes, p);
  return { p, lanes, kpis: timelineKpis(lanes, families), fam: buildFamilies(p), waits: viewInsights(lanes, families, createNamer(p, true), 'day', p)[2] };
}

export const only = (day: string): DateFilter => ({ fromDate: day, toDate: day });
