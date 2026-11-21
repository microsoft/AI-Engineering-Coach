/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { TurnBasis } from '../core/types';
import { html, render } from './render';

let note: typeof import('./turn-basis-note');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* noop */ },
    getState: () => null,
    setState: () => { /* noop */ },
  });
  note = await import('./turn-basis-note');
});

const basis: TurnBasis = { humanTurns: 12, automatedTurns: 6, automatedByKind: { autopilot: 1, agent: 3, relayed: 2 } };

describe('turnBasisSummary', () => {
  it('says what it counts and how many turns it left out', () => {
    expect(note.turnBasisSummary(basis)).toBe('Counts the 12 prompts you typed; 6 automated turns left out.');
    expect(note.turnBasisSummary({ humanTurns: 1, automatedTurns: 1, automatedByKind: { agent: 1 } }))
      .toBe('Counts the 1 prompt you typed; 1 automated turn left out.');
    expect(note.turnBasisSummary({ humanTurns: 1200, automatedTurns: 0, automatedByKind: {} })).toBe('Counts the 1.2K prompts you typed.');
  });
});

describe('automatedTurnLines', () => {
  it('lists the turns left out by kind, most first', () => {
    expect(note.automatedTurnLines(basis)).toEqual(['Sent by another agent: 3', 'Relayed from another session: 2', 'Autopilot continuations: 1']);
    expect(note.automatedTurnLines({ humanTurns: 3, automatedTurns: 0, automatedByKind: {} })).toEqual([]);
  });
});

describe('TurnBasisNote', () => {
  let container: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('renders the summary, the detail and the kinds left out', () => {
    render(html`<${note.TurnBasisNote} basis=${basis} detail="Lines of code include every turn." />`, container);
    expect(container.querySelector('.turn-basis-note')?.textContent)
      .toContain('Counts the 12 prompts you typed; 6 automated turns left out. Lines of code include every turn.');
    expect([...container.querySelectorAll('.turn-basis-kind')].map(kind => kind.textContent))
      .toEqual(['Sent by another agent: 3', 'Relayed from another session: 2', 'Autopilot continuations: 1']);
  });

  it('has no popup when nothing was left out, and renders nothing without a basis', () => {
    render(html`<${note.TurnBasisNote} basis=${{ humanTurns: 3, automatedTurns: 0, automatedByKind: {} }} />`, container);
    expect(container.querySelector('.turn-basis-note')?.textContent?.trim()).toBe('Counts the 3 prompts you typed.');
    expect(container.querySelector('.info-icon')).toBeNull();
    render(html`<${note.TurnBasisNote} />`, container);
    expect(container.querySelector('.turn-basis-note')).toBeNull();
  });
});
