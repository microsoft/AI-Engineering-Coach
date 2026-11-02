/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Pattern arguments of the regex builtins: one pattern string, or an array such as a rule's patterns.* entry. */

import { describe, expect, it } from 'vitest';
import { evaluate } from './interpreter';
import type { ASTNode } from './types';

const stringNode = (value: string): ASTNode => ({ type: 'string', value });
const numberNode = (value: number): ASTNode => ({ type: 'number', value });
const booleanNode = (value: boolean): ASTNode => ({ type: 'boolean', value });
const identifierNode = (name: string): ASTNode => ({ type: 'identifier', name });
const arrayNode = (...elements: ASTNode[]): ASTNode => ({ type: 'array', elements });
const strings = (...values: string[]): ASTNode => arrayNode(...values.map(stringNode));

const ctx: Record<string, unknown> = {
  nil: null,
  pats: ['^fix', '(?i)^todo'],
  files: ['src/a.ts', 'docs/spec.md'],
  kinds: [{ kind: 'alpha' }, { kind: 'beta' }, { kind: 'gamma' }],
  reqs: [{ skillsUsed: ['cavecrew-compress'] }, { skillsUsed: [] }],
  sessions: [{ requests: [{ messageText: 'fix the bug' }] }, { requests: [{ messageText: 'add tests' }] }],
};
const call = (name: string, ...args: ASTNode[]): unknown => evaluate({ type: 'call', name, args }, ctx);
const op = stringNode('matches');
const kind = stringNode('kind');

describe('builtins that take a pattern', () => {
  it('matches() takes one pattern or an array, and matches when any pattern does', () => {
    expect(call('matches', stringNode('fix the bug'), stringNode('^fix'))).toBe(true);
    expect(call('matches', stringNode('TODO: tests'), identifierNode('pats'))).toBe(true);
    expect(call('matches', stringNode('add tests'), identifierNode('pats'))).toBe(false);
    expect(call('matches', stringNode('Hello'), strings('^x', '/^hello/i'))).toBe(true);
  });

  it('anyMatch() takes one pattern or an array, and returns 1 or 0', () => {
    expect(call('anyMatch', identifierNode('files'), stringNode(String.raw`(?i)\.MD$`))).toBe(1);
    expect(call('anyMatch', identifierNode('files'), strings(String.raw`\.py$`, String.raw`\.md$`))).toBe(1);
    expect(call('anyMatch', identifierNode('files'), strings(String.raw`\.py$`, String.raw`\.go$`))).toBe(0);
  });

  it('matchesAny() takes an array or one pattern', () => {
    expect(call('matchesAny', stringNode('why!!!'), strings(String.raw`\?{3,}`, '!{3,}'))).toBe(true);
    expect(call('matchesAny', stringNode('why!!!'), stringNode('!{3,}'))).toBe(true);
    expect(call('matchesAny', stringNode('why'), strings(String.raw`\?{3,}`, '!{3,}'))).toBe(false);
  });

  it('hasSkillByPattern() takes an array', () => {
    expect(call('hasSkillByPattern', identifierNode('reqs'), stringNode('(?i)CAVECREW'))).toBe(1);
    expect(call('hasSkillByPattern', identifierNode('reqs'), strings('^none', 'compress$'))).toBe(1);
    expect(call('hasSkillByPattern', identifierNode('reqs'), strings('^none'))).toBe(0);
  });

  it('the "matches" operator of countWhere, anyWhere, someWhere and flatSomeWhere takes an array', () => {
    expect(call('countWhere', identifierNode('kinds'), kind, op, strings('^a', '^b'))).toBe(2);
    expect(call('anyWhere', identifierNode('kinds'), kind, op, strings('^z', '^g'))).toBe(1);
    expect(call('anyWhere', identifierNode('kinds'), kind, op, strings('^z'))).toBe(0);
    expect(call('someWhere', identifierNode('kinds'), kind, op, strings('^z', 'mm'))).toBe(1);
    expect(call('someWhere', identifierNode('kinds'), kind, op, strings('^z'))).toBe(0);
    const flat = (patterns: ASTNode) =>
      call('flatSomeWhere', identifierNode('sessions'), stringNode('requests'), stringNode('messageText'), patterns, op);
    expect(flat(strings('^z', '^fix'))).toBe(1);
    expect(flat(strings('^z'))).toBe(0);
  });
});

describe('pattern arguments that match nothing', () => {
  it('an empty array', () => {
    const none = arrayNode();
    expect(call('matches', stringNode('anything'), none)).toBe(false);
    expect(call('matchesAny', stringNode('anything'), none)).toBe(false);
    expect(call('anyMatch', identifierNode('files'), none)).toBe(0);
    expect(call('hasSkillByPattern', identifierNode('reqs'), none)).toBe(0);
    expect(call('countWhere', identifierNode('kinds'), kind, op, none)).toBe(0);
  });

  it('an empty pattern string, alone or in an array, as a front matter [] or blank entry reads', () => {
    const empty = stringNode('');
    const emptyInArray = strings('');
    expect(call('matches', stringNode('anything'), empty)).toBe(false);
    expect(call('matches', stringNode('anything'), emptyInArray)).toBe(false);
    expect(call('matches', stringNode('beta'), strings('', '^b'))).toBe(true);
    expect(call('matchesAny', stringNode('anything'), emptyInArray)).toBe(false);
    expect(call('anyMatch', identifierNode('files'), empty)).toBe(0);
    expect(call('anyMatch', identifierNode('files'), emptyInArray)).toBe(0);
    expect(call('hasSkillByPattern', identifierNode('reqs'), empty)).toBe(0);
    expect(call('hasSkillByPattern', identifierNode('reqs'), emptyInArray)).toBe(0);
    expect(call('countWhere', identifierNode('kinds'), kind, op, emptyInArray)).toBe(0);
  });

  it('values and elements that are not strings', () => {
    const mixed = arrayNode(numberNode(1), identifierNode('nil'), booleanNode(true), stringNode('^b'));
    expect(call('matches', stringNode('1 true null'), mixed)).toBe(false);
    expect(call('matches', stringNode('beta'), mixed)).toBe(true);
    expect(call('matchesAny', stringNode('1 true null'), mixed)).toBe(false);
    expect(call('anyMatch', strings('1', 'true', ''), mixed)).toBe(0);
    expect(call('anyMatch', identifierNode('files'), identifierNode('missing'))).toBe(0);
    expect(call('anyMatch', strings('1'), numberNode(1))).toBe(0);
    expect(call('countWhere', identifierNode('kinds'), kind, op, identifierNode('nil'))).toBe(0);
  });

  it('a pattern the ReDoS guard rejects, while the other patterns still match', () => {
    expect(call('matches', stringNode('aaaa'), strings('(a+)+$'))).toBe(false);
    expect(call('matches', stringNode('aaaa!'), strings('(a+)+$', '!'))).toBe(true);
    expect(call('matchesAny', stringNode('aaaa'), strings('(a+)+$'))).toBe(false);
    expect(call('anyMatch', strings('aaaa'), strings('(a+)+$'))).toBe(0);
  });
});
