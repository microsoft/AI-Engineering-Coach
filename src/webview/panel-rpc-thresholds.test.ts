/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The rule detail view's threshold inputs, through the RPC handlers: updateRuleThreshold, then source and previews. */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/cache';
import { createRequest, createSession } from '../core/parser-shared';
import { removeUserRule } from '../core/rule-engine';
import { getRpcHandler } from './panel-rpc';

interface Preview { ruleId: string; triggered: boolean; occurrences: number; total: number }

const RULES_DIR = path.join(__dirname, '..', 'core', 'rules');
const fileSource = (id: string): string => fs.readFileSync(path.join(RULES_DIR, `${id}.md`), 'utf-8');

/** 20 prompts of 6 characters and 20 long ones, in one session. */
function sampleData(): { analyzer: Analyzer; parsed: ParseResult } {
  const prompt = (i: number, messageText: string) => createRequest({
    requestId: `r${i}`, messageText, responseText: 'Done.', timestamp: Date.UTC(2026, 9, 1, 12, i),
  });
  const requests = Array.from({ length: 40 }, (_, i) => prompt(i, i < 20 ? 'fix it' : 'Refactor the parser to stream tokens, and add a test for each case.'));
  const sessions = [createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })];
  const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  return { analyzer: new Analyzer(sessions, parsed.editLocIndex), parsed };
}

const { analyzer, parsed } = sampleData();
const call = <T>(method: string, params: Record<string, unknown>): T => getRpcHandler(method)!(analyzer, parsed, params) as T;
const preview = (ruleId: string): Preview => {
  const { triggered, occurrences, total } = call<Preview>('getRulePreview', { ruleId });
  return { ruleId, triggered, occurrences, total };
};

/** Index and text of each line that differs, splitting on `\n` so a CRLF line keeps its `\r`. */
function changedLines(before: string, after: string): Array<[number, string]> {
  const old = before.split('\n');
  const now = after.split('\n');
  expect(now).toHaveLength(old.length);
  return now.flatMap((line, i): Array<[number, string]> => (line === old[i] ? [] : [[i, line]]));
}

describe('updateRuleThreshold RPC', () => {
  afterEach(() => {
    removeUserRule('lazy-prompting');
    removeUserRule('copy-paste-blindness');
  });

  it('leaves the source and the preview as they were for the same value', () => {
    const before = preview('lazy-prompting');

    expect(call('updateRuleThreshold', { ruleId: 'lazy-prompting', key: 'maxRatio', value: 0.3 })).toEqual({ ok: true });

    expect(call('getRuleSource', { ruleId: 'lazy-prompting' })).toEqual({ source: fileSource('lazy-prompting') });
    expect(preview('lazy-prompting')).toEqual(before);
  });

  it('changes only the edited line and updates the preview', () => {
    expect(preview('lazy-prompting')).toEqual({ ruleId: 'lazy-prompting', triggered: true, occurrences: 20, total: 40 });

    expect(call('updateRuleThreshold', { ruleId: 'lazy-prompting', key: 'minChars', value: 5 })).toEqual({ ok: true });

    const file = fileSource('lazy-prompting');
    const { source } = call<{ source: string }>('getRuleSource', { ruleId: 'lazy-prompting' });
    const index = file.split('\n').findIndex(line => line.startsWith('  minChars: 30'));
    expect(changedLines(file, source)).toEqual([[index, file.split('\n')[index].replace('30', '5')]]);
    expect(source).toContain('# Tests');
    expect(preview('lazy-prompting')).toEqual({ ruleId: 'lazy-prompting', triggered: false, occurrences: 0, total: 40 });
  });

  // The detail view sends this: a listener left from a previously viewed rule fires with the current rule's key.
  it('rejects a key the rule does not have, such as another rule\'s, and changes nothing', () => {
    const before = preview('lazy-prompting');

    expect(call('updateRuleThreshold', { ruleId: 'lazy-prompting', key: 'minAiLoc', value: 51 })).toEqual({ ok: false });

    expect(call('getRuleSource', { ruleId: 'lazy-prompting' })).toEqual({ source: fileSource('lazy-prompting') });
    expect(preview('lazy-prompting')).toEqual(before);
  });

  it('keeps every rule loading after a same-value edit of copy-paste-blindness', () => {
    const before = call<{ previews: Preview[] }>('getRuleEditor', {}).previews.map(p => ({ ruleId: p.ruleId, triggered: p.triggered, occurrences: p.occurrences, total: p.total }));

    expect(call('updateRuleThreshold', { ruleId: 'copy-paste-blindness', key: 'minAiLoc', value: 50 })).toEqual({ ok: true });

    expect(call('getRuleSource', { ruleId: 'copy-paste-blindness' })).toEqual({ source: fileSource('copy-paste-blindness') });
    const after = call<{ previews: Preview[] }>('getRuleEditor', {}).previews;
    expect(after.map(p => ({ ruleId: p.ruleId, triggered: p.triggered, occurrences: p.occurrences, total: p.total }))).toEqual(before);
    expect(preview('lazy-prompting')).toMatchObject({ triggered: true, occurrences: 20 });
  });
});
