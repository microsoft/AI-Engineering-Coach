/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The built-in rules that read `patterns:` from front matter, run through the rule pipeline. */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createRequest, createSession } from './parser-shared';
import { parseRule } from './rule-parser';
import { checkPipelineTrigger, executePipeline, parsePipeline } from './rule-pipeline';
import type { DetectionRule, DetectorEmission, Session, SessionRequest } from './types';

function loadRule(id: string): { source: string; rule: DetectionRule } {
  const source = fs.readFileSync(path.join(__dirname, 'rules', `${id}.md`), 'utf-8');
  const rule = parseRule(source);
  if (!rule) throw new Error(`${id} doesn't parse`);
  return { source, rule };
}

function run(rule: DetectionRule, reqs: SessionRequest[], sessions: Session[]): { emission: DetectorEmission; triggered: boolean } {
  const pipeline = parsePipeline(rule);
  const emission = executePipeline(pipeline, rule, { reqs, sessions, skipIdeDetectors: false });
  return { emission, triggered: checkPipelineTrigger(pipeline, emission, rule) };
}

function request(messageText: string, referencedFiles: string[] = []): SessionRequest {
  return createRequest({ messageText, responseText: 'Done.', referencedFiles, timestamp: Date.UTC(2026, 0, 14, 12) });
}

/** Non-blank lines of the rule's ```test block. */
function testBlockLines(source: string): string[] {
  const block = /```test\s*\n([\s\S]*?)```/.exec(source);
  return block ? block[1].split('\n').map(line => line.trim()).filter(Boolean) : [];
}

describe.each(['frustration-signals', 'no-spec-driven-development'])('%s source', id => {
  const { source, rule } = loadRule(id);

  it('is at version 2', () => {
    expect(rule.version).toBe(2);
  });

  it('parses every line of its # Tests block', () => {
    expect(rule.tests.length).toBeGreaterThan(0);
    expect(rule.tests).toHaveLength(testBlockLines(source).length);
  });

  it('parses the same with LF and CRLF line endings', () => {
    const lf = parseRule(source.replaceAll('\r\n', '\n'));
    const crlf = parseRule(source.replaceAll(/\r?\n/g, '\r\n'));
    expect(crlf?.patterns).toEqual(lf?.patterns);
    expect(crlf?.thresholds).toEqual(lf?.thresholds);
    expect(crlf?.tests).toEqual(lf?.tests);
  });
});

describe('frustration-signals', () => {
  const { rule } = loadRule('frustration-signals');
  const twice = (text: string) => run(rule, [request(text), request(text)], []);

  it('keeps each pattern whole', () => {
    expect(rule.patterns.frustration).toEqual(['!{3,}', String.raw`\?{3,}`, `wtf|come on|why won't`, `this is broken|doesn't work`]);
  });

  it("doesn't flag a prompt for a brace", () => {
    const { emission, triggered } = twice('please update the config { "a": 1 } now');
    expect(emission.count).toBe(0);
    expect(triggered).toBe(false);
  });

  it.each(['why does this still fail!!!', 'what is going on here???'])('flags %j without capitals', text => {
    const { emission, triggered } = twice(text);
    expect(emission.count).toBe(2);
    expect(triggered).toBe(true);
  });
});

describe('no-spec-driven-development', () => {
  const { rule } = loadRule('no-spec-driven-development');
  // Five sessions of three requests clear minAgentSessions; the rule reads only the first request.
  const sessionsStartingWith = (first: SessionRequest): Session[] => Array.from({ length: 5 }, (_, i) => createSession({
    sessionId: `s${i}`, workspaceId: 'ws', workspaceName: 'ws', harness: 'Local Agent',
    requests: [first, request('continue'), request('thanks')],
  }));
  const evaluateFirst = (first: SessionRequest) => {
    const sessions = sessionsStartingWith(first);
    return run(rule, sessions.flatMap(s => s.requests), sessions);
  };

  it.each([
    ['a bullet list', request('- add the parser\n- add tests\n- update the docs')],
    ['a numbered list', request('1. add the parser\n2. add tests\n3. update the docs')],
    ['a heading', request('# Goal\nadd the parser')],
    ['a spec keyword', request('the export must keep the order')],
    ['a referenced markdown file', request('update the parser', ['docs/spec.md'])],
  ])('counts a session that starts with %s as spec-driven', (_label, first) => {
    const { emission, triggered } = evaluateFirst(first);
    expect(emission.count).toBe(0);
    expect(emission.extra?.specDrivenCount).toBe(5);
    expect(triggered).toBe(false);
  });

  it.each([
    ['a referenced code file only', request('update the parser', ['src/parser.ts'])],
    ['an unstructured prompt', request('fix the login bug')],
    ['a two-line bullet list', request('- add the parser\n- add tests')],
  ])("doesn't count a session that starts with %s", (_label, first) => {
    const { emission, triggered } = evaluateFirst(first);
    expect(emission.count).toBe(5);
    expect(emission.extra?.specDrivenCount).toBe(0);
    expect(triggered).toBe(true);
  });
});
