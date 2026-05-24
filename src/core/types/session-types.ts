/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
  contextLengthBefore: number;
  durationMs: number;
  model: string;
  outcome: string;
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
  /** Cached tokens read (subset of `promptTokens` when present); billed at cached rate */
  cacheReadTokens: number | null;
  /** Cached tokens written / cache creation (subset of `promptTokens` when present); billed at cache-write rate */
  cacheWriteTokens: number | null;
  /** Compaction/summarization event attached to this request, if one occurred */
  compaction: CompactionEvent | null;
  /** Final TODO list state at the end of this request (from manage_todo_list tool calls) */
  todoSnapshot: TodoItem[] | null;
  /** Precomputed work-type classification (feature, bug fix, refactor, etc.) */
  workType: string;
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
