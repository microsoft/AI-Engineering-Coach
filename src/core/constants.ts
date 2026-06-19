/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Shared constants for AI Engineer Coach */

/* ---- Model multipliers for premium request cost ---- */
/* https://docs.github.com/en/copilot/concepts/billing/copilot-requests#model-multipliers */
export const MODEL_MULTIPLIERS: Record<string, number> = {
  'gpt-4.1': 0, 'gpt-4.1-mini': 0, 'gpt-4.1-nano': 0,
  'gpt-5-mini': 0, 'gpt-5.1': 1, 'gpt-5.1-codex': 1, 'gpt-5.1-codex-mini': 0.33,
  'gpt-5.1-codex-max': 1, 'gpt-5.2': 1, 'gpt-5.2-codex': 1,
  'gpt-5.3-codex': 1, 'gpt-5.4': 1, 'gpt-5.4-mini': 0.33,
  'o1': 1, 'o1-mini': 1, 'o1-preview': 1, 'o3': 1, 'o3-mini': 1, 'o4-mini': 1,
  'claude-3.5-sonnet': 1, 'claude-3.7-sonnet': 1, 'claude-sonnet-4': 1, 'claude-sonnet-4.5': 1,
  'claude-sonnet-4.6': 1, 'claude-4': 1, 'claude-opus-4': 1, 'claude-opus-41': 1,
  'claude-opus-4.5': 3, 'claude-opus-4.6': 3, 'claude-opus-4.6-fast': 30, 'claude-opus-4.6-1m': 3,
  'claude-opus-4.7': 7.5,
  'claude-haiku-4.5': 0.33,
  'gemini-2.0-flash': 0.25, 'gemini-2.5-pro': 1, 'gemini-3-flash': 0.33,
  'gemini-3-pro': 1, 'gemini-3.1-pro': 1,
  'grok-code-fast-1': 0.25, 'raptor-mini': 0, 'goldeneye': 1,
  'copilot-internal': 0, 'auto': 1, 'custom-model': 1,
};

export const LOC_COST_2010 = 20;

/* ---- Per-token rates in USD per 1M tokens (May 2026 pricing) ---- */
/* https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing */
export interface TokenRate { input: number; cached: number; output: number; cacheWrite?: number }
export const MODEL_TOKEN_RATES: Record<string, TokenRate> = {
  'gpt-4.1':            { input: 2.00, cached: 0.50,  output: 8.00 },
  'gpt-4.1-mini':       { input: 0.25, cached: 0.025, output: 2.00 },
  'gpt-4.1-nano':       { input: 0.20, cached: 0.02,  output: 1.25 },
  'gpt-5-mini':         { input: 0.25, cached: 0.025, output: 2.00 },
  'gpt-5.1':            { input: 1.75, cached: 0.175, output: 14.00 },
  'gpt-5.1-codex':      { input: 1.75, cached: 0.175, output: 14.00 },
  'gpt-5.1-codex-mini': { input: 0.25, cached: 0.025, output: 2.00 },
  'gpt-5.1-codex-max':  { input: 1.75, cached: 0.175, output: 14.00 },
  'gpt-5.2':            { input: 1.75, cached: 0.175, output: 14.00 },
  'gpt-5.2-codex':      { input: 1.75, cached: 0.175, output: 14.00 },
  'gpt-5.3-codex':      { input: 1.75, cached: 0.175, output: 14.00 },
  'gpt-5.4':            { input: 2.50, cached: 0.25,  output: 15.00 },
  'gpt-5.4-mini':       { input: 0.75, cached: 0.075, output: 4.50 },
  'gpt-5.4-nano':       { input: 0.20, cached: 0.02,  output: 1.25 },
  'gpt-5.5':            { input: 5.00, cached: 0.50,  output: 30.00 },
  'claude-haiku-4.5':   { input: 1.00, cached: 0.10,  output: 5.00,  cacheWrite: 1.25 },
  'claude-3.5-sonnet':  { input: 3.00, cached: 0.30,  output: 15.00, cacheWrite: 3.75 },
  'claude-3.7-sonnet':  { input: 3.00, cached: 0.30,  output: 15.00, cacheWrite: 3.75 },
  'claude-sonnet-4':    { input: 3.00, cached: 0.30,  output: 15.00, cacheWrite: 3.75 },
  'claude-sonnet-4.5':  { input: 3.00, cached: 0.30,  output: 15.00, cacheWrite: 3.75 },
  'claude-sonnet-4.6':  { input: 3.00, cached: 0.30,  output: 15.00, cacheWrite: 3.75 },
  'claude-opus-4.5':    { input: 5.00, cached: 0.50,  output: 25.00, cacheWrite: 6.25 },
  'claude-opus-4.6':    { input: 5.00, cached: 0.50,  output: 25.00, cacheWrite: 6.25 },
  'claude-opus-4.7':    { input: 5.00, cached: 0.50,  output: 25.00, cacheWrite: 6.25 },
  'gemini-2.0-flash':   { input: 0.50, cached: 0.05,  output: 3.00 },
  'gemini-2.5-pro':     { input: 1.25, cached: 0.125, output: 10.00 },
  'gemini-3-flash':     { input: 0.50, cached: 0.05,  output: 3.00 },
  'gemini-3-pro':       { input: 2.00, cached: 0.20,  output: 12.00 },
  'gemini-3.1-pro':     { input: 2.00, cached: 0.20,  output: 12.00 },
  'grok-code-fast-1':   { input: 0.20, cached: 0.02,  output: 1.50 },
  'raptor-mini':        { input: 0.25, cached: 0.025, output: 2.00 },
  'goldeneye':          { input: 1.25, cached: 0.125, output: 10.00 },
};

/* AI Credit budget per SKU (1 credit = $0.01 USD) */
export const SKU_AI_CREDITS: Record<string, number> = {
  'pro': 1000,
  'pro-plus': 3900,
  'business': 1900,
  'enterprise': 3900,
};

/* ---- Legacy threshold kept for analyzer-patterns.ts ---- */
export const LONG_SESSION_REQS = 30;

/* ---- Insights thresholds ---- */
export const REVIEW_GAP_THRESHOLD_MS = 30_000;     // 30s gap after AI code = likely reviewed
export const VIBE_CODE_MIN_LOC = 100;               // min AI LoC per session to flag
export const VIBE_CODE_MAX_USER_PROMPTS = 5;        // max user prompts in a vibe-coded session
export const VIBE_CODE_MIN_SESSIONS = 3;             // min sessions to flag
export const CONTEXT_AUDIT_MIN_REQS = 30;            // min requests for context audit
export const PROMPT_MATURITY_SAMPLE_SIZE = 50;       // prompts to sample for maturity grading
export const LATE_NIGHT_START = 22;                  // 10 PM
export const LATE_NIGHT_END = 5;                     // 5 AM
export const BURNOUT_STREAK_DAYS = 14;               // consecutive days threshold
export const BURNOUT_LATE_NIGHT_RATE = 0.15;         // late-night ratio threshold
export const BURNOUT_WEEKEND_RATE = 0.25;            // weekend ratio threshold

/* ---- Config health thresholds ---- */
export const LOW_CONSTRAINT_MIN_REQS = 30;           // min requests to flag low constraint usage
export const LOW_CONSTRAINT_RATE = 0.08;             // <8% of prompts use constraints → anti-pattern
export const LOW_MARKDOWN_RATIO = 0.05;              // <5% markdown LoC → likely no spec-driven development
export const LOW_MARKDOWN_MIN_LOC = 100;             // min total AI LoC in a workspace to flag
export const LOW_MARKDOWN_MIN_WORKSPACES = 1;        // min workspaces with low markdown to flag
export const OVERSIZED_INSTRUCTION_LINES = 500;      // instruction file too large (lines)
export const COPILOT_INSTRUCTION_MAX_CHARS = 4000;   // Copilot code review truncation limit
export const CLAUDE_MD_RECOMMENDED_LINES = 200;      // CLAUDE.md recommended max lines

/* ---- Flow state thresholds ---- */
export const FLOW_RAPID_FOLLOWUP_SEC = 30;            // follow-up within 30s = rapid (in the zone)
export const FLOW_SESSION_MIN_REQS = 3;               // min requests for a session to count
export const FLOW_BLOCK_GAP_MIN = 15;                 // gap > 15 min between requests = new work block
export const FLOW_DEEP_SCORE = 70;                    // 70-100 = deep flow
export const FLOW_MODERATE_SCORE = 45;                // 45-69 = moderate flow
export const FLOW_SHALLOW_SCORE = 25;                 // 25-44 = shallow | <25 = fragmented
export const FLOW_LOW_SCORE_RATE = 0.6;               // >60% fragmented days → anti-pattern
export const FLOW_MIN_DAYS = 5;                       // min days of activity to flag

/* ---- Context management thresholds ---- */
export const CONTEXT_WINDOW_DEFAULT = 128_000;            // default assumed context window (tokens)
export const CONTEXT_OPTIMAL_UTILIZATION = 50;            // ≤50% avg = optimal (top performance)
export const CONTEXT_LIMITED_UTILIZATION = 80;            // >80% avg = limited
export const CONTEXT_SATURATION_THRESHOLD = 60;           // requests ≥60% utilization count as saturated
export const CONTEXT_COMPACTION_STORM_MIN = 4;            // 4+ compactions in a session = storm
export const CONTEXT_MIN_TOKEN_REQUESTS = 5;              // min requests with tokens to score a session
export const CONTEXT_GROWING_SESSION_MIN_REQS = 8;        // min requests to detect runaway growth
export const CONTEXT_GROWING_SESSION_GROWTH_RATE = 0.8;   // 80%+ sequential increases = runaway

/* ---- Token estimation (for sessions without native token data) ---- */

/* ---- Token data quality cutoff ---- */
export const TOKEN_DATA_AVAILABLE_FROM = '2026-04-01';

/* ---- Feature flags ---- */
// When flipping this back to `true`, also update the burndown e2e tests, which
// are skipped while it is off and contain stale assertions + an incomplete mock:
// tests/e2e/burndown.spec.ts and the getAiCreditBurndown mock in
// tests/e2e/harness.html (see the TODO(FF_TOKEN_REPORTING_ENABLED) notes there).
export const FF_TOKEN_REPORTING_ENABLED = false;
