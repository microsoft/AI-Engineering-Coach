/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * The Timeline's date picker redraws only itself while you move around the calendar: the page, and its lanes, are
 * drawn again only when a day or a range is picked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { DateRange } from '../core/timeline-range';
import { html, render } from './render';
import { closePicker, datePicker, type PickerActions, type PickerInput } from './timeline-date-picker';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function mountPage() {
  const root = document.createElement('div');
  document.body.append(root);
  const input: PickerInput = {
    view: 'day', date: '2026-05-03', range: null, lo: '2026-04-20', hi: '2026-06-10', today: '2026-05-03',
    activity: () => ({ level: 0, text: 'no activity' }), label: 'Sunday, 3 May 2026',
  };
  const page = { draws: 0, picked: [] as string[] };
  const actions: PickerActions = {
    pickDate: (date: string) => {
      page.picked.push(date);
      drawPage();
    },
    pickRange: (range: DateRange) => {
      page.picked.push(`${range.from}..${range.to}`);
      drawPage();
    },
  };
  function drawPage(): void {
    page.draws++;
    render(html`<div class="tlx-date">${datePicker(input, actions)}</div>`, root);
  }
  drawPage();
  page.draws = 0;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  return { root, page, $ };
}

const key = (target: Element | null, k: string) =>
  target?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  closePicker();
  document.body.replaceChildren();
});

describe('Timeline date picker, moving around the calendar', () => {
  it('opens, moves, changes month and starts a range without drawing the page again', async () => {
    const { page, $ } = mountPage();
    $('#tlxDateLabel')!.click();
    await settle();
    expect($('#tlxCal')).not.toBeNull();
    expect($('#tlxDateLabel')!.getAttribute('aria-expanded')).toBe('true');
    expect((document.activeElement as HTMLElement).dataset.date).toBe('2026-05-03');

    key(document.activeElement, 'ArrowRight');
    await settle();
    expect((document.activeElement as HTMLElement).dataset.date).toBe('2026-05-04');
    key(document.activeElement, 'PageDown');
    await settle();
    expect((document.activeElement as HTMLElement).dataset.date).toBe('2026-06-04');

    const month = $('#tlxCalMonth')!.textContent;
    $('#tlxCalPrev')!.click();
    await settle();
    expect($('#tlxCalMonth')!.textContent).not.toBe(month);

    $('#tlxCalMode button[data-value="range"]')!.click();
    await settle();
    expect($('#tlxCalStatus')!.textContent).toContain('Pick the first day');
    $('#tlxCal button[data-date="2026-05-05"]')!.click();
    await settle();
    expect($('#tlxCalStatus')!.textContent).toContain('now pick the last day');

    expect(page.draws).toBe(0);
    expect(page.picked).toEqual([]);
  });
});

describe('Timeline date picker, picking and closing', () => {
  it('draws the page once when a range is picked, then returns focus to the date', async () => {
    const { page, $ } = mountPage();
    $('#tlxDateLabel')!.click();
    await settle();
    $('#tlxCalMode button[data-value="range"]')!.click();
    await settle();
    $('#tlxCal button[data-date="2026-05-05"]')!.click();
    await settle();
    $('#tlxCal button[data-date="2026-05-08"]')!.click();
    await settle();
    expect(page.picked).toEqual(['2026-05-05..2026-05-08']);
    expect(page.draws).toBe(1);
    expect($('#tlxCal')).toBeNull();
    expect(document.activeElement?.id).toBe('tlxDateLabel');
  });

  it('closes with Esc or a click outside without drawing the page again', async () => {
    const { page, $ } = mountPage();
    $('#tlxDateLabel')!.click();
    await settle();
    key(document.activeElement, 'Escape');
    await settle();
    expect($('#tlxCal')).toBeNull();
    expect(document.activeElement?.id).toBe('tlxDateLabel');

    $('#tlxDateLabel')!.click();
    await settle();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect($('#tlxCal')).toBeNull();
    expect($('#tlxDateLabel')!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement?.id).toBe('tlxDateLabel');
    expect(page.draws).toBe(0);
  });

  it('leaves focus on what a click outside focused', async () => {
    const { $ } = mountPage();
    const other = document.createElement('button');
    document.body.append(other);
    $('#tlxDateLabel')!.click();
    await settle();
    other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    other.focus();
    await settle();
    expect($('#tlxCal')).toBeNull();
    expect(document.activeElement).toBe(other);
  });
});
