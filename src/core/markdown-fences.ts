/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/;

/**
 * The fence characters and info string of a line that is a fence marker, or null. As in CommonMark, a backtick
 * line whose info string contains a backtick (such as a one-line ```js```) isn't a marker.
 */
function fenceMarker(line: string): { fence: string; info: string } | null {
  const marker = FENCE_MARKER.exec(line);
  if (!marker || (marker[1][0] === '`' && marker[2].includes('`'))) return null;
  return { fence: marker[1], info: marker[2].trim() };
}

/**
 * Whether each line is part of a code fence, its opening and closing lines included. A fence opens with three or
 * more backticks or tildes, indented by up to three spaces, and closes with at least as many of the same character
 * and nothing else on the line. A marker with no closing marker after it opens no fence, so a stray marker at the
 * end doesn't swallow the rest of the text. A stray marker that a later fence's closing line can close does open a
 * fence up to that line, as a Markdown renderer reads it: a lone ``` above a rule's detect block runs to the
 * block's closing ```. Lines may end in `\r`.
 */
export function fencedLines(lines: readonly string[]): boolean[] {
  const markers = lines.map(fenceMarker);
  // For each fence character, the longest closing marker on each line or after it, so a marker that never closes
  // is skipped without scanning the rest of the text.
  const longest = { '`': Array<number>(lines.length + 1).fill(0), '~': Array<number>(lines.length + 1).fill(0) };
  for (let at = lines.length - 1; at >= 0; at--) {
    longest['`'][at] = longest['`'][at + 1];
    longest['~'][at] = longest['~'][at + 1];
    const marker = markers[at];
    if (marker && !marker.info) {
      const char = marker.fence[0] as '`' | '~';
      longest[char][at] = Math.max(longest[char][at], marker.fence.length);
    }
  }
  const closes = (at: number, fence: string) => {
    const marker = markers[at];
    return !!marker && !marker.info && marker.fence[0] === fence[0] && marker.fence.length >= fence.length;
  };
  const fenced = lines.map(() => false);
  for (let open = 0; open < lines.length; open++) {
    const fence = markers[open]?.fence;
    if (!fence || longest[fence[0] as '`' | '~'][open + 1] < fence.length) continue;
    let close = open + 1;
    while (!closes(close, fence)) close++;
    fenced.fill(true, open, close + 1);
    open = close;
  }
  return fenced;
}
