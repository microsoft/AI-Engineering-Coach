/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The text behind a Timeline lane: built from a session re-read in full, scrubbed and cut, and never carried by the
 * Timeline's dataset, the chat tool or the summary export. Synthetic Copilot logs. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatTimeline } from '../mcp/formatters';
import { Analyzer } from './analyzer';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import { MAX_TEXT, timelineSessionText } from './timeline-text';
import type { Session } from './types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-timeline-text-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

const ID = '7e470000-0000-4000-8000-000000000001';
const at = (m: number) => new Date(2026, 10, 17, 10, m).toISOString();
const labels = { home: '/home/jdoe', names: ['jdoe'], handles: ['octo-dev'] };

function parse(events: Record<string, unknown>[]): Session {
  const dir = path.join(root, ID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [{ type: 'session.start', timestamp: at(0), data: { sessionId: ID } }, ...events].map(x => JSON.stringify(x)).join('\n'));
  const s = parseCLIEventsFile(file, 'ws', 'fixture');
  if (!s) throw new Error('fixture did not parse');
  return s;
}

const fixture = () => parse([
  { type: 'user.message', timestamp: at(0), data: { content: 'Benchmark the cache in /home/jdoe/lab, token ghp_abcdefghijklmnopqrstuvwxyz0123' } },
  { type: 'assistant.message', timestamp: at(1), data: { content: 'Two cache sizes fit.' } },
  { type: 'tool.execution_start', timestamp: at(2), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Which size, jdoe?', choices: ['64 MB', '256 MB'] } } },
  { type: 'tool.execution_complete', timestamp: at(5), data: { toolCallId: 'q1', success: true, result: { content: 'User selected: 256 MB' } } },
  { type: 'permission.requested', timestamp: at(6), data: { requestId: 'p1', permissionRequest: { kind: 'url', url: 'https://example.com/x', intention: 'Read the docs' } } },
  { type: 'permission.completed', timestamp: at(7), data: { requestId: 'p1', decisionSource: 'human_response', result: { kind: 'approved' } } },
  { type: 'assistant.message', timestamp: at(8), data: { content: 'Done: 256 MB is 12% faster.' } },
  { type: 'user.message', timestamp: at(30), data: { content: 'x'.repeat(MAX_TEXT + 50) } },
  { type: 'assistant.message', timestamp: at(31), data: { content: 'ok' } },
]);

describe('timelineSessionText', () => {
  it('lists each turn’s prompt and reply and each stop’s question and answer, scrubbed, in time order', () => {
    const text = timelineSessionText(fixture(), labels);
    expect(text.turns[0]).toMatchObject({
      k: 'you', prompt: 'Benchmark the cache in ~/lab, token [secret]', reply: 'Two cache sizes fit.\n\nDone: 256 MB is 12% faster.',
    });
    expect(text.waits.map(w => [w.k, w.a, w.ask, w.choices, w.answer, w.before, w.tool, w.intention])).toEqual([
      ['question', true, 'Which size, [name]?', ['64 MB', '256 MB'], '256 MB', 'Two cache sizes fit.', undefined, undefined],
      ['permission', true, '[link]', undefined, 'approved', undefined, 'url', 'Read the docs'],
    ]);
    // Long text is cut, and says so.
    expect([text.turns[1].prompt?.length, text.turns[1].cut]).toEqual([MAX_TEXT + 2, true]);
  });

  it('times an answer to Copilot’s record of it, apart from the result, and carries no request ID', () => {
    const text = timelineSessionText(parse([
      { type: 'user.message', timestamp: at(0), data: { content: 'Go' } },
      { type: 'tool.execution_start', timestamp: at(2), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Ship it?' } } },
      { type: 'human_response.recorded', timestamp: at(4), data: { toolCallId: 'q1', requestId: 'req-1', response: { answer: 'yes' } } },
      { type: 'tool.execution_complete', timestamp: at(9), data: { toolCallId: 'q1', success: true, result: { content: 'User responded: yes' } } },
      { type: 'assistant.message', timestamp: at(10), data: { content: 'Shipped.' } },
    ]), labels);
    expect(text.waits.map(w => [w.s, w.e, w.at, w.answer, 'rid' in w])).toEqual([[Date.parse(at(2)), Date.parse(at(9)), Date.parse(at(4)), 'yes', false]]);
  });

  it('shows no text for compaction or system turns', () => {
    const s = fixture();
    s.requests[0].nonHumanKind = 'compaction';
    expect(timelineSessionText(s, labels).turns[0].prompt).toBeUndefined();
  });

  it('never reaches the Timeline dataset, the chat tool or the summary export', () => {
    // An unstripped session, as a parse returns it, to make sure none of these copy the text.
    const an = new Analyzer([fixture()], new Map());
    const day = { fromDate: '2026-11-17', toDate: '2026-11-17' };
    for (const out of [an.getTimelineData(day), formatTimeline(an, day, '2026-11-17'), buildSummaryExportFromAnalyzer(an, day)]) {
      const json = JSON.stringify(out);
      for (const secret of ['Which size', '256 MB', 'Read the docs', 'Two cache sizes', 'Benchmark the cache']) expect(json).not.toContain(secret);
    }
  });
});
