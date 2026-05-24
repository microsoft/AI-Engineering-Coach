/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { z } from 'zod';
import type { Session } from './types';
import { warnCore } from './log';

/* ---- Sub-schemas ---- */

export const CodeBlockSchema = z.object({
  language: z.string(),
  loc: z.number(),
}).passthrough();

export const ToolConfirmationSchema = z.object({
  toolId: z.string(),
  confirmationType: z.number(),
  autoApproveScope: z.string().optional(),
  isTerminal: z.boolean(),
  commandLine: z.string().optional(),
}).passthrough();

export const CompactionEventSchema = z.object({
  mode: z.enum(['full', 'simple']),
  numRounds: z.number(),
  numRoundsSinceLastSummarization: z.number(),
  contextLengthBefore: z.number(),
  durationMs: z.number(),
  model: z.string(),
  outcome: z.string(),
}).passthrough();

export const TodoItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  status: z.enum(['not-started', 'in-progress', 'completed']),
}).passthrough();

export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number().optional(),
}).passthrough();

/* ---- SessionRequest ---- */

export const SessionRequestSchema = z.object({
  requestId: z.string(),
  timestamp: z.number().nullable(),
  messageText: z.string(),
  responseText: z.string(),
  isCanceled: z.boolean(),
  agentName: z.string(),
  agentMode: z.string(),
  modelId: z.string(),
  toolsUsed: z.array(z.string()),
  editedFiles: z.array(z.string()),
  referencedFiles: z.array(z.string()),
  slashCommand: z.string(),
  variableKinds: z.record(z.string(), z.number()),
  customInstructions: z.array(z.string()),
  skillsUsed: z.array(z.string()),
  firstProgress: z.number().nullable(),
  totalElapsed: z.number().nullable(),
  messageLength: z.number(),
  responseLength: z.number(),
  userCode: z.array(CodeBlockSchema),
  aiCode: z.array(CodeBlockSchema),
  toolConfirmations: z.array(ToolConfirmationSchema),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  compaction: CompactionEventSchema.nullable(),
  todoSnapshot: z.array(TodoItemSchema).nullable(),
  workType: z.string(),
  reasoningEffort: z.enum(['max', 'high', 'medium', 'low']).nullable().optional(),
  endState: z.enum(['pending', 'errored', 'no-data']).optional(),
}).passthrough();

/* ---- Session ---- */

export const SessionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  location: z.string(),
  harness: z.string(),
  creationDate: z.number().nullable(),
  lastMessageDate: z.number().nullable(),
  requestCount: z.number(),
  requests: z.array(SessionRequestSchema),
  modelUsage: z.record(z.string(), ModelUsageSchema).optional(),
  endReason: z.enum(['shutdown', 'active', 'aborted', 'unknown']).optional(),
  hasDevcontainer: z.boolean().optional(),
  customInstructionsBytes: z.number().optional(),
  workspaceRootPath: z.string().optional(),
}).passthrough();

/* ---- Validation helper ---- */

/**
 * Validates parsed sessions and filters out invalid ones.
 * Logs warnings for malformed sessions but doesn't throw.
 */
export function validateSessions(sessions: unknown[], source: string): Session[] {
  const valid: Session[] = [];
  for (const s of sessions) {
    const result = SessionSchema.safeParse(s);
    if (result.success) {
      valid.push(result.data as Session);
    } else {
      warnCore('schema', `Invalid session from ${source}: ${result.error.issues[0]?.message ?? 'unknown'}`);
    }
  }
  return valid;
}
