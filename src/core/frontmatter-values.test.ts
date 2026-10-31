/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { formatInlineList, quoteScalar, readQuotedScalar, splitInlineList } from './frontmatter-values';

describe('readQuotedScalar', () => {
  it('reads \\\\ as one backslash and \\" as a double quote in double quotes', () => {
    expect(readQuotedScalar(String.raw`"\\?{3,}"`)).toBe(String.raw`\?{3,}`);
    expect(readQuotedScalar(String.raw`"say \"hi\""`)).toBe('say "hi"');
    expect(readQuotedScalar(String.raw`"a\\\\b"`)).toBe(String.raw`a\\b`);
  });

  it('keeps every other backslash as written', () => {
    expect(readQuotedScalar(String.raw`"\d+\s\b\."`)).toBe(String.raw`\d+\s\b\.`);
    expect(readQuotedScalar(String.raw`"a\nb\t"`)).toBe(String.raw`a\nb\t`);
  });

  it("reads '' as one single quote in single quotes, where backslashes are literal", () => {
    expect(readQuotedScalar(`'won''t'`)).toBe(`won't`);
    expect(readQuotedScalar(`''''`)).toBe(`'`);
    expect(readQuotedScalar(String.raw`'\\d'`)).toBe(String.raw`\\d`);
  });

  it('reads empty strings and quotes of the other kind', () => {
    expect(readQuotedScalar('""')).toBe('');
    expect(readQuotedScalar(`''`)).toBe('');
    expect(readQuotedScalar(`"why won't"`)).toBe(`why won't`);
    expect(readQuotedScalar(`'say "hi"'`)).toBe('say "hi"');
  });

  it('is undefined unless the whole text is one closed quoted scalar', () => {
    expect(readQuotedScalar('plain')).toBeUndefined();
    expect(readQuotedScalar('"open')).toBeUndefined();
    expect(readQuotedScalar(String.raw`"escaped close\"`)).toBeUndefined();
    expect(readQuotedScalar('"a" b')).toBeUndefined();
    expect(readQuotedScalar(`'a'b'`)).toBeUndefined();
  });
});

describe('splitInlineList', () => {
  it('splits on commas outside quoted items', () => {
    expect(splitInlineList(String.raw`"!{3,}", "\\?{3,}", 'a, b', c`))
      .toEqual(['"!{3,}"', String.raw` "\\?{3,}"`, ` 'a, b'`, ' c']);
  });

  it("doesn't end a double-quoted item at an escaped quote", () => {
    expect(splitInlineList(String.raw`"a\", b", c`)).toEqual([String.raw`"a\", b"`, ' c']);
    expect(splitInlineList(String.raw`"a\\", b`)).toEqual([String.raw`"a\\"`, ' b']);
  });

  it("doesn't end a single-quoted item at ''", () => {
    expect(splitInlineList(`'won''t, can''t', x`)).toEqual([`'won''t, can''t'`, ' x']);
  });

  it('treats a quote inside a plain item as a literal character', () => {
    expect(splitInlineList(`don't, won't`)).toEqual([`don't`, ` won't`]);
    expect(splitInlineList(`don't, "a, b"`)).toEqual([`don't`, ` "a, b"`]);
  });

  it('splits plain items on every comma', () => {
    expect(splitInlineList('a, b,c')).toEqual(['a', ' b', 'c']);
    expect(splitInlineList('')).toEqual(['']);
  });

  it('splits on every comma when a quote is never closed, as before', () => {
    expect(splitInlineList('"a, b')).toEqual(['"a', ' b']);
    expect(splitInlineList(`x, 'y, z`)).toEqual(['x', ` 'y`, ' z']);
  });
});

describe('quoteScalar', () => {
  it('escapes backslashes and double quotes', () => {
    expect(quoteScalar(String.raw`\d "x"`)).toBe(String.raw`"\\d \"x\""`);
  });

  it.each([
    String.raw`\?{3,}`, String.raw`\\d`, '\\', 'x\\', String.raw`\"`, '"', `won't`, 'a, b', ' padded ', '',
  ])('reads %j back unchanged, alone and in a list', value => {
    const quoted = quoteScalar(value);
    expect(readQuotedScalar(quoted)).toBe(value);
    expect(splitInlineList(`${quoted}, next`)).toEqual([quoted, ' next']);
  });
});

describe('formatInlineList', () => {
  it('quotes only the items that would read back differently as written', () => {
    expect(formatInlineList(['plain', String.raw`a\b`, `it's`, 'a, b', '"q"', `'s`, ' padded']))
      .toBe(String.raw`[plain, a\b, it's, "a, b", "\"q\"", "'s", " padded"]`);
  });
});
