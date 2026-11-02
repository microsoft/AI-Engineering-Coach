/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Quoted values and inline lists in the YAML-like front matter of rule and metric files.
 *
 * - An inline list `[a, "b, c"]` splits on commas outside quoted items. An item that starts with a
 *   quote (after any spaces) runs to its closing quote. A quote anywhere else in an item is a literal
 *   character, so `[don't, x]` has two items.
 * - Double quotes: `\\` is one backslash and `\"` is a double quote. Every other backslash stays as
 *   written, so regex escapes such as `\d`, `\s` and `\b` don't have to be doubled: `"\d"` and `"\\d"`
 *   are both `\d`. YAML escapes such as `\n` and `\t` aren't processed either.
 * - Single quotes: `''` is one single quote, and a backslash is always literal.
 *
 * Callers trim a value before reading it, so CRLF files parse like LF files. They also keep their own
 * handling of values that aren't quoted, or whose quote is never closed.
 */

/**
 * The value of the quoted scalar that makes up all of `text` (already trimmed). Undefined when `text`
 * doesn't start with a quote, the quote is never closed, or anything follows the closing quote.
 */
export function readQuotedScalar(text: string): string | undefined {
  const quote = text[0];
  if (quote !== '"' && quote !== '\'') return undefined;
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote === '"' && c === '\\' && (next === '\\' || next === '"')) {
      value += next;
      i++;
    } else if (quote === '\'' && c === '\'' && next === '\'') {
      value += '\'';
      i++;
    } else if (c === quote) {
      return i === text.length - 1 ? value : undefined;
    } else {
      value += c;
    }
  }
  return undefined;
}

/**
 * The items between an inline list's brackets, split on commas outside quoted items and returned as
 * written (not trimmed or unquoted). If a quote is never closed, the list splits on every comma, as
 * front matter lists always did.
 */
export function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote = '';
  let atItemStart = true;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = '';
    } else if (quote === '\'') {
      if (c === '\'' && inner[i + 1] === '\'') i++;
      else if (c === '\'') quote = '';
    } else if (c === ',') {
      items.push(inner.slice(start, i));
      start = i + 1;
      atItemStart = true;
    } else if (atItemStart && (c === '"' || c === '\'')) {
      quote = c;
      atItemStart = false;
    } else if (c.trim() !== '') {
      atItemStart = false;
    }
  }
  if (quote) return inner.split(',');
  items.push(inner.slice(start));
  return items;
}

/** `value` as a double-quoted scalar that readQuotedScalar reads back unchanged. */
export function quoteScalar(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * An inline list that reads back as `items`. An item is quoted only when it would read back differently
 * as written: it holds a comma, starts or ends with a quote, or has spaces at either end.
 */
export function formatInlineList(items: string[]): string {
  const needsQuotes = (item: string) => item !== item.trim() || item.includes(',') || /^['"]|['"]$/.test(item);
  return `[${items.map(item => (needsQuotes(item) ? quoteScalar(item) : item)).join(', ')}]`;
}
