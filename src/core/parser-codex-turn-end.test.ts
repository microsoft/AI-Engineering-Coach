/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Where a Codex turn's agent time ends: at its task's completion or abort, or without one at its last logged work,
 * never at the next prompt or the next turn's setup lines. The fixtures are synthetic, in the shape of Codex rollout
 * files. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseCodexSessions } from './parser-codex';

function withCodexFile(lines: object[], run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-end-test-'));
  const dayDir = path.join(root, 'sessions', '2025', '06', '15');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-2025-06-15-test.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(path.join(root, 'sessions')); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('parseCodexSessions: turn end', () => {
  it('ends a turn’s agent time at its last logged work, not at the next prompt', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-codex-elapsed', cwd: '/Users/me/proj' } },
      { type: 'event_msg', timestamp: '2025-06-15T09:00:00Z', payload: { type: 'user_message', message: 'Fix the build.' } },
      { type: 'event_msg', timestamp: '2025-06-15T09:05:00Z', payload: { type: 'agent_message', message: 'Fixed.' } },
      { type: 'turn_context', timestamp: '2025-06-15T09:59:59Z', payload: { model: 'gpt-5.3-codex' } },
      { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'user_message', message: 'Now add a test.' } },
      { type: 'event_msg', timestamp: '2025-06-15T10:02:00Z', payload: { type: 'agent_message', message: 'Added.' } },
    ], (sessionsDir) => {
      expect(parseCodexSessions(sessionsDir)[0].requests.map(r => r.totalElapsed)).toEqual([300_000, 120_000]);
    });
  });

  it('ends a turn at task_complete or turn_aborted, not at the next turn’s setup lines', () => {
    // The order codex-cli 0.167 logs: the next turn's settings, task_started, context and developer message arrive
    // minutes after the previous task_complete, before its user message.
    const at = (m: number, s = 0) => new Date(Date.UTC(2025, 5, 15, 9, m, s)).toISOString();
    const user = (text: string) => ({ role: 'user', type: 'message', content: [{ type: 'input_text', text }] });
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-codex-turns', cwd: '/Users/me/proj' } },
      { type: 'event_msg', timestamp: at(0), payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: at(0), payload: { role: 'developer', type: 'message', content: [{ type: 'input_text', text: 'rules' }] } },
      { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-5-mini' } },
      { type: 'response_item', timestamp: at(0, 1), payload: user('Fix the build.') },
      { type: 'response_item', timestamp: at(1), payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Fixed.' }] } },
      { type: 'event_msg', timestamp: at(1, 1), payload: { type: 'token_count' } },
      { type: 'event_msg', timestamp: at(1, 2), payload: { type: 'task_complete', last_agent_message: 'Fixed.' } },
      { type: 'event_msg', timestamp: at(9), payload: { type: 'thread_settings_applied' } },
      { type: 'event_msg', timestamp: at(9), payload: { type: 'task_started' } },
      { type: 'turn_context', timestamp: at(9), payload: { model: 'gpt-5-mini' } },
      { type: 'world_state', timestamp: at(9) },
      { type: 'response_item', timestamp: at(9, 1), payload: { role: 'developer', type: 'message', content: [{ type: 'input_text', text: 'rules' }] } },
      { type: 'response_item', timestamp: at(9, 2), payload: user('Stop.') },
      { type: 'response_item', timestamp: at(9, 30), payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Stopping' }] } },
      { type: 'event_msg', timestamp: at(9, 31), payload: { type: 'turn_aborted' } },
      { type: 'event_msg', timestamp: at(20), payload: { type: 'thread_settings_applied' } },
      { type: 'event_msg', timestamp: at(20), payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: at(20, 1), payload: user('Go on.') },
      { type: 'response_item', timestamp: at(21, 1), payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done.' }] } },
    ], (sessionsDir) => {
      expect(parseCodexSessions(sessionsDir)[0].requests.map(r => r.totalElapsed)).toEqual([61_000, 29_000, 60_000]);
    });
  });

  it('leaves a turn’s duration unknown when only the prompt’s acknowledgment was logged', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'failed', cwd: '/Users/me/proj' } },
      { type: 'event_msg', timestamp: '2025-06-15T09:00:00Z', payload: { type: 'user_message', message: 'Fix it.' } },
      { type: 'event_msg', timestamp: '2025-06-15T09:00:00.010Z', payload: { type: 'item_completed', item: { type: 'UserMessage' } } },
    ], (sessionsDir) => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].totalElapsed).toBeNull();
    });
  });

  const userItem = (ts: string, text: string) => ({
    type: 'response_item', timestamp: ts,
    payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text }] },
  });
  const assistantItem = (ts: string, text: string) => ({
    type: 'response_item', timestamp: ts,
    payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text }] },
  });

  it('ends a turn when its task completes or is aborted, not at the next prompt', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-time', cwd: '/Users/me/proj', source: 'vscode' } },
      { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'task_started' } },
      userItem('2025-06-15T10:00:00Z', 'Why?'),
      assistantItem('2025-06-15T10:00:30Z', 'Because.'),
      { type: 'event_msg', timestamp: '2025-06-15T10:00:31Z', payload: { type: 'task_complete', last_agent_message: 'Because.' } },
      { type: 'event_msg', timestamp: '2025-06-15T20:00:00Z', payload: { type: 'task_started' } },
      userItem('2025-06-15T20:00:00Z', 'And then?'),
      assistantItem('2025-06-15T20:00:10Z', 'Done.'),
      { type: 'event_msg', timestamp: '2025-06-15T20:00:12Z', payload: { type: 'turn_aborted' } },
    ], sessionsDir => {
      expect(parseCodexSessions(sessionsDir)[0].requests.map(request => request.totalElapsed)).toEqual([31_000, 12_000]);
    });
  });

  it('keeps work logged after task_complete in the turn', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-late', cwd: '/Users/me/proj', source: 'vscode' } },
      userItem('2025-06-15T10:00:00Z', 'Why?'),
      { type: 'event_msg', timestamp: '2025-06-15T10:00:10Z', payload: { type: 'task_complete' } },
      assistantItem('2025-06-15T10:00:20Z', 'One more thing.'),
      userItem('2025-06-15T11:00:00Z', 'Thanks.'),
      assistantItem('2025-06-15T11:00:05Z', 'Welcome.'),
    ], sessionsDir => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].totalElapsed).toBe(20_000);
    });
  });

  it('keeps reasoning and shell calls logged after task_complete in the turn', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-late-items', cwd: '/Users/me/proj', source: 'vscode' } },
      userItem('2025-06-15T10:00:00Z', 'Why?'),
      { type: 'event_msg', timestamp: '2025-06-15T10:00:10Z', payload: { type: 'task_complete' } },
      { type: 'response_item', timestamp: '2025-06-15T10:00:15Z', payload: { type: 'reasoning', summary: [] } },
      { type: 'response_item', timestamp: '2025-06-15T10:00:25Z', payload: { type: 'local_shell_call', status: 'completed' } },
      userItem('2025-06-15T11:00:00Z', 'Thanks.'),
      assistantItem('2025-06-15T11:00:05Z', 'Welcome.'),
    ], sessionsDir => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].totalElapsed).toBe(25_000);
    });
  });

  it('does not count a later task with no prompt, such as a manual /compact, as the turn\'s work', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-compact', cwd: '/Users/me/proj', source: 'cli' } },
      { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'task_started' } },
      userItem('2025-06-15T10:00:00Z', 'Why?'),
      assistantItem('2025-06-15T10:00:30Z', 'Because.'),
      { type: 'event_msg', timestamp: '2025-06-15T10:00:31Z', payload: { type: 'task_complete' } },
      { type: 'event_msg', timestamp: '2025-06-15T13:00:00Z', payload: { type: 'task_started' } },
      { type: 'compacted', timestamp: '2025-06-15T13:00:18Z', payload: { message: 'Summary.' } },
      { type: 'event_msg', timestamp: '2025-06-15T13:00:20Z', payload: { type: 'task_complete' } },
      userItem('2025-06-15T13:05:00Z', 'And then?'),
      assistantItem('2025-06-15T13:05:10Z', 'Done.'),
    ], sessionsDir => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].totalElapsed).toBe(31_000);
    });
  });

  it('ends the first turn at its own task even after a task with no prompt opens the session', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-compact-first', cwd: '/Users/me/proj', source: 'cli' } },
      { type: 'event_msg', timestamp: '2025-06-15T09:00:00Z', payload: { type: 'task_started' } },
      { type: 'compacted', timestamp: '2025-06-15T09:00:18Z', payload: { message: 'Summary.' } },
      { type: 'event_msg', timestamp: '2025-06-15T09:00:20Z', payload: { type: 'task_complete' } },
      { type: 'event_msg', timestamp: '2025-06-15T10:00:00Z', payload: { type: 'task_started' } },
      userItem('2025-06-15T10:00:00Z', 'Why?'),
      assistantItem('2025-06-15T10:00:30Z', 'Because.'),
      { type: 'event_msg', timestamp: '2025-06-15T10:00:31Z', payload: { type: 'task_complete' } },
      userItem('2025-06-15T13:05:00Z', 'And then?'),
      assistantItem('2025-06-15T13:05:10Z', 'Done.'),
    ], sessionsDir => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].totalElapsed).toBe(31_000);
    });
  });

  it('ignores a task_complete stamped before its prompt: the turn ends at its last logged work', () => {
    withCodexFile([
      { type: 'session_meta', payload: { id: 'sess-early-end', cwd: '/Users/me/proj', source: 'cli' } },
      userItem('2025-06-15T10:00:00Z', 'Why?'),
      assistantItem('2025-06-15T10:00:30Z', 'Because.'),
      { type: 'event_msg', timestamp: '2025-06-15T09:59:00Z', payload: { type: 'task_complete' } },
      userItem('2025-06-15T10:05:00Z', 'And then?'),
      assistantItem('2025-06-15T10:05:10Z', 'Done.'),
    ], sessionsDir => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].totalElapsed).toBe(30_000);
    });
  });
});
