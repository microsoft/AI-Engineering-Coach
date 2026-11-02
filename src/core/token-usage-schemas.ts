/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Strict schemas for per-turn context size, compaction details and sub-agent runs
 * (see types/token-usage-types.ts). Numbers, enum values and model names only. */

import { z } from 'zod';
import { SUBAGENT_TYPES } from './types/token-usage-types';

/** Most compactions kept for one turn. */
export const MAX_TURN_COMPACTIONS = 20;
/** Most sub-agent runs kept for one turn. */
export const MAX_TURN_SUBAGENT_RUNS = 50;

const tokens = z.number().min(0);

export const TurnContextUsageSchema = z.object({
  lastPromptTokens: tokens,
  peakPromptTokens: tokens,
  contextLimit: z.number().positive().nullable(),
  calls: z.number().int().min(0),
}).strict();

export const CompactionTokensUsedSchema = z.object({
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: tokens,
}).strict();

export const SubagentRunSchema = z.object({
  agentType: z.enum(SUBAGENT_TYPES),
  model: z.string().max(64),
  mode: z.enum(['sync', 'background']).nullable(),
  totalTokens: tokens,
  toolCalls: z.number().int().min(0),
  durationMs: tokens,
  cancelled: z.boolean(),
}).strict();
