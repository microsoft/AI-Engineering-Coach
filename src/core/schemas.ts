/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { z } from 'zod';
import { CompactionTokensUsedSchema, MAX_TURN_COMPACTIONS, MAX_TURN_SUBAGENT_RUNS, SubagentRunSchema, TurnContextUsageSchema } from './token-usage-schemas';
import type { Session } from './types';
import { warnCore } from './log';
import { CACHE_MAX_BREAKS_PER_SESSION } from './constants';
import { MAX_TIMELINE_BUCKETS } from './call-timeline';
import { MAX_LATENCY_SAMPLES } from './call-outputs';

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
  contextLengthAfter: z.number().min(0).optional(),
  tokenLimit: z.number().positive().optional(),
  trigger: z.string().max(32).optional(),
  checkpointNumber: z.number().int().min(0).optional(),
  tokensUsed: CompactionTokensUsedSchema.optional(),
  atCall: z.number().int().min(0).optional(),
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

const shareSchema = z.number().min(0).max(100).optional();

export const PromptCompositionSchema = z.object({
  source: z.enum(['vscode', 'copilot-cli']),
  shares: z.object({
    systemInstructions: shareSchema,
    toolDefinitions: shareSchema,
    messages: shareSchema,
    toolResults: shareSchema,
    files: shareSchema,
    conversation: shareSchema,
    other: shareSchema,
  }).strict(),
  promptTokens: z.number().nullable(),
  calls: z.number().optional(),
  toolDefinitionTokens: z.number().optional(),
  availableTools: z.number().optional(),
}).strict();

export const SessionContextCompositionSchema = z.object({
  systemSegments: z.array(z.object({ name: z.string().max(64), tokens: z.number() }).strict()),
  toolCount: z.number().nullable(),
  toolTokens: z.number().nullable(),
  compactions: z.array(z.object({
    timestamp: z.number().nullable(),
    systemTokens: z.number(),
    toolDefinitionTokens: z.number(),
    conversationTokens: z.number(),
    currentTokens: z.number(),
    tokenLimit: z.number().nullable(),
  }).strict()),
}).strict();

/* ---- Prompt cache and call timeline (see types/prompt-cache-types.ts, types/call-timeline-types.ts) ---- */

const tokenSchema = z.number().min(0);
const modelNameSchema = z.string().max(64);
const cacheBreakCauseSchema = z.enum(['compaction', 'model-switch', 'ttl-expired', 'reasoning-effort', 'tools-changed', 'system-prompt', 'mode-change', 'resume']);

export const ModelCallRowSchema = z.object({
  stream: z.enum(['main', 'subagent', 'compaction']),
  model: modelNameSchema,
  calls: z.number().int().min(0),
  reasoningEffort: z.string().max(16).optional(),
  input: tokenSchema,
  cacheRead: tokenSchema,
  cacheWrite: tokenSchema,
  cost: tokenSchema.optional(),
  missCost: tokenSchema.optional(),
  baselineCost: tokenSchema.optional(),
  ratedInput: tokenSchema.optional(),
  ttlSeconds: tokenSchema.optional(),
  cacheBreaks: z.number().int().min(0).optional(),
  outputTokens: tokenSchema.optional(),
  reasoningTokens: tokenSchema.optional(),
  reasoningByEffort: z.array(z.object({
    effort: z.enum(['max', 'high', 'medium', 'low', 'unknown']),
    calls: z.number().int().min(0),
    outputTokens: tokenSchema,
    reasoningTokens: tokenSchema,
  }).strict()).max(5).optional(),
  truncatedCalls: z.number().int().min(0).optional(),
  stopCalls: z.number().int().min(0).optional(),
  filteredCalls: z.number().int().min(0).optional(),
  ttftMs: z.array(tokenSchema).max(MAX_LATENCY_SAMPLES).optional(),
  durationMs: z.array(tokenSchema).max(MAX_LATENCY_SAMPLES).optional(),
}).strict();

export const RequestPromptCacheSchema = z.object({
  rows: z.array(ModelCallRowSchema).max(16),
  coldStart: tokenSchema.optional(),
  coldStartCost: tokenSchema.optional(),
  rebuilt: tokenSchema.optional(),
  rebuiltCost: tokenSchema.optional(),
  returns: z.number().int().min(0).optional(),
  expiredReturns: z.number().int().min(0).optional(),
}).strict();

export const CacheBreakSchema = z.object({
  requestIndex: z.number().int().min(0),
  callIndex: z.number().int().min(-1),
  timestamp: z.number().nullable(),
  model: modelNameSchema,
  causes: z.array(cacheBreakCauseSchema).max(8),
  inferred: z.array(cacheBreakCauseSchema).max(8).optional(),
  confidence: z.enum(['logged', 'checkpoint', 'unattributed']),
  rebuiltTokens: tokenSchema,
  rebuiltCost: tokenSchema.optional(),
  idleSeconds: tokenSchema.nullable(),
  ttlSeconds: tokenSchema.nullable(),
  initiator: z.enum(['user', 'agent']).nullable(),
  autoModel: z.boolean().optional(),
  segments: z.array(z.string().max(64)).max(6).optional(),
  compactionTrigger: z.enum(['auto', 'manual']).optional(),
}).strict();

export const SessionPromptCacheSchema = z.object({
  breaks: z.array(CacheBreakSchema).max(CACHE_MAX_BREAKS_PER_SESSION),
  omittedBreaks: z.number().int().min(0).optional(),
}).strict();

/** Add new `CallTimelineBucket` fields here as well, or sessions carrying them fail validation. */
export const CallTimelineSchema = z.object({
  calls: z.number().int().min(0),
  bucketSize: z.number().int().min(1),
  buckets: z.array(z.object({
    firstCall: z.number().int().min(0),
    lastCall: z.number().int().min(0),
    firstRequest: z.number().int().min(0),
    lastRequest: z.number().int().min(0),
    startTs: z.number().nullable(),
    endTs: z.number().nullable(),
    cacheCalls: z.number().int().min(0),
    cacheRead: tokenSchema,
    cacheWrite: tokenSchema,
    uncached: tokenSchema,
    peakPrompt: tokenSchema.optional(),
    contextLimit: z.number().positive().optional(),
    output: tokenSchema.optional(),
    reasoning: tokenSchema.optional(),
    reasoningCalls: z.number().int().min(0).optional(),
    truncatedCalls: z.number().int().min(0).optional(),
  }).strict()).max(MAX_TIMELINE_BUCKETS),
}).strict();

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
  promptComposition: PromptCompositionSchema.optional(),
  promptCache: RequestPromptCacheSchema.optional(),
  todoSnapshot: z.array(TodoItemSchema).nullable(),
  workType: z.string(),
  userEventId: z.string().optional(),
  answerEvidence: z.enum(['final', 'legacy', 'missing']).optional(),
  investigationDelegations: z.array(z.enum(['research', 'explore'])).max(2).optional(),
  webDomains: z.array(z.string()).optional(),
  curiosity: z.union([
    z.object({ kind: z.enum(['excluded', 'unscanned']), excerpts: z.array(z.string()).max(0) }),
    z.object({
      kind: z.literal('analyzed'),
      features: z.object({
        question: z.object({
          count: z.number().int().min(0).max(256),
          excerpts: z.array(z.string().max(240)).max(3),
        }),
      }).strict(),
      repeatedQuestions: z.array(z.string().max(239)).max(3),
    }),
  ]).optional(),
  reasoningEffort: z.enum(['max', 'high', 'medium', 'low']).nullable().optional(),
  endState: z.enum(['pending', 'errored', 'no-data']).optional(),
  contextUsage: TurnContextUsageSchema.optional(),
  compactions: z.array(CompactionEventSchema).max(MAX_TURN_COMPACTIONS).optional(),
  subagentRuns: z.array(SubagentRunSchema).max(MAX_TURN_SUBAGENT_RUNS).optional(),
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
  contextComposition: SessionContextCompositionSchema.optional(),
  callTimeline: CallTimelineSchema.optional(),
  promptCache: SessionPromptCacheSchema.optional(),
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
