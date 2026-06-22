/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { evaluate } from './interpreter';
import { TokenType } from './types';
import {
  compileFilter,
  compileTrigger,
  parseAggregation,
  computeAggregation,
  evaluateTemplate,
  validateExpression,
} from './index';

/* ---- Lexer ---- */
describe('DSL Lexer', () => {
  it('tokenizes a simple comparison', () => {
    const tokens = lex('messageLength < 30');
    expect(tokens.map(t => t.type)).toEqual([TokenType.IDENTIFIER, TokenType.LT, TokenType.NUMBER, TokenType.EOF]);
  });

  it('tokenizes boolean keywords', () => {
    const tokens = lex('isCanceled == true');
    expect(tokens.map(t => t.type)).toEqual([TokenType.IDENTIFIER, TokenType.EQ, TokenType.BOOLEAN, TokenType.EOF]);
  });

  it('tokenizes string literals', () => {
    const tokens = lex('agentMode == "agent"');
    expect(tokens.map(t => t.type)).toEqual([TokenType.IDENTIFIER, TokenType.EQ, TokenType.STRING, TokenType.EOF]);
  });

  it('tokenizes AND / OR / NOT', () => {
    const tokens = lex('a > 1 AND NOT b == 2');
    const types = tokens.map(t => t.type);
    expect(types).toContain(TokenType.AND);
    expect(types).toContain(TokenType.NOT);
  });

  it('tokenizes field access with dots', () => {
    const tokens = lex('referencedFiles.length == 0');
    expect(tokens.map(t => t.type)).toEqual([TokenType.IDENTIFIER, TokenType.DOT, TokenType.IDENTIFIER, TokenType.EQ, TokenType.NUMBER, TokenType.EOF]);
  });

  it('tokenizes function calls', () => {
    const tokens = lex('contains(messageText, "help")');
    expect(tokens[0].type).toBe(TokenType.IDENTIFIER);
    expect(tokens[0].value).toBe('contains');
    expect(tokens[1].type).toBe(TokenType.LPAREN);
  });

  it('tokenizes pipe expressions', () => {
    const tokens = lex('value | truncate:80');
    expect(tokens.map(t => t.type)).toContain(TokenType.PIPE);
  });

  it('tokenizes regex literals', () => {
    const tokens = lex('matches(text, /^hello/i)');
    const regex = tokens.find(t => t.type === TokenType.STRING && t.value.startsWith('/'));
    expect(regex).toBeDefined();
  });
});

/* ---- Parser ---- */
describe('DSL Parser', () => {
  it('parses a simple comparison', () => {
    const ast = parse(lex('x < 30'));
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.op).toBe('<');
      expect(ast.left).toEqual({ type: 'identifier', name: 'x' });
      expect(ast.right).toEqual({ type: 'number', value: 30 });
    }
  });

  it('parses AND expression', () => {
    const ast = parse(lex('a > 1 AND b < 2'));
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') expect(ast.op).toBe('AND');
  });

  it('parses OR expression', () => {
    const ast = parse(lex('a > 1 OR b < 2'));
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') expect(ast.op).toBe('OR');
  });

  it('parses NOT expression', () => {
    const ast = parse(lex('NOT x'));
    expect(ast.type).toBe('unary');
    if (ast.type === 'unary') expect(ast.op).toBe('NOT');
  });

  it('parses field access', () => {
    const ast = parse(lex('a.b.c'));
    expect(ast.type).toBe('field_access');
  });

  it('parses function calls', () => {
    const ast = parse(lex('length(arr)'));
    expect(ast.type).toBe('call');
    if (ast.type === 'call') {
      expect(ast.name).toBe('length');
      expect(ast.args).toHaveLength(1);
    }
  });

  it('parses parenthesized expressions', () => {
    const ast = parse(lex('(a > 1)'));
    expect(ast.type).toBe('binary');
  });

  it('parses pipe expressions', () => {
    const ast = parse(lex('val | truncate:80'));
    expect(ast.type).toBe('pipe');
  });

  it('parses array literals', () => {
    const ast = parse(lex('[1, 2, 3]'));
    expect(ast.type).toBe('array');
    if (ast.type === 'array') expect(ast.elements).toHaveLength(3);
  });
});

/* ---- Interpreter ---- */
describe('DSL Interpreter', () => {
  const row = {
    messageLength: 15,
    responseLength: 500,
    messageText: 'fix the bug',
    isCanceled: false,
    agentMode: 'agent',
    modelId: 'gpt-4.1',
    toolsUsed: ['read_file', 'run_command'],
    editedFiles: ['main.ts'],
    referencedFiles: [],
    variableKinds: { file: 2, folder: 1 },
    timestamp: new Date('2024-03-15T23:30:00Z').getTime(),
    totalElapsed: 5000,
    customInstructions: ['rules.md'],
  };

  it('evaluates number comparison', () => {
    const ast = parse(lex('messageLength < 30'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates string equality', () => {
    const ast = parse(lex('agentMode == "agent"'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates boolean field', () => {
    const ast = parse(lex('isCanceled == false'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates field access on array length', () => {
    const ast = parse(lex('toolsUsed.length > 0'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates nested field access', () => {
    const ast = parse(lex('variableKinds.file'));
    expect(evaluate(ast, row)).toBe(2);
  });

  it('evaluates AND', () => {
    const ast = parse(lex('messageLength < 30 AND messageLength > 0'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates OR', () => {
    const ast = parse(lex('messageLength > 100 OR responseLength > 100'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates NOT', () => {
    const ast = parse(lex('NOT isCanceled'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates length() function', () => {
    const ast = parse(lex('length(toolsUsed)'));
    expect(evaluate(ast, row)).toBe(2);
  });

  it('evaluates contains() function', () => {
    const ast = parse(lex('contains(messageText, "bug")'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates startsWith() function', () => {
    const ast = parse(lex('startsWith(messageText, "fix")'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates hour() function', () => {
    const ast = parse(lex('hour(timestamp)'));
    // UTC hour of 2024-03-15T23:30:00Z
    expect(evaluate(ast, row)).toBe(new Date(row.timestamp).getHours());
  });

  it('evaluates includes() function', () => {
    const ast = parse(lex('includes(toolsUsed, "read_file")'));
    expect(evaluate(ast, row)).toBe(true);
  });

  it('evaluates abs() function', () => {
    const ast = parse(lex('abs(-5)'));
    expect(evaluate(ast, {} as Record<string, unknown>)).toBe(5);
  });

  it('evaluates truncate() function', () => {
    const ast = parse(lex('truncate(messageText, 5)'));
    expect(evaluate(ast, row)).toBe('fix t...');
  });

  it('evaluates pipe filter', () => {
    const ast = parse(lex('messageText | truncate:5'));
    expect(evaluate(ast, row)).toBe('fix t...');
  });

  it('evaluates matches() with regex', () => {
    const ast = parse(lex('matches(messageText, "/bug/i")'));
    expect(evaluate(ast, row)).toBe(true);
  });


  it('does not group prompts that only share the first 100 characters', () => {
    const sharedPrefix = 'Прочитай C:\\Users\\SALATE\\AppData\\Local\\Temp\\' + 'x'.repeat(120);

    const reqs = [
      { messageText: `${sharedPrefix}krutagidon-current-handoff.md` },
      { messageText: `${sharedPrefix}krutagidon-issues-08-09-handoff.md` },
      { messageText: `${sharedPrefix}krutagidon-other-context.md` },
    ];

    const ast = parse(lex('duplicateGroups(reqs, 10, 3)'));
    const result = evaluate(ast, { reqs }) as {
      totalDupes: number;
      distinctCount: number;
    };

    expect(result.totalDupes).toBe(0);
    expect(result.distinctCount).toBe(0);
  });

  it('groups repeated normalized prompts', () => {
    const reqs = [
      { messageText: 'Выполни handoff для следующей сессии' },
      { messageText: 'выполни handoff для следующей сессии' },
      { messageText: '  Выполни   handoff   для   следующей   сессии  ' },
    ];

    const ast = parse(lex('duplicateGroups(reqs, 10, 3)'));
    const result = evaluate(ast, { reqs }) as {
      totalDupes: number;
      distinctCount: number;
      topCount: number;
    };

    expect(result.totalDupes).toBe(3);
    expect(result.distinctCount).toBe(1);
    expect(result.topCount).toBe(3);
  });
  it('evaluates flatUnique() across sub-arrays', () => {
    const ctx = {
      reqs: [
        { toolsUsed: ['edit_file', 'read_file'] },
        { toolsUsed: ['terminal', 'edit_file'] },
        { toolsUsed: ['mcp_search', 'terminal'] },
        { toolsUsed: [] },
        { toolsUsed: null },
      ],
    } as unknown as Record<string, unknown>;
    const ast = parse(lex('flatUnique(reqs, "toolsUsed")'));
    expect(evaluate(ast, ctx)).toBe(4);
  });

  it('evaluates flatUnique() returns 0 when empty', () => {
    const ast = parse(lex('flatUnique(reqs, "toolsUsed")'));
    expect(evaluate(ast, { reqs: [] } as unknown as Record<string, unknown>)).toBe(0);
  });
});

/* ---- Compiled Functions ---- */
describe('DSL Compiled Functions', () => {
  const rows: Record<string, unknown>[] = [
    { messageLength: 5, isCanceled: false, modelId: 'gpt-4.1' },
    { messageLength: 50, isCanceled: true, modelId: 'gpt-4.1' },
    { messageLength: 10, isCanceled: false, modelId: 'claude-sonnet' },
    { messageLength: 200, isCanceled: false, modelId: 'gpt-4.1' },
    { messageLength: 3, isCanceled: false, modelId: 'claude-sonnet' },
  ];

  describe('compileFilter', () => {
    it('filters matching rows', () => {
      const filter = compileFilter('messageLength < 30');
      const matched = rows.filter(filter);
      expect(matched).toHaveLength(3);
    });

    it('handles AND', () => {
      const filter = compileFilter('messageLength < 30 AND isCanceled == false');
      const matched = rows.filter(filter);
      expect(matched).toHaveLength(3);
    });

    it('returns all for empty expression', () => {
      const filter = compileFilter('');
      expect(rows.filter(filter)).toHaveLength(5);
    });
  });

  describe('compileTrigger', () => {
    it('evaluates against emission data', () => {
      const trigger = compileTrigger('ratio > 0.3 AND count > 2');
      expect(trigger({ count: 3, total: 5, ratio: 0.6, extra: {} })).toBe(true);
      expect(trigger({ count: 1, total: 5, ratio: 0.2, extra: {} })).toBe(false);
    });
  });

  describe('parseAggregation', () => {
    it('parses ratio', () => {
      expect(parseAggregation('ratio')).toEqual({ type: 'ratio' });
    });

    it('parses count', () => {
      expect(parseAggregation('count')).toEqual({ type: 'count' });
    });

    it('parses avg(field)', () => {
      expect(parseAggregation('avg(totalElapsed)')).toEqual({ type: 'avg', field: 'totalElapsed' });
    });

    it('parses unique(field)', () => {
      expect(parseAggregation('unique(modelId)')).toEqual({ type: 'unique', field: 'modelId' });
    });
  });

  describe('computeAggregation', () => {
    it('computes ratio', () => {
      const matched = rows.filter(r => (r.messageLength as number) < 30);
      expect(computeAggregation({ type: 'ratio' }, matched, rows)).toBeCloseTo(0.6);
    });

    it('computes count', () => {
      const matched = rows.filter(r => (r.messageLength as number) < 30);
      expect(computeAggregation({ type: 'count' }, matched, rows)).toBe(3);
    });

    it('computes unique', () => {
      expect(computeAggregation({ type: 'unique', field: 'modelId' }, rows, rows)).toBe(2);
    });
  });

  describe('evaluateTemplate', () => {
    it('resolves template variables', () => {
      const result = evaluateTemplate('{{messageLength}} chars', { messageLength: 42 });
      expect(result).toBe('42 chars');
    });

    it('handles pipe in template', () => {
      const result = evaluateTemplate('{{messageText | truncate:10}}', { messageText: 'hello world from a long text' });
      expect(result).toBe('hello worl...');
    });
  });

  describe('validateExpression', () => {
    it('returns null for valid expressions', () => {
      expect(validateExpression('messageLength < 30')).toBeNull();
    });

    it('returns error for invalid expressions', () => {
      const err = validateExpression('messageLength <<< 30');
      expect(err).toBeTruthy();
    });
  });
});
