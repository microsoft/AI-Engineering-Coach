/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CallTimeline } from './call-timeline-types';
import type { RequestPromptCache, SessionPromptCache } from './prompt-cache-types';

export interface ToolConfirmation {
  toolId: string;
  confirmationType: number;
  autoApproveScope?: string;
  isTerminal: boolean;
  commandLine?: string;
}

export interface CompactionEvent {
  mode: 'full' | 'simple';
  numRounds: number;
  numRoundsSinceLastSummarization: number;
  /** Context size in tokens when compaction started (Copilot CLI: `preCompactionTokens`). */
  contextLengthBefore: number;
  durationMs: number;
  model: string;
  outcome: string;
  /** Context size after compaction (Copilot CLI: `postCompactionTokens`, or before − `tokensRemoved`). */
  contextLengthAfter?: number;
  /** Context limit the harness reported (Copilot CLI: `tokenLimit`, the same as the calls' `maxPromptTokens`). */
  tokenLimit?: number;
  /** What started it, as logged. Copilot CLI: `threshold` = automatic. */
  trigger?: string;
  checkpointNumber?: number;
  /** Tokens of the compaction call itself (Copilot CLI: `compactionTokensUsed`); input includes cached tokens. */
  tokensUsed?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Authoritative per-model usage totals reported at the session level
 *  (e.g. Copilot CLI emits these in `session.shutdown.modelMetrics`).
 *  Used for billing math when present; preferred over per-request data
 *  for sessions where per-request input is not available. */
export interface ModelUsage {
  /** Uncached input tokens billed at the input rate */
  inputTokens: number;
  /** Output tokens billed at the output rate */
  outputTokens: number;
  /** Cached tokens read (cheap rate) */
  cacheReadTokens: number;
  /** Cached tokens written / cache creation (cache-write rate) */
  cacheWriteTokens: number;
  /** Reasoning tokens (subset of output for some models, kept for diagnostics) */
  reasoningTokens?: number;
}

export interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

/** Prompt-composition categories shared by every harness. VS Code splits the
 *  conversation into messages, tool results and files; Copilot CLI reports it
 *  as one `conversation` bucket. `other` holds unrecognized or unattributed tokens. */
export type ContextCategory =
  | 'systemInstructions'
  | 'toolDefinitions'
  | 'messages'
  | 'toolResults'
  | 'files'
  | 'conversation'
  | 'other';

/** Where a prompt composition was measured. */
export type CompositionSource = 'vscode' | 'copilot-cli';

/** What filled a request's prompt, as reported by the harness. Holds only
 *  category names and numbers, never prompt content. */
export interface PromptComposition {
  source: CompositionSource;
  /** Percent of the prompt per category. A missing category is not reported
   *  by the source (not zero). VS Code rounds each value, so the sum can be off by a few points. */
  shares: Partial<Record<ContextCategory, number>>;
  /** Prompt tokens the shares describe: VS Code = the request's last model call;
   *  Copilot CLI = the average main-agent call in the turn. `null` = unknown. */
  promptTokens: number | null;
  /** Copilot CLI: main-agent model calls aggregated into this turn. */
  calls?: number;
  /** Copilot CLI: average tool-definition tokens per model call. */
  toolDefinitionTokens?: number;
  /** Copilot CLI: most tools offered to the model during the turn. */
  availableTools?: number;
}

/** A named part of the Copilot CLI system prompt and its size. */
export interface SystemPromptSegment {
  name: string;
  tokens: number;
}

/** Context snapshot Copilot CLI records when compaction starts. */
export interface CompactionContextSnapshot {
  timestamp: number | null;
  systemTokens: number;
  toolDefinitionTokens: number;
  conversationTokens: number;
  /** Total context estimate. Can exceed the sum of the parts; the difference is unattributed. */
  currentTokens: number;
  tokenLimit: number | null;
}

/** Session-level context composition details (Copilot CLI). */
export interface SessionContextComposition {
  /** System-prompt segments from the latest usage checkpoint, largest first. */
  systemSegments: SystemPromptSegment[];
  /** Tools sent with the model call recorded in the latest checkpoint, and their tokens. */
  toolCount: number | null;
  toolTokens: number | null;
  /** Context snapshots taken when compaction started. */
  compactions: CompactionContextSnapshot[];
}

export type CuriositySignal =
  | { kind: 'excluded'; excerpts: string[] }
  | { kind: 'unscanned'; excerpts: string[] }
  | {
    kind: 'analyzed';
    features: { question: { count: number; excerpts: string[] } };
    repeatedQuestions: string[];
  };

export interface SessionRequest {
  requestId: string;
  timestamp: number | null;
  messageText: string;
  responseText: string;
  isCanceled: boolean;
  agentName: string;
  agentMode: string;
  modelId: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  slashCommand: string;
  variableKinds: Record<string, number>;
  customInstructions: string[];
  skillsUsed: string[];
  firstProgress: number | null;
  totalElapsed: number | null;
  messageLength: number;
  responseLength: number;
  userCode: CodeBlock[];
  aiCode: CodeBlock[];
  toolConfirmations: ToolConfirmation[];
  /** Prompt token count — from result.metadata.promptTokens (LAST agentic round's input only,
   *  not cumulative across all rounds). Cumulative input tokens are not persisted by VS Code. */
  promptTokens: number | null;
  /** Completion token count — from request.completionTokens (CUMULATIVE across all agentic rounds)
   *  or metadata.outputTokens (last round only) as fallback for older sessions. */
  completionTokens: number | null;
  /** Cached tokens read (subset of `promptTokens` when present); billed at cached rate. `null` when the
   *  harness doesn't report cache usage, `0` when it reported none. */
  cacheReadTokens: number | null;
  /** Cached tokens written / cache creation (subset of `promptTokens` when present); billed at cache-write
   *  rate. `null` when the harness doesn't report cache usage, `0` when it reported none. */
  cacheWriteTokens: number | null;
  /** Compaction/summarization event attached to this request, if one occurred */
  compaction: CompactionEvent | null;
  /** What filled the prompt, when the harness reports it (VS Code, Copilot CLI). */
  promptComposition?: PromptComposition;
  /** Prompt-cache usage of the request's model calls, when the harness logs it per call
   *  (Copilot CLI and Copilot App, Claude Code, OpenCode). */
  promptCache?: RequestPromptCache;
  /** Final TODO list state at the end of this request (from manage_todo_list tool calls) */
  todoSnapshot: TodoItem[] | null;
  /** Precomputed work-type classification (feature, bug fix, refactor, etc.) */
  workType: string;
  /** Computed from raw user text before message previews are truncated. */
  curiosity?: CuriositySignal;
  /** Native human-event identity, not a generated request index or an assistant ID. */
  userEventId?: string;
  /** Captured before response previews are cleared. Legacy text is weaker than explicit finalization. */
  answerEvidence?: 'final' | 'legacy' | 'missing';
  /** Investigation roles declared in structured tool arguments, not inferred from prompts. */
  investigationDelegations?: ('research' | 'explore')[];
  /** Hostnames from explicit URL arguments of recorded web tools. No URL paths or credentials. */
  webDomains?: string[];
  /** Reasoning / thinking effort for reasoning-capable models, when known.
   *  Sources:
   *    - Copilot CLI: `session.start.data.reasoningEffort` and `session.model_change.data.reasoningEffort`
   *      (carried forward to every turn under that effort setting).
   *    - Other harnesses: inferred from a known set of model name suffixes
   *      (e.g. `claude-opus-4.7-xhigh` → 'max', `claude-opus-4.7-high` → 'high').
   *  Only set when the source actually exposes the value — never guessed.
   *  Values: 'max' | 'high' | 'medium' | 'low'. `null`/missing = unknown. */
  reasoningEffort?: 'max' | 'high' | 'medium' | 'low' | null;
  /** Per-request finalization state — distinguishes requests that never had
   *  a chance to produce token data (still in-flight, or completed with an
   *  error like cancellation, network failure, length limit) and requests
   *  that finished successfully but where the source/harness simply did not
   *  record token usage (e.g. Xcode, or some 2026-04 VS Code chat requests
   *  for `copilot/auto` / `copilot/gpt-5.4`) — from genuine data gaps where
   *  the request finished, the harness normally would record tokens, but
   *  none are present. The first three are excluded from the coverage
   *  denominator; the last counts as `missing`.
   *    pending — request never finalized (no result object)
   *    errored — finalized with an error (canceled, network, length, etc.)
   *    no-data — finalized successfully but no token data was recorded by
   *              the harness (parser limitation that cannot be fixed
   *              from the source data) */
  endState?: 'pending' | 'errored' | 'no-data';
  /** Main-agent context size and limit for the turn (Copilot CLI and Copilot App, Codex). */
  contextUsage?: import('./token-usage-types').TurnContextUsage;
  /** Every compaction during the turn, in order, when the harness can log several (Copilot CLI).
   *  `compaction` holds the first of them. */
  compactions?: CompactionEvent[];
  /** Sub-agent runs launched during the turn (Copilot CLI and Copilot App). */
  subagentRuns?: import('./token-usage-types').SubagentRun[];
}

export interface CodeBlock {
  language: string;
  loc: number;
}

/** Session-level disposition. Used to distinguish "missing token data
 *  because the session never closed" (active) and "missing because the
 *  user aborted before the model responded" (aborted) from genuine
 *  parser-coverage gaps (unknown). */
export type SessionEndReason = 'shutdown' | 'active' | 'aborted' | 'unknown';

export interface Session {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  location: string;
  harness: string;
  creationDate: number | null;
  lastMessageDate: number | null;
  requestCount: number;
  requests: SessionRequest[];
  /** Authoritative per-model usage totals reported at session close (Copilot CLI).
   *  Preferred over per-request token data for billing math when present. */
  modelUsage?: Record<string, ModelUsage>;
  /** System-prompt segments and compaction snapshots (Copilot CLI). */
  contextComposition?: SessionContextComposition;
  /** Main-agent model calls in order, bucketed (Copilot CLI and Copilot App). */
  callTimeline?: CallTimeline;
  /** Prompt-cache breaks and their causes (Copilot CLI and Copilot App). */
  promptCache?: SessionPromptCache;
  /** How the session ended. Drives "pending" vs "missing" classification
   *  in the Token Coverage view: active/aborted sessions cannot have full
   *  token data and so are excluded from the missing% denominator. */
  endReason?: SessionEndReason;
  /** True if the session shows runtime evidence of running inside a devcontainer
   *  (Codespaces / Remote-Containers). Detected by scanning request data for
   *  `/workspaces/...` paths in terminal commands, edited files, and referenced
   *  files. This is more reliable than checking the host disk for a
   *  `.devcontainer/` folder, because Codespaces never mount the project on
   *  the host. */
  hasDevcontainer?: boolean;
  /** Size (in characters) of the workspace's `.github/copilot-instructions.md`
   *  file at parse time, when discoverable. `0` means the file is missing or
   *  empty; `undefined` means the workspace folder path could not be resolved
   *  (e.g. CLI session without `cwd`, or multi-root workspace). Used by the
   *  `instruction-bloat` rule to detect always-on-context bloat. */
  customInstructionsBytes?: number;
  /** Resolved project root for CLI harnesses that record cwd separately from
   *  launch location/source. Used by config-health workspace scans. */
  workspaceRootPath?: string;
  /** How the session was launched (Claude only, currently).
   *    interactive  — user typed `claude` in a terminal or used Claude Desktop.
   *    programmatic — spawned by another tool via the SDK (e.g. GitHub Copilot
   *                   agent mode), MCP, GitHub Action, etc.
   *  Stored for diagnostics; all Claude sessions use the `Claude` harness
   *  regardless of launcher kind. */
  launcherKind?: 'interactive' | 'programmatic';
  /** Raw `entrypoint` value from Claude JSONL (`cli`, `sdk-ts`, `sdk-py`,
   *  `mcp`, `claude-code-github-action`, etc.). Stored for diagnostics so the
   *  classification can be re-evaluated without re-parsing if the allow-list
   *  changes. `undefined` for non-Claude sessions and very old Claude versions
   *  that did not record this field. */
  entrypoint?: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface DateFilter {
  fromDate?: string;
  toDate?: string;
  workspaceId?: string;
  harness?: string;
}
