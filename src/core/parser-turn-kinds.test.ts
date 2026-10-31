/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-harness rules for "user" turns the user didn't type. The fixtures copy each harness's field names and
 * values; their text is made up. */

import { describe, it, expect } from 'vitest';
import {
  claudeNonHumanKind, cliNonHumanKind, codexSessionNonHumanKind, openCodeMessageNonHumanKind, vscodeNonHumanKind,
} from './parser-turn-kinds';
import type { NonHumanKind } from './types';

const CLI_CASES: Array<[string, Record<string, unknown> | undefined, NonHumanKind | undefined]> = [
  ['a typed prompt', { content: 'Why does the build fail?' }, undefined],
  ['a typed prompt with the harness wrapper', { content: 'Why?', transformedContent: '<current_datetime>2026-09-30</current_datetime>\nWhy?' }, undefined],
  ['typed text that reads like a sender header', { content: 'from_date: today\nWhy?', transformedContent: '<now>today</now>\nfrom_date: today\nWhy?' }, undefined],
  ['an autopilot flag without a source', { content: 'Continue.', isAutopilotContinuation: true }, undefined],
  ['an unknown source', { content: 'Why?', source: 'agentic' }, undefined],
  ['no data', undefined, undefined],
  ['an agent', { content: 'Summarize.', source: 'agent-42' }, 'agent'],
  ['a bare agent source', { content: 'Summarize.', source: 'agent' }, 'agent'],
  ['a skill', { content: 'Skill instructions.', source: 'skill-pdf' }, 'skill'],
  ['the harness', { content: 'A background task finished.', source: 'system' }, 'system'],
  ['an autopilot continuation sent as system', { content: 'Continue.', source: 'system', isAutopilotContinuation: true }, 'autopilot'],
  ['autopilot', { content: 'Continue.', source: 'autopilot', isAutopilotContinuation: true }, 'autopilot'],
  ['a relayed message', { content: 'Run it.', transformedContent: '<relayed_message>\nfrom_session_id: s1\n</relayed_message>\nRun it.' }, 'relayed'],
  ['a sender header with =', { content: 'Run it.', transformedContent: 'sender_agent_id = a1\nRun it.' }, 'relayed'],
  ['an agent message relayed from another session', { content: 'Run it.', source: 'agent-1', transformedContent: 'from_agent_id: a1\nRun it.' }, 'relayed'],
  ['a harness message that carries a sender header', { content: 'Run it.', source: 'system', transformedContent: 'from_session_id: s1\nRun it.' }, 'system'],
  ['the relay wrapper the harness writes', {
    content: 'Run the tests.',
    transformedContent: '<cross_session_message>\nfrom_project_session_id: p1\nfrom_session_id: s1\nsource_tool_call_id: t1\n</cross_session_message>\n\nRun the tests.',
  }, 'relayed'],
  ['the relay wrapper after other text on its line', {
    content: 'Run the tests.', source: 'agent-3',
    transformedContent: 'Kickoff: <cross_session_message>\nfrom_display_name: Coordinator\n</cross_session_message>\nRun the tests.',
  }, 'relayed'],
  ['an IDE selection with a from_ assignment', {
    content: 'Why does this send twice?',
    transformedContent: '<ide_selection path="app/mail.py">\n    from_email=settings.DEFAULT_FROM_EMAIL,\n</ide_selection>\nWhy does this send twice?',
  }, undefined],
  ['an IDE selection with a from_ key', {
    content: 'Is this config valid?',
    transformedContent: '<ide_selection>\n  from_address: noreply@example.test\n</ide_selection>\nIs this config valid?',
  }, undefined],
  ['an IDE selection quoting a relay header and wrapper', {
    content: 'Why does this test fail?',
    transformedContent: '<ide_selection>\nfrom_session_id: abc\n<cross_session_message>\n</ide_selection>\nWhy does this test fail?',
  }, undefined],
  ['an inline IDE selection quoting the relay wrapper', {
    content: 'Why is this tag here?',
    transformedContent: '<ide_selection><cross_session_message></ide_selection>\nWhy is this tag here?',
  }, undefined],
  ['the relay wrapper after an inline IDE selection', {
    content: 'Run the tests.',
    transformedContent: '<ide_selection>const total = 1;</ide_selection><cross_session_message>\nRun the tests.\n</cross_session_message>',
  }, 'relayed'],
  ['the relay wrapper on the line where a quoted element closes', {
    content: 'Run the tests.',
    transformedContent: '<system_notification>\nThe build finished.\n</system_notification><cross_session_message>\nRun the tests.\n</cross_session_message>',
  }, 'relayed'],
  ['fenced code the harness added', { content: 'Why?', transformedContent: '```\nfrom_session_id: abc\n```\nWhy?' }, undefined],
  ['typed header-like text the harness trimmed', {
    content: 'Why does this log line repeat?\nfrom_session_id: abc\n',
    transformedContent: '<current_datetime>2026</current_datetime>\nWhy does this log line repeat?\nfrom_session_id: abc',
  }, undefined],
  ['typed header-like text the harness stored with LF endings', {
    content: 'from_session_id: abc\r\nWhy does this log line repeat?',
    transformedContent: '<current_datetime>2026</current_datetime>\nfrom_session_id: abc\nWhy does this log line repeat?',
  }, undefined],
  ['typed text the harness reworded', { content: 'from_date: 2026-01-01\n\nWhy is the total wrong?', transformedContent: 'from_date: 2026-01-01\nWhy is the total wrong?' }, undefined],
];

describe('cliNonHumanKind', () => {
  it.each(CLI_CASES)('%s', (_label, data, expected) => {
    expect(cliNonHumanKind(data)).toBe(expected);
  });
});

describe('vscodeNonHumanKind', () => {
  it.each<[string, Record<string, unknown>, NonHumanKind | undefined]>([
    ['a typed request', {}, undefined],
    ['a confirmation the user clicked', { confirmation: 'Continue' }, undefined],
    ['a request VS Code sent itself', { isSystemInitiated: true }, 'system'],
    ['a non-boolean flag', { isSystemInitiated: 'true' }, undefined],
    ['a delegated request', { origin: { kind: 'delegation' } }, 'relayed'],
    ['another origin', { origin: { kind: 'chat' } }, undefined],
    ['a system request with an origin', { isSystemInitiated: true, origin: { kind: 'delegation' } }, 'system'],
  ])('%s', (_label, request, expected) => {
    expect(vscodeNonHumanKind(request)).toBe(expected);
  });
});

describe('claudeNonHumanKind', () => {
  const user = (content: unknown, extra: { isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean } = {}) =>
    ({ type: 'user', message: { content }, ...extra });
  const text = (value: string) => [{ type: 'text', text: value }];
  const assistant = { type: 'assistant', message: { content: text('Done.') } };
  const toolResult = user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
  const command = user(text('<command-message>review is running…</command-message>\n<command-name>/review</command-name>'));
  const caveat = user(text('Caveat: The messages below were generated by the user while running local commands.'), { isMeta: true });
  const expansion = user(text('Review the change for bugs.'), { isMeta: true });

  it.each<[string, Array<ReturnType<typeof user> | typeof assistant>, NonHumanKind | undefined]>([
    ['a typed prompt', [user(text('Why?'))], undefined],
    ['a typed shell command', [user(text('<bash-input>npm test</bash-input>'))], undefined],
    ['a typed prompt command, expanded on a meta line', [command, expansion], undefined],
    ['a prompt command whose name line starts with <command-name>', [user('<command-name>/review</command-name>'), expansion], undefined],
    ['a sub-agent turn', [user(text('Find the totals.'), { isSidechain: true })], 'subagent'],
    ['a sub-agent meta line', [command, user(text('Skill body.'), { isSidechain: true, isMeta: true })], 'subagent'],
    ['a compaction summary', [user(text('This session is being continued from a previous conversation.'), { isCompactSummary: true })], 'compaction'],
    ['a background task notification', [user('<task-notification>\n<status>completed</status>\n</task-notification>')], 'system'],
    ['shell output', [user(text('<bash-stdout>1 passed</bash-stdout><bash-stderr></bash-stderr>'))], 'output'],
    ['local command output', [user(text('<local-command-stdout>Set model</local-command-stdout>'))], 'output'],
    ['local command errors', [user(' <local-command-stderr>Unknown</local-command-stderr>')], 'output'],
    ['the local-command caveat', [caveat], 'meta'],
    ['a meta line after the assistant answered a command', [command, assistant, expansion], 'meta'],
    ['a skill body after a tool result', [user(text('Fix it.')), assistant, toolResult, expansion], 'meta'],
    ['a meta line after a typed prompt', [user(text('Why?')), expansion], 'meta'],
  ])('%s', (_label, lines, expected) => {
    expect(claudeNonHumanKind(lines, lines.length - 1)).toBe(expected);
  });
});

describe('codexSessionNonHumanKind', () => {
  it.each<[unknown, NonHumanKind | undefined]>([
    ['cli', undefined],
    ['vscode', undefined],
    ['exec', undefined],
    ['mcp', undefined],
    ['unknown', undefined],
    [undefined, undefined],
    [{}, undefined],
    [{ subagent: 'review' }, 'subagent'],
    [{ subagent: 'compact' }, 'subagent'],
    [{ subagent: { thread_spawn: { parent_thread_id: 't1', depth: 1 } } }, 'subagent'],
    [{ internal: 'memory' }, 'subagent'],
    ['subagent_review', 'subagent'],
    ['internal', 'subagent'],
  ])('%j', (source, expected) => {
    expect(codexSessionNonHumanKind(source)).toBe(expected);
  });
});

describe('openCodeMessageNonHumanKind', () => {
  const typed = { type: 'text', text: 'Read this file.' };
  const synthetic = (value: string) => ({ type: 'text', text: value, synthetic: true });

  it.each<[string, Array<Record<string, unknown>> | undefined, NonHumanKind | undefined]>([
    ['no parts', undefined, undefined],
    ['an empty part list', [], undefined],
    ['a typed prompt', [typed], undefined],
    ['an attached file', [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }], undefined],
    ['a typed prompt with the synthetic text of an attached file', [typed, synthetic('Called the Read tool with the following input: {}')], undefined],
    ['a typed /compact', [{ type: 'compaction', auto: false }], undefined],
    ['a compaction without auto', [{ type: 'compaction' }], undefined],
    ['the user shell-command marker', [synthetic('The following tool was executed by the user')], undefined],
    ['the shell-command marker with whitespace', [synthetic('  The following tool was executed by the user\n')], undefined],
    ['an automatic compaction', [{ type: 'compaction', auto: true }], 'compaction'],
    ['an automatic compaction with synthetic text', [{ type: 'compaction', auto: true }, synthetic('Summarize.')], 'compaction'],
    ['a generated message', [synthetic('Continue if you have next steps')], 'system'],
    ['a generated message with several parts', [synthetic('Continue.'), { type: 'file', synthetic: true }], 'system'],
  ])('%s', (_label, parts, expected) => {
    expect(openCodeMessageNonHumanKind(parts)).toBe(expected);
  });
});
