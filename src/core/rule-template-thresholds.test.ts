/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Rule text can show its thresholds: {{thresholds.X}} and {{extra.X}} both render, on both paths. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

  it('lets the detector extra win over a threshold of the same name', () => {
    const rule = load('mcp-tool-bloat');
    rule.descriptionTemplate = '{{extra.maxToolsPerSession}}';
    expect(evaluateRule(rule, { count: 1, total: 1, ratio: 1, examples: [], extra: { maxToolsPerSession: 77 } }).description).toBe('77');
  });
});
