/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { activityCount, inquiryCount, type ActivityCounts } from './curiosity-activity';
import type { CuriosityBalance } from './types/curiosity-types';

export const CURIOSITY_BALANCE_THRESHOLDS = {
  minTurns: 50, minDays: 7, minCoverage: 0.7, lowInquiry: 0.05, highInquiry: 0.95,
  suggestedLowInquiry: 0.1, suggestedHighInquiry: 0.5, minInquiries: 20, maxInvestigationShare: 0.8,
  strongInvestigationShare: 0.95,
} as const;

export function curiosityBalance(counts: ActivityCounts, human: number, days: number): CuriosityBalance {
  const total = activityCount(counts);
  const thresholds = CURIOSITY_BALANCE_THRESHOLDS;
  const result: CuriosityBalance = {
    status: 'insufficient', tier: 'insufficient', workStatus: 'insufficient', investigationStatus: 'insufficient',
    activeDays: days, thresholds, warnings: [],
  };
  if (human <= 0 || total < thresholds.minTurns || days < thresholds.minDays || total / human < thresholds.minCoverage) {
    return result;
  }
  const inquiries = inquiryCount(counts);
  const share = inquiries / total;
  if (share < thresholds.lowInquiry) result.warnings.push({
    id: 'little-inquiry', title: 'Little inquiry recorded',
    recommendation: 'If understanding is a goal, ask why a change works before accepting it. Learning during project work may not appear as inquiry.',
  });
  else if (share < thresholds.suggestedLowInquiry) result.warnings.push({
    id: 'build-heavy', title: 'Project work dominates',
    recommendation: 'For mixed coding work, consider asking how a change works before the next task execution. An implementation-only period can be intentional.',
  });
  else if (share > thresholds.highInquiry) result.warnings.push({
    id: 'little-execution', title: 'Little execution recorded',
    recommendation: 'If application is a goal, try one explanation in a small task. A research-only period can be intentional.',
  });
  else if (share > thresholds.suggestedHighInquiry) result.warnings.push({
    id: 'inquiry-heavy', title: 'Inquiry outweighs project work',
    recommendation: 'For mixed coding work, try an explanation in a small implementation or test. A research-focused period can be intentional.',
  });
  result.workStatus = result.warnings.length ? 'flagged' : 'clear';
  if (inquiries >= thresholds.minInquiries) {
    result.investigationStatus = 'clear';
    for (const activity of ['direct', 'web', 'repository'] as const) {
      if (counts[activity] / inquiries <= thresholds.maxInvestigationShare) continue;
      result.investigationStatus = 'flagged';
      result.warnings.push({
        id: 'investigation-concentrated', activity,
        title: 'One investigation type dominates',
        recommendation: activity === 'direct'
          ? 'For mixed coding work, check a model explanation against relevant documentation or code. Recorded sources do not prove an answer is correct.'
          : activity === 'web'
            ? 'For mixed coding work, connect external guidance to the code you are changing. Web research alone can be appropriate for a new topic.'
            : 'For mixed coding work, use external documentation when the code depends on unfamiliar APIs. Repository-only investigation can be appropriate.',
      });
    }
  }
  result.status = result.warnings.length ? 'flagged' : 'clear';
  const stronglySkewed = share < thresholds.lowInquiry || share > thresholds.highInquiry
    || inquiries >= thresholds.minInquiries
      && Math.max(counts.direct, counts.web, counts.repository) / inquiries > thresholds.strongInvestigationShare;
  result.tier = stronglySkewed ? 'strongly-skewed' : result.warnings.length ? 'needs-review'
    : result.investigationStatus === 'insufficient' ? 'insufficient' : 'balanced';
  return result;
}
