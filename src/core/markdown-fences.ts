/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Whether each line is part of a code fence, its opening and closing lines included. A fence opens with three or
 * more backticks or tildes, indented by up to three spaces, and closes with at least as many of the same character
 * and nothing else on the line. A marker with no closing marker after it opens no fence, so a stray marker doesn't
 * swallow the rest of the text.
 */
export function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = lines.map(() => false);
  for (let open = 0; open < lines.length; open++) {
    const opener = FENCE_MARKER.exec(lines[open]);
    if (!opener) continue;
    const fence = opener[1];
    for (let close = open + 1; close < lines.length; close++) {
      const closer = FENCE_MARKER.exec(lines[close]);
      if (closer && closer[1][0] === fence[0] && closer[1].length >= fence.length && !closer[2].trim()) {
        fenced.fill(true, open, close + 1);
        open = close;
        break;
      }
    }
  }
  return fenced;
}
