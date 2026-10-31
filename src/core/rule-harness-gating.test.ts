/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Rules that read fields only some harnesses log count only requests from those harnesses. */

import { describe, it, expect } from 'vitest';
import { createRequest, createSession } from './parser-shared';
import { runDetectors, runEmitters } from './detector-registry';
import { Analyzer } from './analyzer';
import { evaluateExpression } from './dsl/index';
import type { Session, SessionRequest } from './types';

const NOON = new Date(2026, 8, 28, 12).getTime();
const HOUR = 3_600_000;

let nextId = 0;
function requests(count: number, overrides: Partial<SessionRequest> = {}, start = NOON): SessionRequest[] {
  return Array.from({ length: count }, (_, index) => createRequest({
    requestId: `req-${nextId++}`,
    timestamp: start + index * 60_000,
    messageText: 'Refactor the parser so it streams events instead of buffering the file',
    responseText: 'Done.',
    ...overrides,
  }));
}

function session(harness: string, reqs: SessionRequest[]): Session {
  return createSession({ sessionId: `session-${nextId++}`, workspaceId: 'ws', workspaceName: 'Project', harness, requests: reqs });
}

function detect(sessions: Session[], ruleId: string) {
  return runDetectors(sessions.flatMap(s => s.requests), sessions, false).find(pattern => pattern.id === ruleId);
}

function emission(sessions: Session[], ruleId: string) {
  return runEmitters(sessions.flatMap(s => s.requests), sessions, false).get(ruleId);
}

const vscodeAgent = { agentName: 'GitHub Copilot', agentMode: 'agent' };
const cliAgent = { agentName: 'GitHub Copilot CLI', agentMode: 'agent' };
/** Every context-engineering signal but custom instructions. */
const wellEquipped = {
  agentName: 'reviewer', agentMode: 'agent', skillsUsed: ['pdf'], toolsUsed: ['mcp_github_search'], referencedFiles: ['src/app.ts'],
};

describe('no-plan-mode', () => {
  it('fires for VS Code agent requests that never use plan mode', () => {
    const result = detect([session('Local Agent', requests(40, vscodeAgent))], 'no-plan-mode');
    expect(result?.occurrences).toBe(40);
  });

  it('stays quiet once plan mode or /plan is used', () => {
    for (const planned of [{ agentMode: 'plan' }, { slashCommand: 'plan' }]) {
      const sessions = [session('Local Agent', [...requests(40, vscodeAgent), ...requests(1, { ...vscodeAgent, ...planned })])];
      expect(detect(sessions, 'no-plan-mode')).toBeUndefined();
    }
  });

  it('fires for Copilot CLI and OpenCode, whose logs record plan mode', () => {
    expect(detect([session('GitHub Copilot CLI', requests(35, cliAgent))], 'no-plan-mode')?.occurrences).toBe(35);
    expect(detect([session('OpenCode', requests(35, { agentName: 'build', agentMode: 'build' }))], 'no-plan-mode')?.occurrences).toBe(35);
    expect(detect([session('GitHub Copilot CLI', [...requests(35, cliAgent), ...requests(1, { ...cliAgent, agentMode: 'plan' })])], 'no-plan-mode'))
      .toBeUndefined();
  });

  it('leaves out Claude Code and Codex, whose logs never record plan mode', () => {
    const notLogged = [session('Claude', requests(200, { agentName: 'Claude', agentMode: 'agent' })), session('Codex', requests(100, { agentName: 'Codex', agentMode: 'agent' }))];
    expect(detect(notLogged, 'no-plan-mode')).toBeUndefined();
    expect(detect([...notLogged, session('Local Agent', requests(20, vscodeAgent))], 'no-plan-mode')).toBeUndefined();

    const sessions = [...notLogged, session('GitHub Copilot CLI', requests(35, cliAgent))];
    expect(detect(sessions, 'no-plan-mode')?.occurrences).toBe(35);
    expect(emission(sessions, 'no-plan-mode')).toMatchObject({ count: 35, total: 35 });
  });
});

describe('no-custom-instructions', () => {
  it('fires for VS Code requests without custom instructions', () => {
    const result = detect([session('Local Agent', requests(25))], 'no-custom-instructions');
    expect(result?.description).toContain('Only 0% of VS Code requests use custom instructions (0/25)');
  });

  it('never fires without VS Code requests, the only ones that log instructions', () => {
    const sessions = ['GitHub Copilot CLI', 'GitHub Copilot App', 'Claude', 'Codex', 'OpenCode', 'Xcode']
      .map(harness => session(harness, requests(100)));
    expect(detect(sessions, 'no-custom-instructions')).toBeUndefined();
  });

  it('rates instructions over VS Code requests only', () => {
    const sessions = [
      session('GitHub Copilot CLI', requests(400)),
      session('Local Agent', [...requests(23), ...requests(2, { customInstructions: ['.github/copilot-instructions.md'] })]),
    ];
    expect(detect(sessions, 'no-custom-instructions')).toBeUndefined();
    expect(emission(sessions, 'no-custom-instructions')).toMatchObject({ count: 23, total: 25 });
  });
});

describe('context-engineering-gaps', () => {
  it('leaves custom instructions out of the signals without VS Code requests', () => {
    expect(detect([session('Claude', requests(40, wellEquipped))], 'context-engineering-gaps')).toBeUndefined();

    const sessions = [session('Claude', requests(40, { ...wellEquipped, skillsUsed: [] }))];
    expect(detect(sessions, 'context-engineering-gaps')?.description).toContain('1 of 4 context engineering signals missing');
    expect(emission(sessions, 'context-engineering-gaps')).toMatchObject({ count: 1, total: 4 });
  });

  it('rates custom instructions over VS Code requests only', () => {
    const diluted = [
      session('GitHub Copilot CLI', requests(200, wellEquipped)),
      session('Local Agent', [...requests(18, wellEquipped), ...requests(2, { ...wellEquipped, customInstructions: ['AGENTS.md'] })]),
    ];
    expect(detect(diluted, 'context-engineering-gaps')).toBeUndefined();

    const sessions = [session('Local Agent', requests(40, wellEquipped))];
    expect(detect(sessions, 'context-engineering-gaps')?.description).toContain('1 of 5 context engineering signals missing');
  });

  it('agrees with contextGapCount on the custom-instructions signal', () => {
    const rows = (harness: string, overrides: Partial<SessionRequest> = {}) =>
      requests(40, { ...wellEquipped, ...overrides }).map(request => ({ ...request, harness }));
    const gaps = (allReqs: unknown[]) => evaluateExpression('contextGapCount(allReqs)', { allReqs });

    expect(gaps(rows('Claude'))).toMatchObject({ gapCount: 0, gaps: [] });
    expect(gaps(rows('Local Agent'))).toMatchObject({ gapCount: 1, gaps: ['Low custom instructions usage (< 5%)'] });
    expect(gaps(rows('Local Agent', { customInstructions: ['AGENTS.md'] }))).toMatchObject({ gapCount: 0 });
  });
});

describe('Analyzer.getAntiPatterns harness resolution', () => {
  it('resolves the harness of requests whose session a date filter drops', () => {
    // The session's last message falls after toDate, so the filter keeps its requests but drops the session.
    const spanning = session('Local Agent', [...requests(25), ...requests(1, {}, NOON + 96 * HOUR)]);
    const result = new Analyzer([spanning]).getAntiPatterns({ toDate: '2026-09-29' });
    expect(result.patterns.find(pattern => pattern.id === 'no-custom-instructions')?.description).toContain('(0/25)');
  });

  it('never writes harness onto the shared request objects', () => {
    const sessions = [session('Local Agent', requests(40, vscodeAgent)), session('Claude', requests(40))];
    new Analyzer(sessions).getAntiPatterns({ harness: 'Local Agent' });
    new Analyzer(sessions).getAntiPatterns();
    expect(sessions.flatMap(s => s.requests).some(request => 'harness' in request)).toBe(false);
  });
});
