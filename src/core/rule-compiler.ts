/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * NL Rule Compiler: converts natural-language rule descriptions into DSL
 * filter/trigger expressions by prompting an LLM.
 *
 * Uses the VS Code Language Model API when available, otherwise falls back
 * to a simple template-based heuristic.
 */

import { FIELD_SCHEMA, FUNCTION_CATALOG } from './dsl/index';
import { parseRule } from './rule-parser';
import type { DetectionRule } from './types/rule-types';
import { listCandidateModels } from './llm-models';

/**
 * Result of compiling a natural-language description into a rule.
 */
export interface CompilationResult {
  /** The generated rule markdown */
  markdown: string;
  /** Parsed rule (null if generation produced invalid markdown) */
  rule: DetectionRule | null;
  /** Whether LLM was used (vs heuristic fallback) */
  usedLlm: boolean;
  /** Any warnings/notes */
  notes: string[];
}

/**
 * Compile a natural-language description into a rule markdown file.
 *
 * If a VS Code Language Model is available, it uses the LLM to generate
 * the filter/trigger expressions. Otherwise, it falls back to a heuristic
 * template that scaffolds the right structure for manual editing.
 */
export async function compileNaturalLanguageRule(
  prompt: string,
  options?: {
    group?: string;
    severity?: string;
    scope?: string;
  },
): Promise<CompilationResult> {
  const notes: string[] = [];

  // Try LLM compilation first
  try {
    const markdown = await compileLlm(prompt, options);
    if (markdown) {
      const rule = parseRule(markdown);
      if (rule) return { markdown, rule, usedLlm: true, notes };
      notes.push('LLM produced invalid rule markdown; falling back to heuristic.');
    }
  } catch (err) {
    notes.push(`LLM unavailable: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  // Heuristic fallback
  const markdown = compileHeuristic(prompt, options);
  const rule = parseRule(markdown);
  return { markdown, rule, usedLlm: false, notes };
}

/* ---- LLM-based compilation ---- */

async function compileLlm(
  prompt: string,
  options?: { group?: string; severity?: string; scope?: string },
): Promise<string | null> {
  // Dynamic import to avoid bundling vscode types
  let vscode: typeof import('vscode');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vscode = require('vscode') as typeof import('vscode');
  } catch {
    return null;
  }

  if (!vscode.lm) return null;

  let candidates: import('vscode').LanguageModelChat[];
  try {
    candidates = await listCandidateModels();
  } catch {
    return null;
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(prompt, options);

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];

  // Iterate candidates so a model that is disabled for the plan/organization
  // (which returns an empty response) transparently falls through to the next.
  for (const model of candidates) {
    const response = await model.sendRequest(messages, {});
    let result = '';
    for await (const chunk of response.text) {
      result += chunk;
    }
    if (result.trim().length === 0) continue;

    // Extract markdown from code block if wrapped
    const fenced = result.match(/```(?:markdown)?\s*\n([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    if (result.includes('---')) return result.trim();
    return null;
  }
  return null;
}

function buildSystemPrompt(): string {
  const fields = FIELD_SCHEMA.map(f => `  ${f.name}: ${f.type} — ${f.description}`).join('\n');
  const functions = FUNCTION_CATALOG.map(f => `  ${f.signature} — ${f.description}`).join('\n');

  return `You are a rule compiler for AI Engineer Coach, a VS Code extension that analyzes coding assistant usage patterns.

Your job: convert natural-language descriptions into structured rule markdown files.

Available fields for filter expressions (scope: request or session):
${fields}

Available DSL functions:
${functions}

Filter expressions use this syntax:
  field op value [AND|OR field op value ...]
  Operators: < > <= >= == !=
  Functions: contains(field, "value"), matches(field, "/regex/"), startsWith(field, "prefix")
  Logical: AND, OR, NOT
  Field access: field.subfield, array.length

Trigger expressions evaluate against aggregated results:
  Variables: count, total, ratio, extra.*
  Example: ratio > 0.3 AND count > 5

Output ONLY the complete .md file with YAML frontmatter and all sections. No explanation.

Rule format:
---
id: kebab-case-id
name: Human Name
group: prompt-quality|session-hygiene|code-review|tool-mastery
severity: low|medium|high
scope: requests|sessions
version: 1
tags: [tag1, tag2]
thresholds:
  keyName: numericValue
---

# Description
What this rule detects.

# Filter
DSL expression using fields above and {{thresholds.keyName}} for threshold references.

# Trigger
DSL expression over aggregated results (count, total, ratio).

# When Triggered
Template with {{count}}, {{total}}, {{pct}} placeholders.

# How to Improve
Actionable advice.

# Examples
"{{messageText | truncate:80}}" or similar template.

# Test Cases
- input: { "field": value }
  expect: flagged
- input: { "field": value }
  expect: clean`;
}

function buildUserPrompt(prompt: string, options?: { group?: string; severity?: string; scope?: string }): string {
  let text = `Create a rule for: ${prompt}`;
  if (options?.group) text += `\nGroup: ${options.group}`;
  if (options?.severity) text += `\nSeverity: ${options.severity}`;
  if (options?.scope) text += `\nScope: ${options.scope}`;
  return text;
}

/* ---- Heuristic fallback ---- */

function compileHeuristic(
  prompt: string,
  options?: { group?: string; severity?: string; scope?: string },
): string {
  const id = prompt
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .substring(0, 40) || 'custom-rule';

  const name = prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt;
  const group = options?.group || guessGroup(prompt);
  const severity = options?.severity || 'medium';
  const scope = options?.scope || guessScope(prompt);
  const { filterExpr, triggerExpr, thresholds } = guessExpressions(prompt, scope);

  const lines = [
    '---',
    `id: ${id}`,
    `name: ${name}`,
    `group: ${group}`,
    `severity: ${severity}`,
    `scope: ${scope}`,
    'version: 1',
    `tags: [custom]`,
    'thresholds:',
  ];
  for (const [k, v] of Object.entries(thresholds)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push('---', '');
  lines.push('# Description');
  lines.push(prompt);
  lines.push('');
  lines.push('# Filter');
  lines.push(filterExpr);
  lines.push('');
  lines.push('# Trigger');
  lines.push(triggerExpr);
  lines.push('');
  lines.push('# When Triggered');
  lines.push(`{{count}} of {{total}} items ({{pct}}) match this pattern.`);
  lines.push('');
  lines.push('# How to Improve');
  lines.push('Review the flagged items and adjust your workflow accordingly.');
  lines.push('');
  lines.push('# Examples');
  lines.push('"{{messageText | truncate:80}}"');
  lines.push('');
  lines.push('# Test Cases');
  lines.push(`- input: { "messageLength": 10 }`);
  lines.push('  expect: flagged');
  lines.push(`- input: { "messageLength": 200 }`);
  lines.push('  expect: clean');

  return lines.join('\n');
}

function guessGroup(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/session|long|mega|cancel|night|weekend|abandon/i.test(lower)) return 'session-hygiene';
  if (/code|review|accept|copy|paste|language|markdown/i.test(lower)) return 'code-review';
  if (/model|tool|skill|instruction|command|premium/i.test(lower)) return 'tool-mastery';
  return 'prompt-quality';
}

function guessScope(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/session|workspace|project/i.test(lower)) return 'sessions';
  return 'requests';
}

function guessExpressions(prompt: string, scope: string): {
  filterExpr: string;
  triggerExpr: string;
  thresholds: Record<string, number>;
} {
  const lower = prompt.toLowerCase();

  // Try to match common patterns
  if (/short|lazy|brief|terse/i.test(lower)) {
    return {
      filterExpr: 'messageLength < {{thresholds.maxLength}} AND messageLength > 0',
      triggerExpr: 'ratio > {{thresholds.maxRatio}} AND count > {{thresholds.minSample}}',
      thresholds: { maxLength: 30, maxRatio: 0.3, minSample: 5 },
    };
  }
  if (/cancel/i.test(lower)) {
    return {
      filterExpr: 'isCanceled == true',
      triggerExpr: 'ratio > {{thresholds.maxRate}}',
      thresholds: { maxRate: 0.2 },
    };
  }
  if (/night|late/i.test(lower)) {
    return {
      filterExpr: 'hour(timestamp) >= {{thresholds.startHour}} OR hour(timestamp) < {{thresholds.endHour}}',
      triggerExpr: 'count > {{thresholds.minCount}}',
      thresholds: { startHour: 22, endHour: 6, minCount: 5 },
    };
  }
  if (/weekend/i.test(lower)) {
    return {
      filterExpr: 'dayOfWeek(timestamp) == 0 OR dayOfWeek(timestamp) == 6',
      triggerExpr: 'ratio > {{thresholds.maxRate}} AND count > {{thresholds.minCount}}',
      thresholds: { maxRate: 0.1, minCount: 3 },
    };
  }
  if (/no\s*(file|context|reference)/i.test(lower)) {
    return {
      filterExpr: 'referencedFiles.length == 0 AND editedFiles.length == 0',
      triggerExpr: 'ratio > {{thresholds.maxRate}} AND count > {{thresholds.minSample}}',
      thresholds: { maxRate: 0.5, minSample: 5 },
    };
  }
  if (/long|mega/i.test(lower) && scope === 'sessions') {
    return {
      filterExpr: 'requestCount > {{thresholds.maxRequests}}',
      triggerExpr: 'count > 0',
      thresholds: { maxRequests: 40 },
    };
  }
  if (/tool|agent/i.test(lower)) {
    return {
      filterExpr: 'agentMode == "agent" AND toolsUsed.length == 0',
      triggerExpr: 'count > {{thresholds.minCount}}',
      thresholds: { minCount: 3 },
    };
  }

  // Generic fallback
  return {
    filterExpr: 'messageLength > 0',
    triggerExpr: 'ratio > {{thresholds.maxRatio}} AND count > {{thresholds.minSample}}',
    thresholds: { maxRatio: 0.3, minSample: 5 },
  };
}
