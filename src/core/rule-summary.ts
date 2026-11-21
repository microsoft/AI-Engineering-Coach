/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DetectionRule } from './types';

/** The `# Description` of a rule that has none. */
export function defaultRuleDescription(name: string): string {
  return `Detects ${name.toLowerCase()} patterns.`;
}

/**
 * The static text that describes a rule in the Rules list and in its detail: its `# Description`. Only a finding
 * fills the When Triggered template, because only a finding has its numbers. A Description that is empty or holds a
 * template placeholder gives the default text instead, so a placeholder never shows.
 */
export function ruleSummary(rule: Pick<DetectionRule, 'name' | 'description'>): string {
  const description = rule.description.trim();
  return description && !/\{\{[^}]+\}\}/.test(description) ? description : defaultRuleDescription(rule.name);
}
