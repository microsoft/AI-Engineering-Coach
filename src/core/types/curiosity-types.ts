/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActivityCounts, CuriosityActivity, UnclassifiedReason } from '../curiosity-activity';
import type { CURIOSITY_BALANCE_THRESHOLDS } from '../curiosity-balance';
import type { DateFilter } from './session-types';

export type CuriosityTier = 'balanced' | 'needs-review' | 'strongly-skewed' | 'insufficient';
export const CURIOSITY_TIER_LABELS: Record<CuriosityTier, string> = {
  balanced: 'Balanced', 'needs-review': 'Needs review',
  'strongly-skewed': 'Strongly skewed', insufficient: 'More evidence needed',
};
export interface CuriosityFilter extends DateFilter { language?: string }
export interface CuriositySession {
  sessionId: string;
  requestId: string;
  workspaceId: string;
  name: string;
  promptPreview: string;
  promptTruncated: boolean;
  date: string;
  timestamp: number;
  workspace: string;
  harness: string;
  context?: { kind: 'web' | 'repository'; label: string; turns: number }[];
}
export interface CuriosityBalance {
  status: 'insufficient' | 'clear' | 'flagged';
  tier: CuriosityTier;
  workStatus: 'insufficient' | 'clear' | 'flagged';
  investigationStatus: 'insufficient' | 'clear' | 'flagged';
  activeDays: number;
  thresholds: typeof CURIOSITY_BALANCE_THRESHOLDS;
  warnings: {
    id: 'little-inquiry' | 'little-execution' | 'build-heavy' | 'inquiry-heavy' | 'investigation-concentrated';
    title: string;
    recommendation: string;
    activity?: Exclude<CuriosityActivity, 'action'>;
  }[];
}
export interface CuriosityExample extends CuriositySession { text: string }
export type InvestigationSource = 'web' | 'repository' | 'delegated';
export interface CuriosityData {
  counts: ActivityCounts;
  coverage: {
    human: number; classified: number; excluded: number; unscanned: number; unclassified: number;
    duplicates: number; withoutLanguage: number; legacyAnswers: number;
    reasons: Record<UnclassifiedReason, number>;
  };
  sessions: number;
  sessionCounts: { human: number; inquiry: number; action: number; mixed: number };
  research: Record<InvestigationSource, { turns: number; sessions: number; withinAction: number;
    sessionSamples: CuriositySession[] }>;
  questionLedActions: number;
  daily: { date: string; counts: ActivityCounts; sessions?: Record<CuriosityActivity, CuriositySession[]> }[];
  languages: { language: string; sessions: number; inquirySessions: number; files: number; counts: ActivityCounts;
    sessionSamples: CuriositySession[] }[];
  balance: CuriosityBalance;
  weeklyChecks: { week: string; balance: CuriosityBalance; repeatedGroups: number }[];
  chains: { total: number; sustained: number; exchanges: number;
    examples: { exchanges: number; session: CuriositySession; elapsedMs?: number }[] };
  evidence: Record<CuriosityActivity, CuriositySession[]>;
  repeated: { text: string; count: number; sessions: number; example: CuriosityExample }[];
}
