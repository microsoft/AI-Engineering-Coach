/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The installation page is the update check's privacy statement, so it must state the schedule
 * that update-schedule.ts implements. */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { afterFailure, afterSuccess, CHECK_INTERVAL_MS, type ScheduleState } from './update-schedule';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 31, 12);

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

/** The whole numbers in the first group that `pattern` captures in `text`. */
function numbersIn(text: string, pattern: RegExp): number[] {
  return (pattern.exec(text)?.[1].match(/\d+/g) ?? []).map(Number);
}

function hoursUntilNextCheck(state: ScheduleState): number {
  return Math.round(((state.nextCheckAt ?? NOW) - NOW) / HOUR);
}

describe('the update check schedule in the docs', () => {
  const page = read('docs/content/getting-started/installation.md');

  it('states the interval between checks', () => {
    const interval = [() => 0, () => 0.999_999].map(random => hoursUntilNextCheck(afterSuccess(NOW, random)));
    expect(numbersIn(page, /(\d+ to \d+) hours apart/)).toEqual(interval);
  });

  it('states the waits after a failed check', () => {
    const waits: number[] = [];
    let state: ScheduleState = {};
    for (let attempt = 0; attempt < 8; attempt++) {
      state = afterFailure(state, NOW, () => 0);
      waits.push(hoursUntilNextCheck(state));
    }
    // The waits double until they reach the daily interval, which the page calls "a day".
    expect(waits.at(-1)).toBe(CHECK_INTERVAL_MS / HOUR);
    expect(numbersIn(page, /waits ([^.]*?) hours, then a day/)).toEqual(waits.filter(hours => hours * HOUR < CHECK_INTERVAL_MS));
  });

  it('never promises at most one request a day', () => {
    for (const file of ['README.md', 'README.extension.md', 'docs/content/getting-started/installation.md', 'package.json']) {
      expect(read(file), file).not.toMatch(/at most one (anonymous )?request a day/i);
    }
  });
});
