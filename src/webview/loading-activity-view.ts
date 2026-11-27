/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Rows of the loading screen's activity table and the clipboard helper behind "Copy
 * diagnostics". Rows are built with textContent only: paths come from the user's disk. */

import { formatDuration, formatElapsed, type ActivityRow } from './loading-model';

const STATUS_LABELS = { reading: 'Reading', parsed: 'Parsed', slow: 'Slow', skipped: 'Skipped' } as const;

/** One table row: elapsed, `~` path with the folder name in bold, sessions, time, status. */
export function activityRowElement(row: ActivityRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.status = row.item.status;
  const cell = (text: string, cls?: string): HTMLTableCellElement => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    tr.appendChild(td);
    return td;
  };
  cell(formatElapsed(row.atMs), 'r mono');
  const pathCell = cell('', 'load-path');
  const { path, folder } = row.item;
  const dir = folder && path.endsWith(folder) ? path.slice(0, path.length - folder.length) : '';
  if (dir) {
    const span = document.createElement('span');
    span.className = 'load-path-dir';
    span.textContent = dir;
    pathCell.appendChild(span);
  }
  const base = document.createElement('b');
  base.textContent = dir ? folder : path;
  pathCell.appendChild(base);
  pathCell.title = path;
  cell(row.item.sessions === undefined ? '\u2014' : row.item.sessions.toLocaleString('en-US'), 'r');
  cell(row.item.ms === undefined ? '\u2014' : formatDuration(row.item.ms), 'r');
  const badge = document.createElement('span');
  badge.className = `load-badge load-badge-${row.item.status}`;
  badge.textContent = STATUS_LABELS[row.item.status];
  cell('').appendChild(badge);
  return tr;
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'visually-hidden';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Put `text` on the clipboard; falls back to a selection copy where the async API is missing. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  return copyWithSelection(text);
}
