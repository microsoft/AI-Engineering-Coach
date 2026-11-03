/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs a rule's inline `# Tests` block through the detector pipeline.
 *
 * Each line describes one request. Its fields override the `createRequest`
 * defaults; fields the DSL schema lists as session fields, such as `harness`,
 * go on the request's session instead. The request is repeated
 * RULE_TEST_ROWS times, each copy in its own session, so a single line clears
 * the rule's sample-size thresholds. See docs/AUTHORING_RULES.md.
 */

import type { DetectionRule, Session, SessionRequest } from './types';
import { createRequest, createSession } from './parser-shared';
import { FIELD_SCHEMA } from './dsl/schema';
import { runDetector } from './detector-registry';
import { resolveInheritance } from './rule-pipeline';

export const RULE_TEST_ROWS = 100;

/** Harness of a line that doesn't set one (VS Code). */
const DEFAULT_HARNESS = 'Local Agent';

/** Local noon on a Wednesday, so time-of-day and weekend rules stay quiet unless a line sets `timestamp`. */
const DEFAULT_TIMESTAMP = new Date(2026, 0, 14, 12).getTime();

const SESSION_FIELDS = new Set(FIELD_SCHEMA.filter(field => field.scope !== 'request').map(field => field.name));

export interface InlineTestResult {
  /** 1-based position of the line among the block's tests. */
  line: number;
  input: Record<string, unknown>;
  expected: 'triggered' | 'clean';
  actual: 'triggered' | 'clean';
  passed: boolean;
}

export function runInlineTests(rule: DetectionRule): InlineTestResult[] {
  const resolved = resolveInheritance(rule);
  return resolved.tests.map((test, index) => {
    const sessions = Array.from({ length: RULE_TEST_ROWS }, (_, copy) => testSession(test.input, copy));
    const reqs = sessions.flatMap(session => session.requests);
    const actual = runDetector(resolved, reqs, sessions) ? 'triggered' : 'clean';
    return { line: index + 1, input: test.input, expected: test.expect, actual, passed: actual === test.expect };
  });
}

function testSession(input: Record<string, unknown>, copy: number): Session {
  const sessionFields: Record<string, unknown> = {};
  const requestFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SESSION_FIELDS.has(key)) sessionFields[key] = value;
    else requestFields[key] = value;
  }
  const fields = requestFields as Partial<SessionRequest>;
  const request: SessionRequest = {
    ...createRequest({
      timestamp: DEFAULT_TIMESTAMP,
      ...fields,
      messageText: fields.messageText ?? '',
      responseText: fields.responseText ?? '',
    }),
    requestId: `test-${copy}`,
    ...fields,
  };
  return createSession({
    sessionId: `test-${copy}`,
    workspaceId: 'test',
    workspaceName: 'test',
    harness: DEFAULT_HARNESS,
    ...(sessionFields as Partial<Session>),
    requests: [request],
  });
}
