/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Analyzer } from '../core/analyzer';
import { ParseResult } from '../core/parser';
import type { SessionTotals } from '../core/session-totals';

/** Found-so-far totals the parse reported, kept so a reopened panel can show them without
 *  counting every session again on the extension host. */
export type StoredTotals = Partial<SessionTotals>;

class PanelCache {
  private parseResult: ParseResult | undefined;
  private analyzer: Analyzer | undefined;
  private analytics: Promise<void> = Promise.resolve();
  private parseTotals: StoredTotals = {};

  get result(): ParseResult | undefined { return this.parseResult; }
  get analyzerInstance(): Analyzer | undefined { return this.analyzer; }
  get analyticsReady(): Promise<void> { return this.analytics; }
  get totals(): StoredTotals { return this.parseTotals; }

  store(result: ParseResult, analyzer: Analyzer, analyticsReady: Promise<void> = Promise.resolve(), totals: StoredTotals = {}): void {
    this.parseResult = result;
    this.analyzer = analyzer;
    this.analytics = analyticsReady;
    this.parseTotals = totals;
  }

  clear(): void {
    this.parseResult = undefined;
    this.analyzer = undefined;
    this.analytics = Promise.resolve();
    this.parseTotals = {};
  }
}

export const panelCache = new PanelCache();