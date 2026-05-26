/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AntiPattern, DetectionRule, DetectorEmission, PracticeGroup, Session, SessionRequest } from './types';

let ruleEngine: typeof import('./rule-engine');

interface RuleOptions {
  id?: string;
  name?: string;
  severity?: 'high' | 'medium' | 'low';
  group?: PracticeGroup;
  scope?: 'requests' | 'sessions' | 'both';
  requiresIdeContext?: boolean;
  thresholds?: Record<string, number>;
  description?: string;
  descriptionTemplate?: string;
  suggestionTemplate?: string;
  filter?: string;
  trigger?: string;
}

function makeRuleMarkdown(options: RuleOptions = {}): string {
  const {
    id = 'test-rule',
    name = 'Test Rule',
    severity = 'medium',
    group = 'prompt-quality',
    scope = 'requests',
    requiresIdeContext = false,
    thresholds = { minChars: 10, maxRatio: 0.3 },
    description = 'Detects very short prompts.',
    descriptionTemplate = '{{count}} of {{total}} prompts ({{pct}}) are very short.',
    suggestionTemplate = 'Write more detailed prompts.',
    filter = 'messageLength < thresholds.minChars',
    trigger = 'ratio > thresholds.maxRatio',
  } = options;

  const lines = [
    '---',
    `id: ${id}`,
    `name: ${name}`,
    `severity: ${severity}`,
    `group: ${group}`,
    `scope: ${scope}`,
  ];

  if (requiresIdeContext) {
    lines.push('requiresIdeContext: true');
  }

  if (Object.keys(thresholds).length > 0) {
    lines.push('thresholds:');
    for (const [key, value] of Object.entries(thresholds)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  return `${lines.join('\n')}
---

# Description
${description}

# When Triggered
${descriptionTemplate}

# How to Improve
${suggestionTemplate}

# Detection Logic
\`\`\`detect
filter: ${filter}
check: ${trigger}
\`\`\`
`;
}

function makeRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    messageText: 'Explain the bug and propose a fix.',
    responseText: 'Here is a fix.',
    isCanceled: false,
    agentName: 'agent',
    agentMode: 'chat',
    modelId: 'gpt-4.1',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: 100,
    totalElapsed: 1000,
    messageLength: 35,
    responseLength: 25,
    userCode: [],
    aiCode: [],
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    workType: 'feature',
    ...overrides,
  };
}

function makeSession(requests: SessionRequest[], overrides: Partial<Session> = {}): Session {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'ws-1',
    workspaceName: 'workspace',
    location: 'panel',
    harness: 'Copilot CLI',
    creationDate: Date.now() - 1000,
    lastMessageDate: Date.now(),
    requestCount: requests.length,
    requests,
    ...overrides,
  };
}

function makeAntiPattern(id: string, overrides: Partial<AntiPattern> = {}): AntiPattern {
  return {
    id,
    name: `${id} name`,
    severity: 'medium',
    group: 'prompt-quality',
    occurrences: 2,
    description: `${id} triggered`,
    suggestion: 'Improve it.',
    examples: ['example 1'],
    details: [],
    weeklyHist: { labels: [], counts: [] },
    ...overrides,
  };
}

function makeEmission(overrides: Partial<DetectorEmission> = {}): DetectorEmission {
  return {
    count: 2,
    total: 5,
    ratio: 0.4,
    examples: ['short prompt'],
    extra: { avgGap: 1.25 },
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  ruleEngine = await import('./rule-engine');
  ruleEngine.clearLayerRules('personal');
  ruleEngine.clearLayerRules('project');
});

describe('rule-engine', () => {
  describe('registerBuiltinRuleSource + loadBuiltinRules', () => {
    it('registers and parses a valid built-in rule source', () => {
      ruleEngine.registerBuiltinRuleSource('built-in-short', makeRuleMarkdown({ id: 'built-in-short' }));

      const rules = ruleEngine.loadBuiltinRules();

      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        id: 'built-in-short',
        name: 'Test Rule',
        source: 'built-in',
        sourceFilePath: '',
      });
    });

    it('skips invalid built-in rule sources', () => {
      ruleEngine.registerBuiltinRuleSource('broken', 'not valid markdown');

      expect(ruleEngine.loadBuiltinRules()).toEqual([]);
    });

    it('returns the cached built-in rule list on repeated calls', () => {
      ruleEngine.registerBuiltinRuleSource('cached-rule', makeRuleMarkdown({ id: 'cached-rule' }));

      const first = ruleEngine.loadBuiltinRules();
      const second = ruleEngine.loadBuiltinRules();

      expect(second).toBe(first);
    });
  });

  describe('personal and project rule sources', () => {
    it('registers a personal rule source and exposes it via getAllRules', () => {
      ruleEngine.registerPersonalRuleSource('personal-rule', makeRuleMarkdown({ id: 'personal-rule' }), '/personal/personal-rule.md');

      expect(ruleEngine.getAllRules()).toEqual([
        expect.objectContaining({
          id: 'personal-rule',
          source: 'personal',
          sourceFilePath: '/personal/personal-rule.md',
        }),
      ]);
    });

    it('registers a project rule source and exposes it via getAllRules', () => {
      ruleEngine.registerProjectRuleSource('project-rule', makeRuleMarkdown({ id: 'project-rule' }), '/project/project-rule.md');

      expect(ruleEngine.getAllRules()).toEqual([
        expect.objectContaining({
          id: 'project-rule',
          source: 'project',
          sourceFilePath: '/project/project-rule.md',
        }),
      ]);
    });

    it('includes rules from multiple layers together', () => {
      ruleEngine.registerBuiltinRuleSource('built-in-rule', makeRuleMarkdown({ id: 'built-in-rule' }));
      ruleEngine.registerPersonalRuleSource('personal-rule', makeRuleMarkdown({ id: 'personal-rule' }), '/personal/personal-rule.md');
      ruleEngine.registerProjectRuleSource('project-rule', makeRuleMarkdown({ id: 'project-rule' }), '/project/project-rule.md');

      const ids = ruleEngine.getAllRules().map(rule => rule.id).sort();

      expect(ids).toEqual(['built-in-rule', 'personal-rule', 'project-rule']);
    });
  });

  describe('clearLayerRules', () => {
    it('clears personal rules', () => {
      ruleEngine.registerPersonalRuleSource('personal-rule', makeRuleMarkdown({ id: 'personal-rule' }), '/personal/personal-rule.md');

      ruleEngine.clearLayerRules('personal');

      expect(ruleEngine.getAllRules()).toEqual([]);
    });

    it('clears project rules', () => {
      ruleEngine.registerProjectRuleSource('project-rule', makeRuleMarkdown({ id: 'project-rule' }), '/project/project-rule.md');

      ruleEngine.clearLayerRules('project');

      expect(ruleEngine.getAllRules()).toEqual([]);
    });

    it('clearing one layer preserves rules from the other layer', () => {
      ruleEngine.registerPersonalRuleSource('personal-rule', makeRuleMarkdown({ id: 'personal-rule' }), '/personal/personal-rule.md');
      ruleEngine.registerProjectRuleSource('project-rule', makeRuleMarkdown({ id: 'project-rule' }), '/project/project-rule.md');

      ruleEngine.clearLayerRules('personal');

      expect(ruleEngine.getAllRules()).toEqual([
        expect.objectContaining({ id: 'project-rule', source: 'project' }),
      ]);
    });
  });

  describe('getAllRules precedence', () => {
    it('uses the built-in rule when there is no override', () => {
      ruleEngine.registerBuiltinRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Built-in Rule' }));

      expect(ruleEngine.getRule('shared-rule')).toMatchObject({ name: 'Built-in Rule', source: 'built-in' });
    });

    it('prefers personal rules over built-in rules with the same id', () => {
      ruleEngine.registerBuiltinRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Built-in Rule' }));
      ruleEngine.registerPersonalRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Personal Rule' }), '/personal/shared-rule.md');

      expect(ruleEngine.getRule('shared-rule')).toMatchObject({ name: 'Personal Rule', source: 'personal' });
    });

    it('prefers project rules over personal and built-in rules with the same id', () => {
      ruleEngine.registerBuiltinRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Built-in Rule' }));
      ruleEngine.registerPersonalRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Personal Rule' }), '/personal/shared-rule.md');
      ruleEngine.registerProjectRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Project Rule' }), '/project/shared-rule.md');

      expect(ruleEngine.getRule('shared-rule')).toMatchObject({ name: 'Project Rule', source: 'project' });
    });

    it('keeps distinct ids from every layer', () => {
      ruleEngine.registerBuiltinRuleSource('built-in-rule', makeRuleMarkdown({ id: 'built-in-rule' }));
      ruleEngine.registerPersonalRuleSource('personal-rule', makeRuleMarkdown({ id: 'personal-rule' }), '/personal/personal-rule.md');
      ruleEngine.registerProjectRuleSource('project-rule', makeRuleMarkdown({ id: 'project-rule' }), '/project/project-rule.md');

      expect(ruleEngine.getAllRules()).toHaveLength(3);
    });
  });

  describe('getRule', () => {
    it('finds a rule by id', () => {
      ruleEngine.registerBuiltinRuleSource('find-me', makeRuleMarkdown({ id: 'find-me' }));

      expect(ruleEngine.getRule('find-me')).toMatchObject({ id: 'find-me' });
    });

    it('returns undefined for a missing rule id', () => {
      expect(ruleEngine.getRule('missing-rule')).toBeUndefined();
    });
  });

  describe('setUserRule', () => {
    it('adds a new in-memory rule override', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({ id: 'user-rule', name: 'User Rule' }));
      expect(rule).not.toBeNull();

      ruleEngine.setUserRule(rule!);

      expect(ruleEngine.getRule('user-rule')).toMatchObject({ id: 'user-rule', name: 'User Rule', source: 'personal' });
    });

    it('overrides an existing layer rule by id', () => {
      ruleEngine.registerProjectRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Project Rule' }), '/project/shared-rule.md');
      const override = ruleEngine.parseRule(makeRuleMarkdown({ id: 'shared-rule', name: 'Override Rule' }));
      expect(override).not.toBeNull();

      ruleEngine.setUserRule(override!);

      expect(ruleEngine.getRule('shared-rule')).toMatchObject({ name: 'Override Rule' });
    });

    it('changes a built-in source override to personal', () => {
      ruleEngine.registerBuiltinRuleSource('built-in-rule', makeRuleMarkdown({ id: 'built-in-rule' }));
      const builtinRule = ruleEngine.getRule('built-in-rule');
      expect(builtinRule).toBeDefined();

      ruleEngine.setUserRule({ ...builtinRule! });

      expect(ruleEngine.getRule('built-in-rule')).toMatchObject({ source: 'personal' });
    });

    it('replaces an existing in-memory override with the same id', () => {
      const first = ruleEngine.parseRule(makeRuleMarkdown({ id: 'user-rule', name: 'First Override' }));
      const second = ruleEngine.parseRule(makeRuleMarkdown({ id: 'user-rule', name: 'Second Override' }));
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      ruleEngine.setUserRule(first!);
      ruleEngine.setUserRule(second!);

      expect(ruleEngine.getRule('user-rule')).toMatchObject({ name: 'Second Override' });
    });
  });

  describe('removeUserRule', () => {
    it('removes an in-memory override and returns true', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({ id: 'user-rule' }));
      expect(rule).not.toBeNull();
      ruleEngine.setUserRule(rule!);

      expect(ruleEngine.removeUserRule('user-rule')).toBe(true);
      expect(ruleEngine.getRule('user-rule')).toBeUndefined();
    });

    it('returns false when removing a missing override', () => {
      expect(ruleEngine.removeUserRule('missing-rule')).toBe(false);
    });

    it('reveals the underlying layer rule after removing an override', () => {
      ruleEngine.registerBuiltinRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Built-in Rule' }));
      const override = ruleEngine.parseRule(makeRuleMarkdown({ id: 'shared-rule', name: 'User Override' }));
      expect(override).not.toBeNull();
      ruleEngine.setUserRule(override!);

      ruleEngine.removeUserRule('shared-rule');

      expect(ruleEngine.getRule('shared-rule')).toMatchObject({ name: 'Built-in Rule', source: 'built-in' });
    });
  });

  describe('updateRuleThresholds', () => {
    it('updates thresholds on an existing rule', () => {
      ruleEngine.registerBuiltinRuleSource('threshold-rule', makeRuleMarkdown({ id: 'threshold-rule', thresholds: { minChars: 10, maxRatio: 0.3 } }));

      const updated = ruleEngine.updateRuleThresholds('threshold-rule', { minChars: 20 });

      expect(updated).toMatchObject({ thresholds: { minChars: 20, maxRatio: 0.3 } });
    });

    it('converts built-in threshold overrides to personal rules', () => {
      ruleEngine.registerBuiltinRuleSource('threshold-rule', makeRuleMarkdown({ id: 'threshold-rule' }));

      const updated = ruleEngine.updateRuleThresholds('threshold-rule', { maxRatio: 0.5 });

      expect(updated).toMatchObject({ source: 'personal' });
      expect(ruleEngine.getRule('threshold-rule')).toMatchObject({ source: 'personal' });
    });

    it('preserves personal source when updating a personal rule', () => {
      ruleEngine.registerPersonalRuleSource('threshold-rule', makeRuleMarkdown({ id: 'threshold-rule' }), '/personal/threshold-rule.md');

      const updated = ruleEngine.updateRuleThresholds('threshold-rule', { maxRatio: 0.5 });

      expect(updated).toMatchObject({ source: 'personal' });
    });

    it('returns null for a missing rule', () => {
      expect(ruleEngine.updateRuleThresholds('missing-rule', { maxRatio: 0.5 })).toBeNull();
    });
  });

  describe('createRuleFromMarkdown', () => {
    it('creates a rule from valid markdown and stores it as a personal rule', () => {
      const created = ruleEngine.createRuleFromMarkdown(makeRuleMarkdown({ id: 'created-rule', name: 'Created Rule' }));

      expect(created).toMatchObject({
        id: 'created-rule',
        name: 'Created Rule',
        source: 'personal',
        sourceFilePath: '',
      });
      expect(ruleEngine.getRule('created-rule')).toMatchObject({ id: 'created-rule' });
    });

    it('returns null for invalid markdown', () => {
      expect(ruleEngine.createRuleFromMarkdown('totally invalid')).toBeNull();
    });

    it('allows created rules to override existing built-in rules', () => {
      ruleEngine.registerBuiltinRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Built-in Rule' }));

      ruleEngine.createRuleFromMarkdown(makeRuleMarkdown({ id: 'shared-rule', name: 'Created Override' }));

      expect(ruleEngine.getRule('shared-rule')).toMatchObject({ name: 'Created Override', source: 'personal' });
    });
  });

  describe('getRuleSource', () => {
    it('returns the raw markdown source for an existing rule', () => {
      const markdown = makeRuleMarkdown({ id: 'source-rule' });
      ruleEngine.registerBuiltinRuleSource('source-rule', markdown);

      expect(ruleEngine.getRuleSource('source-rule')).toBe(markdown);
    });

    it('returns updated serialized source for threshold overrides', () => {
      ruleEngine.registerBuiltinRuleSource('threshold-rule', makeRuleMarkdown({ id: 'threshold-rule', thresholds: { minChars: 10, maxRatio: 0.3 } }));
      ruleEngine.updateRuleThresholds('threshold-rule', { minChars: 20 });

      const source = ruleEngine.getRuleSource('threshold-rule');

      expect(source).toContain('minChars: 20');
      expect(source).toContain('maxRatio: 0.3');
    });

    it('returns null for a missing rule', () => {
      expect(ruleEngine.getRuleSource('missing-rule')).toBeNull();
    });
  });

  describe('evaluateRule', () => {
    it('returns a not-triggered result for a null emission', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({ id: 'eval-rule' }))!;

      expect(ruleEngine.evaluateRule(rule, null)).toMatchObject({
        ruleId: 'eval-rule',
        triggered: false,
        occurrences: 0,
        total: 0,
        ratio: 0,
        severity: rule.severity,
        description: '',
        suggestion: '',
        examples: [],
      });
    });

    it('returns a not-triggered result for a zero-count emission', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({ id: 'eval-rule' }))!;

      expect(ruleEngine.evaluateRule(rule, makeEmission({ count: 0, ratio: 0 }))).toMatchObject({
        triggered: false,
        occurrences: 0,
        total: 0,
        ratio: 0,
      });
    });

    it('fills description and suggestion templates for triggered rules', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({
        id: 'eval-rule',
        descriptionTemplate: '{{count}} of {{total}} prompts ({{pct}}) are short; avg gap {{extra.avgGap}}.',
        suggestionTemplate: 'Add context to reduce the {{pct}} short-prompt rate.',
      }))!;

      const result = ruleEngine.evaluateRule(rule, makeEmission());

      expect(result).toMatchObject({
        triggered: true,
        occurrences: 2,
        total: 5,
        ratio: 0.4,
        description: '2 of 5 prompts (40%) are short; avg gap 1.3.',
        suggestion: 'Add context to reduce the 40% short-prompt rate.',
        examples: ['short prompt'],
      });
      expect(result.templateVars).toEqual({ count: 2, total: 5, ratio: 0.4, pct: '40%', extra: { avgGap: 1.25 } });
    });

    it('respects dynamic severity from the emission', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({ id: 'eval-rule', severity: 'low' }))!;

      expect(ruleEngine.evaluateRule(rule, makeEmission({ dynamicSeverity: 'high' })).severity).toBe('high');
    });

    it('falls back to a default description when no template is provided', () => {
      const rule: DetectionRule = { ...ruleEngine.parseRule(makeRuleMarkdown({ id: 'eval-rule' }))!, descriptionTemplate: '' };

      expect(ruleEngine.evaluateRule(rule, makeEmission()).description).toBe('2 occurrences');
    });

    it('falls back to an empty suggestion when no template is provided', () => {
      const rule: DetectionRule = { ...ruleEngine.parseRule(makeRuleMarkdown({ id: 'eval-rule' }))!, suggestionTemplate: '' };

      expect(ruleEngine.evaluateRule(rule, makeEmission()).suggestion).toBe('');
    });

    it('reports a 0% pct when total is zero but count is positive', () => {
      const rule = ruleEngine.parseRule(makeRuleMarkdown({
        id: 'eval-rule',
        descriptionTemplate: '{{count}} hits ({{pct}}).',
      }))!;

      const result = ruleEngine.evaluateRule(rule, makeEmission({ count: 3, total: 0, ratio: 0 }));

      expect(result.triggered).toBe(true);
      expect(result.description).toBe('3 hits (0%).');
      expect(result.templateVars.pct).toBe('0%');
    });
  });

  describe('getRulesGrouped', () => {
    it('returns all practice-group keys', () => {
      expect(ruleEngine.getRulesGrouped()).toEqual({
        'prompt-quality': [],
        'session-hygiene': [],
        'code-review': [],
        'tool-mastery': [],
        'context-management': [],
      });
    });

    it('groups rules under their practice group', () => {
      ruleEngine.registerBuiltinRuleSource('prompt-rule', makeRuleMarkdown({ id: 'prompt-rule', group: 'prompt-quality' }));
      ruleEngine.registerBuiltinRuleSource('tool-rule', makeRuleMarkdown({ id: 'tool-rule', group: 'tool-mastery' }));

      const grouped = ruleEngine.getRulesGrouped();

      expect(grouped['prompt-quality'].map(rule => rule.id)).toEqual(['prompt-rule']);
      expect(grouped['tool-mastery'].map(rule => rule.id)).toEqual(['tool-rule']);
    });

    it('includes only the highest-precedence version of an overridden rule', () => {
      ruleEngine.registerBuiltinRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Built-in Rule' }));
      ruleEngine.registerProjectRuleSource('shared-rule', makeRuleMarkdown({ id: 'shared-rule', name: 'Project Rule' }), '/project/shared-rule.md');

      const grouped = ruleEngine.getRulesGrouped();

      expect(grouped['prompt-quality']).toHaveLength(1);
      expect(grouped['prompt-quality'][0]).toMatchObject({ name: 'Project Rule', source: 'project' });
    });
  });

  describe('getRulePreviewStats', () => {
    it('returns preview stats for all rules', () => {
      ruleEngine.registerBuiltinRuleSource('request-rule', makeRuleMarkdown({ id: 'request-rule', scope: 'requests' }));
      ruleEngine.registerBuiltinRuleSource('session-rule', makeRuleMarkdown({ id: 'session-rule', scope: 'sessions', filter: 'requestCount > 1', trigger: 'count > 0' }));
      const requests = [makeRequest(), makeRequest()];
      const sessions = [makeSession(requests)];

      const stats = ruleEngine.getRulePreviewStats(requests, sessions, false, []);

      expect(stats.map(stat => stat.ruleId).sort()).toEqual(['request-rule', 'session-rule']);
    });

    it('respects skipIdeDetectors by excluding IDE-only rules', () => {
      ruleEngine.registerBuiltinRuleSource('ide-rule', makeRuleMarkdown({ id: 'ide-rule', requiresIdeContext: true }));
      ruleEngine.registerBuiltinRuleSource('normal-rule', makeRuleMarkdown({ id: 'normal-rule' }));
      const requests = [makeRequest()];
      const sessions = [makeSession(requests)];

      const stats = ruleEngine.getRulePreviewStats(requests, sessions, true, []);

      expect(stats.map(stat => stat.ruleId)).toEqual(['normal-rule']);
    });

    it('uses detector results for triggered state, descriptions, and examples', () => {
      ruleEngine.registerBuiltinRuleSource('preview-rule', makeRuleMarkdown({ id: 'preview-rule' }));
      const requests = [makeRequest(), makeRequest()];
      const sessions = [makeSession(requests)];

      const stats = ruleEngine.getRulePreviewStats(requests, sessions, false, [
        makeAntiPattern('preview-rule', {
          occurrences: 3,
          description: 'Preview description',
          examples: ['preview example'],
        }),
      ]);

      expect(stats[0]).toMatchObject({
        ruleId: 'preview-rule',
        triggered: true,
        occurrences: 3,
        previewDescription: 'Preview description',
        previewExamples: ['preview example'],
      });
    });

    it('uses emissions to override occurrences and totals', () => {
      ruleEngine.registerBuiltinRuleSource('preview-rule', makeRuleMarkdown({ id: 'preview-rule', scope: 'requests' }));
      const requests = [makeRequest(), makeRequest()];
      const sessions = [makeSession(requests)];
      const emissions = new Map<string, DetectorEmission>([
        ['preview-rule', makeEmission({ count: 4, total: 10, ratio: 0.4 })],
      ]);

      const stats = ruleEngine.getRulePreviewStats(requests, sessions, false, [], emissions);

      expect(stats[0]).toMatchObject({ occurrences: 4, total: 10, pct: 40 });
    });

    it('falls back to request and session counts when no emission is present', () => {
      ruleEngine.registerBuiltinRuleSource('request-rule', makeRuleMarkdown({ id: 'request-rule', scope: 'requests' }));
      ruleEngine.registerBuiltinRuleSource('session-rule', makeRuleMarkdown({ id: 'session-rule', scope: 'sessions', filter: 'requestCount > 1', trigger: 'count > 0' }));
      const requests = [makeRequest(), makeRequest(), makeRequest()];
      const sessions = [makeSession(requests), makeSession([makeRequest()])];

      const stats = ruleEngine.getRulePreviewStats(requests, sessions, false, []);
      const byId = new Map(stats.map(stat => [stat.ruleId, stat]));

      expect(byId.get('request-rule')).toMatchObject({ total: 3, occurrences: 0, previewDescription: 'Not triggered with current data.' });
      expect(byId.get('session-rule')).toMatchObject({ total: 2, occurrences: 0, previewDescription: 'Not triggered with current data.' });
    });
  });
});
