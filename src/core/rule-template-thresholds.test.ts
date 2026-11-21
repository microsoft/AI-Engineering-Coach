/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Rule text can show its thresholds: {{thresholds.X}} and {{extra.X}} both render, on both paths. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectAntiPatterns } from './detector-registry';
import { createRequest, createSession } from './parser-shared';
import { evaluateRule } from './rule-engine';
import { parseRule } from './rule-parser';

const rulesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules');
const load = (id: string) => parseRule(fs.readFileSync(path.join(rulesDir, `${id}.md`), 'utf-8'))!;

describe('threshold placeholders in rule text', () => {
  it('renders {{thresholds.X}} (mcp-tool-bloat)', () => {
    const result = evaluateRule(load('mcp-tool-bloat'), { count: 4, total: 10, ratio: 0.4, examples: [], extra: {} });
    expect(result.description).toContain('more than 40 distinct tools');
  });

  it('renders {{extra.X}} for a threshold on the preview path (runaway-agent-loops)', () => {
    const rule = load('runaway-agent-loops');
    const key = Object.keys(rule.thresholds)[0];
    rule.descriptionTemplate = `limit {{extra.${key}}}`;
    const result = evaluateRule(rule, { count: 1, total: 1, ratio: 1, examples: [], extra: {} });
    expect(result.description).toBe(`limit ${rule.thresholds[key]}`);
  });

  it('renders {{thresholds.X}} in a finding, with the measured {{extra.X}} of the same name (instruction-bloat)', () => {
    const requests = [createRequest({ messageText: 'Explain the parser', responseText: 'ok', timestamp: Date.UTC(2026, 9, 1) })];
    const sessions = [createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'ws', harness: 'Local Agent', customInstructionsBytes: 9000, requests })];
    const finding = detectAntiPatterns(requests, sessions, false).patterns.find(p => p.id === 'instruction-bloat');
    expect(finding?.description).toContain('larger than 4000 bytes (largest: 9000 bytes)');
  });
});
