/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Analyzer } from '../core/analyzer';
import { ParseResult } from '../core/parser';

class PanelCache {
  private parseResult: ParseResult | undefined;
  private analyzer: Analyzer | undefined;
  private analytics: Promise<void> = Promise.resolve();

  get result(): ParseResult | undefined { return this.parseResult; }
  get analyzerInstance(): Analyzer | undefined { return this.analyzer; }
  get analyticsReady(): Promise<void> { return this.analytics; }

  store(result: ParseResult, analyzer: Analyzer, analyticsReady: Promise<void> = Promise.resolve()): void {
    this.parseResult = result;
    this.analyzer = analyzer;
    this.analytics = analyticsReady;
  }

  clear(): void {
    this.parseResult = undefined;
    this.analyzer = undefined;
    this.analytics = Promise.resolve();
  }
}

export const panelCache = new PanelCache();