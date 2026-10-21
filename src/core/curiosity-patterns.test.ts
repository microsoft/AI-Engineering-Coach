/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { Analyzer } from './analyzer';
import { CuriosityAnalyzer } from './analyzer-curiosity';
import { curiosityBalance } from './curiosity-balance';
import { PatternsAnalyzer } from './analyzer-patterns';
import { curiosityAntiPatterns, curiosityPatternContribution } from './curiosity-patterns';
import { emptyActivityCounts, type ActivityCounts } from './curiosity-activity';
import { detectCuriosity } from './curiosity';
import { createRequest, createSession } from './parser-shared';
import type { Session } from './types';

const MONDAY = Date.parse('2026-09-28T12:00:00Z');
const QUESTION = 'Why does the parser return this shared value?';
function dataset(counts: ActivityCounts, offset = 0, name = 'source'): Session {
  const tools = { direct: [], web: ['web_fetch'], repository: ['view'], action: ['apply_patch'] };
  let index = 0;
  const requests = (['direct', 'web', 'repository', 'action'] as const).flatMap(activity => Array.from({ length: counts[activity] }, () => {
    const serial = index++;
    return createRequest({
      requestId: `${name}-${serial}`, userEventId: `${name}-${serial}`,
      timestamp: MONDAY + offset + serial % 7 * 86_400_000, messageText: QUESTION,
      curiosity: detectCuriosity(QUESTION), answerEvidence: 'final', responseText: 'Recorded answer.',
      toolsUsed: tools[activity], referencedFiles: ['src/parser.ts'],
    });
  }));
  return createSession({
    sessionId: name, workspaceId: 'project', workspaceName: 'project', harness: 'GitHub Copilot App',
    creationDate: MONDAY + offset, lastMessageDate: MONDAY + offset + 6 * 86_400_000, requests,
  });
}

describe('Curiosity Prompt Quality findings', () => {
  it('grades three levels and leaves insufficient evidence ungraded', () => {
    expect(curiosityBalance({ direct: 10, web: 10, repository: 20, action: 60 }, 100, 7).tier).toBe('balanced');
    expect(curiosityBalance({ direct: 18, web: 1, repository: 1, action: 30 }, 50, 7).tier).toBe('needs-review');
    expect(curiosityBalance({ direct: 20, web: 0, repository: 0, action: 30 }, 50, 7).tier).toBe('strongly-skewed');
    expect(curiosityBalance({ direct: 19, web: 0, repository: 0, action: 31 }, 50, 7).tier).toBe('insufficient');
    expect(curiosityBalance({ direct: 2, web: 0, repository: 0, action: 98 }, 100, 7).tier).toBe('strongly-skewed');
    expect(curiosityBalance({ direct: 20, web: 0, repository: 0, action: 30 }, 50, 6).tier).toBe('insufficient');
    expect(curiosityBalance({ direct: 20, web: 0, repository: 0, action: 30 }, 72, 7).tier).toBe('insufficient');
    expect(curiosityBalance(emptyActivityCounts(), 0, 0).tier).toBe('insufficient');
  });

  it('keeps the eighty and ninety-five percent investigation boundaries inclusive', () => {
    expect(curiosityBalance({ direct: 16, web: 4, repository: 0, action: 30 }, 50, 7).tier).toBe('balanced');
    expect(curiosityBalance({ direct: 19, web: 1, repository: 0, action: 30 }, 50, 7).tier).toBe('needs-review');
    expect(curiosityBalance({ direct: 96, web: 4, repository: 0, action: 100 }, 200, 7).tier).toBe('strongly-skewed');
    expect(curiosityBalance({ direct: 10, web: 15, repository: 25, action: 50 }, 100, 7).tier).toBe('balanced');
    expect(curiosityBalance({ direct: 5, web: 0, repository: 0, action: 95 }, 100, 7).tier).toBe('needs-review');
    expect(curiosityBalance({ direct: 30, web: 30, repository: 35, action: 5 }, 100, 7).tier).toBe('needs-review');
  });

  it('uses normal Prompt Quality findings and severity weights without penalizing Balanced activity', () => {
    for (const [counts, severity] of [
      [{ direct: 10, web: 10, repository: 20, action: 60 }, undefined],
      [{ direct: 18, web: 1, repository: 1, action: 30 }, 'medium'],
      [{ direct: 20, web: 0, repository: 0, action: 30 }, 'high'],
    ] as const) {
      const source = dataset(counts);
      const data = new CuriosityAnalyzer([source], new Map()).getCuriosity();
      const native = curiosityAntiPatterns(data);
      const analyzer = new PatternsAnalyzer([source], new Map());
      const base = analyzer.getAntiPatterns();
      const result = analyzer.getAntiPatterns(undefined, curiosityPatternContribution(data));
      expect(native.find(row => row.id === 'curiosity-balance')?.severity).toBe(severity);
      expect(result.totalOccurrences).toBe(base.totalOccurrences + native.reduce((sum, pattern) => sum + pattern.occurrences, 0));
      const promptScore = result.groupScores.find(row => row.group === 'prompt-quality')!;
      const basePrompt = base.groupScores.find(row => row.group === 'prompt-quality')!;
      if (severity) {
        expect(native).toHaveLength(1);
        expect(native[0]).toMatchObject({ id: 'curiosity-balance', severity, group: 'prompt-quality', occurrences: 1, aggregate: true });
        expect(promptScore.score).toBeLessThan(basePrompt.score);
        expect(promptScore.patternCount).toBe(basePrompt.patternCount + 1);
        expect(native[0].description).toContain('not question quality or learning');
      } else {
        expect(native).toEqual([]);
        expect(promptScore.score).toBe(basePrompt.score);
      }
      for (const group of ['session-hygiene', 'code-review', 'tool-mastery']) {
        expect(result.groupScores.find(row => row.group === group)).toEqual(base.groupScores.find(row => row.group === group));
      }
    }
  });

  it('uses the same tiers in weekly scores and excludes partial-week evidence', () => {
    const source = dataset({ direct: 20, web: 0, repository: 0, action: 30 });
    const data = new CuriosityAnalyzer([source], new Map()).getCuriosity();
    expect(data.weeklyChecks).toHaveLength(1);
    expect(data.weeklyChecks[0].balance).toMatchObject({ tier: 'strongly-skewed', activeDays: 7 });
    expect(curiosityPatternContribution(data).weekly).toMatchObject([{ severity: 'high', occurrences: 1 }]);
    const analyzer = new PatternsAnalyzer([source], new Map());
    const base = analyzer.getAntiPatterns();
    const scored = analyzer.getAntiPatterns(undefined, curiosityPatternContribution(data));
    expect(data.weeklyChecks.map(row => row.week)).toEqual(base.weeklyScores.labels);
    expect(scored.weeklyScores.series[0].scores[0]).toBeLessThan(base.weeklyScores.series[0].scores[0]);
    expect(scored.weeklyTrend.counts[0]).toBe(base.weeklyTrend.counts[0] + 1);
    const filter = { fromDate: '2026-09-29' };
    const partial = new CuriosityAnalyzer([source], new Map()).getCuriosity(filter);
    expect(partial.weeklyChecks[0].balance.tier).toBe('insufficient');
    expect(curiosityPatternContribution(partial).weekly).toEqual([]);
    expect(analyzer.getAntiPatterns(filter, curiosityPatternContribution(partial)).weeklyScores).toEqual(analyzer.getAntiPatterns(filter).weeklyScores);
  });

  it('includes historical weekly penalties and improvement even when the full-period balance is clear', () => {
    const earlier = dataset({ direct: 20, web: 0, repository: 0, action: 30 });
    const later = dataset({ direct: 10, web: 10, repository: 20, action: 60 }, 7 * 86400000, 'later');
    const sessions = [earlier, later];
    const data = new CuriosityAnalyzer(sessions, new Map()).getCuriosity();
    expect(data.balance.tier).toBe('balanced');
    expect(data.weeklyChecks.map(row => row.balance.tier)).toEqual(['strongly-skewed', 'balanced']);
    expect(curiosityAntiPatterns(data).some(pattern => pattern.id === 'curiosity-balance')).toBe(false);
    const analyzer = new PatternsAnalyzer(sessions, new Map());
    const base = analyzer.getAntiPatterns();
    const scored = analyzer.getAntiPatterns(undefined, curiosityPatternContribution(data));
    expect(scored.weeklyScores.series[0].scores[0]).toBeLessThan(base.weeklyScores.series[0].scores[0]);
    expect(scored.weeklyScores.series[0].scores[1]).toBe(base.weeklyScores.series[0].scores[1]);
    expect(scored.weeklyTrend.counts).toEqual([base.weeklyTrend.counts[0] + 1, base.weeklyTrend.counts[1]]);
    expect(scored.groupScores[0].wowPct).toBeGreaterThan(base.groupScores[0].wowPct);
    expect(scored.weeklyScores.series.slice(1)).toEqual(base.weeklyScores.series.slice(1));
  });

  it('deduplicates copied evidence and applies date, workspace and harness filters through the facade', () => {
    const source = dataset({ direct: 20, web: 0, repository: 0, action: 30 });
    const copy = { ...source, sessionId: 'copy', harness: 'GitHub Copilot CLI', requests: source.requests.map(row => ({ ...row })) };
    const analyzer = new Analyzer([source, copy]);
    const native = analyzer.getAntiPatterns().patterns.filter(row => row.id.startsWith('curiosity-'));
    expect(native).toHaveLength(1);
    expect(native[0].description).toContain('20 inquiry / 30 Task execution turns');
    for (const filter of [{ fromDate: '2026-09-29' }, { workspaceId: 'other' }, { harness: 'Claude Code' }]) {
      const filtered = analyzer.getAntiPatterns(filter);
      expect(filtered.curiosityTier).toBe('insufficient');
      expect(filtered.patterns.filter(row => row.id.startsWith('curiosity-'))).toEqual([]);
    }
  });

  it('keeps repeated wording as a low-severity observation, not a claim of poor retention', () => {
    const first = dataset({ direct: 1, web: 0, repository: 0, action: 0 }, 0, 'first');
    const second = dataset({ direct: 1, web: 0, repository: 0, action: 0 }, 86_400_000, 'second');
    const data = new CuriosityAnalyzer([first, second], new Map()).getCuriosity();
    expect(data.balance.tier).toBe('insufficient');
    expect(data.weeklyChecks[0].repeatedGroups).toBe(1);
    expect(curiosityAntiPatterns(data)).toMatchObject([{
      id: 'curiosity-repeated-wording', group: 'prompt-quality', severity: 'low', occurrences: 1, aggregate: true,
      examples: [expect.stringContaining('2 occurrences across 2 sessions')],
    }]);
    expect(curiosityAntiPatterns(data)[0].description).toContain('not semantic similarity or proof of forgetting');
    expect(curiosityPatternContribution(data).weekly).toMatchObject([{ severity: 'low', occurrences: 1 }]);
  });
});
