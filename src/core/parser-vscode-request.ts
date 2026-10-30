/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Mapping of raw VS Code / Copilot session-file request objects into the SessionRequest model.
 * Pure transforms over plain data (no fs / vscode), extracted from parser-vscode.ts. */

import { SessionRequest, ToolConfirmation } from './types';
import { createRequest, extractSkillNameFromPath } from './parser-shared';
import { debugCore } from './log';
import { extractReasoningEffortFromModelId } from './helpers';
import { hasRecordedToolEvidence, recordedToolFiles, recordedInvestigation, recordedWebDomains } from './curiosity-activity';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface RawRequest {
  requestId?: string;
  timestamp?: number;
  message?: { text?: string } | string;
  response?: unknown[];
  result?: { timings?: { firstProgress?: number; totalElapsed?: number }; metadata?: Record<string, unknown> };
  isCanceled?: boolean;
  agent?: { extensionDisplayName?: string; id?: string } | string;
  modelId?: string;
  slashCommand?: { name?: string } | string;
  variableData?: { variables?: RawVariable[] };
  contentReferences?: RawContentRef[];
  editedFileEvents?: { uri?: { path?: string } }[];
  /** Cumulative completion token count across all agentic rounds (streaming counter). */
  completionTokens?: number;
}

interface RawVariable {
  kind?: string;
  value?: string | { path?: string; external?: string };
}

interface RawContentRef {
  reference?: { external?: string; fsPath?: string };
}

interface ToolInvocationPart {
  kind?: string;
  toolId?: string;
  isConfirmed?: { type?: number; scope?: string };
  toolSpecificData?: {
    kind?: string;
    confirmation?: { commandLine?: string };
    commandLine?: { original?: string };
  };
}

interface ToolCallResult {
  toolCalls?: { name?: string }[];
}

interface ResponsePart {
  value?: string | { value?: string };
}

type TodoToolCall = {
  name?: string;
  arguments?: unknown;
};

type ParsedResultMetadata = {
  resultObj: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  resultIsFinalized: boolean;
};

type TokenInfo = {
  promptTokens: number | null;
  completionTokens: number | null;
};

function extractMessageText(msg: RawRequest['message']): string {
  if (typeof msg === 'string') return msg;
  if (isObj(msg)) return String(msg.text ?? '');
  return '';
}

function extractResponseText(resp: unknown[] | undefined): string {
  if (!Array.isArray(resp)) return '';
  const parts: string[] = [];
  for (const part of resp) {
    const p = part as ResponsePart;
    if (p && typeof p === 'object' && p.value != null) {
      const v = p.value;
      if (typeof v === 'object' && v !== null && 'value' in (v as object)) {
        const inner = (v as Record<string, unknown>).value;
        if (typeof inner === 'string') { parts.push(inner); continue; }
      }
      if (typeof v === 'string') { parts.push(v); continue; }
    }
  }
  return parts.join('\n');
}

function extractAgentInfo(agent: RawRequest['agent']): { agentName: string; agentMode: string } {
  if (!isObj(agent)) return { agentName: '', agentMode: '' };
  return {
    agentName: String(agent.extensionDisplayName || agent.id || ''),
    agentMode: String(agent.id || ''),
  };
}

/**
 * Normalize the session-level inputState.mode.id into a canonical agentMode value.
 * VS Code stores:
 *   - 'agent' for Agent mode
 *   - 'ask' for Ask/Chat mode
 *   - 'edit' for Edit mode
 *   - A full URI path (e.g. '.../Plan.agent.md') for Plan mode and custom agents
 */
export function normalizeSessionMode(modeId: string | undefined): string {
  if (!modeId) return '';
  // Built-in modes
  if (modeId === 'agent' || modeId === 'ask' || modeId === 'edit') return modeId;
  // URI-based modes: extract the meaningful name from the path
  const lower = modeId.toLowerCase();
  if (lower.includes('plan')) return 'plan';
  // Other custom agents/chatmodes — use the filename stem
  let decoded: string;
  try { decoded = decodeURIComponent(modeId); } catch { decoded = modeId; }
  const lastSlash = decoded.lastIndexOf('/');
  const filename = lastSlash >= 0 ? decoded.substring(lastSlash + 1) : decoded;
  const stem = filename.replace(/\.(agent|chatmode)\.md$/i, '');
  return stem || modeId;
}

function extractSlashCommand(slashCmd: RawRequest['slashCommand']): string {
  if (isObj(slashCmd) && typeof slashCmd.name === 'string') {
    return slashCmd.name;
  }
  return '';
}

function extractVariableKinds(vdVars: RawVariable[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const v of vdVars) {
    if (typeof v === 'object' && v && v.kind) {
      kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    }
  }
  return kinds;
}

function extractCustomInstructions(contentRefs: RawContentRef[] | undefined): string[] {
  const instructions: string[] = [];
  for (const cr of (contentRefs || [])) {
    if (typeof cr !== 'object' || !cr) continue;
    const ref = cr.reference;
    if (typeof ref !== 'object' || !ref) continue;
    const ext = (ref.external || ref.fsPath || '');
    const lower = ext.toLowerCase();
    if (lower.includes('.instructions.md') || lower.includes('copilot-instructions') || lower.includes('.prompt.md') || lower.includes('agents.md')) {
      const parts = ext.split('/');
      const fname = parts[parts.length - 1] || ext;
      if (fname && !instructions.includes(fname)) instructions.push(fname);
    }
  }
  return instructions;
}

// extractSkillNameFromPath is imported from parser-shared

/** Extract skill names from legacy inline XML in variable values. */
function extractSkillsFromXml(vdVars: RawVariable[], skills: Set<string>): void {
  const skillRe = /<skill>\s*<name>(.*?)<\/name>/g;
  for (const v of vdVars) {
    if (typeof v === 'object' && v && typeof v.value === 'string' && v.value.includes('<skill>')) {
      let sm: RegExpExecArray | null;
      while ((sm = skillRe.exec(v.value)) !== null) {
        const sn = sm[1].trim();
        if (sn && !sn.includes('ai_toolkit')) skills.add(sn);
      }
      skillRe.lastIndex = 0;
    }
  }
}

/** Extract skill names from promptFile variables that point to SKILL.md files. */
function extractSkillsFromPromptFiles(vdVars: RawVariable[], skills: Set<string>): void {
  for (const v of vdVars) {
    if (typeof v !== 'object' || !v || v.kind !== 'promptFile') continue;
    const val = v.value;
    if (typeof val !== 'object' || !val) continue;
    // Try the decoded path first, then the URL-encoded external URI
    const rawPath = val.path || val.external || '';
    const name = extractSkillNameFromPath(rawPath);
    if (name) skills.add(name);
  }
}

/** Extract skill names from read_file tool calls that target SKILL.md files. */
function extractSkillsFromToolCalls(result: RawRequest['result'], skills: Set<string>): void {
  forEachToolCall(result, tc => {
    const tool = tc as { name?: string; arguments?: unknown };
    if (!tool || typeof tool !== 'object') return;
    const toolName = tool.name;
    if (toolName !== 'read_file' && toolName !== 'copilot_readFile' && toolName !== 'readFile') return;
    let args = tool.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return; } }
    if (typeof args !== 'object' || !args) return;
    const a = args as Record<string, unknown>;
    const filePath = (typeof a.filePath === 'string' ? a.filePath : '')
      || (typeof a.path === 'string' ? a.path : '')
      || (typeof a.uri === 'string' ? a.uri : '');
    const name = extractSkillNameFromPath(filePath);
    if (name) skills.add(name);
  });
}

function extractSkillsUsed(vdVars: RawVariable[], result: RawRequest['result']): string[] {
  const skills = new Set<string>();
  extractSkillsFromXml(vdVars, skills);
  extractSkillsFromPromptFiles(vdVars, skills);
  extractSkillsFromToolCalls(result, skills);
  return [...skills];
}

function parseToolCalls(toolCalls: unknown, onError?: (error: unknown) => void): unknown[] {
  let tcData: unknown = toolCalls || [];
  if (typeof tcData === 'string') {
    try {
      tcData = JSON.parse(tcData);
    } catch (error) {
      onError?.(error);
      tcData = [];
    }
  }
  return Array.isArray(tcData) ? tcData : [];
}

/** Walk every tool call recorded in `result.metadata`'s `toolCallResults` / `toolCallRounds`
 *  arrays, invoking `visit` once per parsed tool call. Centralizes the metadata-shape traversal
 *  shared by the skills / tools / todo extractors. `onParseError` is forwarded to the JSON parse
 *  of each round's `toolCalls`. */
function forEachToolCall(
  result: RawRequest['result'],
  visit: (tool: unknown) => void,
  onParseError?: (error: unknown) => void,
): void {
  const meta = (typeof result === 'object' && result ? result.metadata : null) || {};
  if (typeof meta !== 'object') return;
  for (const key of ['toolCallResults', 'toolCallRounds']) {
    const arr = meta[key];
    if (!Array.isArray(arr)) continue;
    for (const tcr of arr) {
      if (typeof tcr !== 'object' || !tcr) continue;
      const tcData = parseToolCalls((tcr as ToolCallResult).toolCalls, onParseError);
      for (const tc of tcData) visit(tc);
    }
  }
}

function extractToolsUsed(result: RawRequest['result']): string[] {
  const tools: string[] = [];
  forEachToolCall(result, tc => {
    const tool = tc as { name?: string };
    if (tool && typeof tool === 'object' && tool.name) tools.push(String(tool.name));
  }, error => {
    debugCore('parser-vscode', 'Failed to parse toolCalls JSON string', error);
  });
  return tools;
}

function parseTodoListFromToolCall(tool: TodoToolCall): import('./types').TodoItem[] | null {
  if (!tool || tool.name !== 'manage_todo_list') return null;
  try {
    const args: unknown = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments;
    const items = isObj(args) ? args.todoList : undefined;
    if (!Array.isArray(items) || items.length === 0) return null;
    return items.map((it: { id?: number; title?: string; status?: string }) => ({
      id: it.id ?? 0,
      title: String(it.title ?? ''),
      status: it.status === 'in-progress' || it.status === 'completed' ? it.status : 'not-started',
    }));
  } catch {
    return null;
  }
}

function extractTodoSnapshot(result: RawRequest['result']): import('./types').TodoItem[] | null {
  let lastSnapshot: import('./types').TodoItem[] | null = null;
  forEachToolCall(result, tc => {
    const snapshot = parseTodoListFromToolCall(tc as TodoToolCall);
    if (snapshot) lastSnapshot = snapshot;
  });
  return lastSnapshot;
}

function extractEditedFiles(events: RawRequest['editedFileEvents']): string[] {
  const files: string[] = [];
  for (const efe of (events || [])) {
    if (typeof efe === 'object' && efe) {
      const uri = efe.uri || {};
      if (typeof uri === 'object' && uri.path) files.push(uri.path);
    }
  }
  return files;
}

function extractReferencedFiles(vdVars: RawVariable[]): string[] {
  const files: string[] = [];
  for (const v of vdVars) {
    if (typeof v === 'object' && v && (v.kind === 'file' || v.kind === 'directory')) {
      const val = v.value;
      if (typeof val === 'object' && val && (val as { path?: string }).path) {
        files.push((val as { path: string }).path);
      }
    }
  }
  return files;
}

function extractToolConfirmations(resp: unknown[] | undefined): ToolConfirmation[] {
  const confirmations: ToolConfirmation[] = [];
  if (!Array.isArray(resp)) return confirmations;
  for (const part of resp) {
    if (!part || typeof part !== 'object') continue;
    const p = part as ToolInvocationPart;
    if (p.kind !== 'toolInvocationSerialized' || !p.isConfirmed) continue;
    const tsd = p.toolSpecificData;
    const isTerminal = tsd?.kind === 'terminal';
    const confirmed = p.isConfirmed;
    confirmations.push({
      toolId: String(p.toolId || ''),
      confirmationType: confirmed.type ?? 0,
      autoApproveScope: confirmed.scope,
      isTerminal,
      commandLine: isTerminal
        ? String(tsd?.confirmation?.commandLine || tsd?.commandLine?.original || '')
        : undefined,
    });
  }
  return confirmations;
}

function extractRequestText(req: RawRequest): {
  msgText: string;
  resp: RawRequest['response'];
  respText: string;
} {
  const resp = req.response;
  return {
    msgText: extractMessageText(req.message),
    resp,
    respText: extractResponseText(resp),
  };
}

function extractRequestMetadata(req: RawRequest, result: RawRequest['result']): {
  firstProgress: number | null;
  totalElapsed: number | null;
  agentName: string;
  agentMode: string;
  slashCommand: string;
} {
  const timings = (typeof result === 'object' ? result.timings : null) || {};
  const { agentName, agentMode } = extractAgentInfo(req.agent);
  return {
    firstProgress: timings.firstProgress ?? null,
    totalElapsed: timings.totalElapsed ?? null,
    agentName,
    agentMode,
    slashCommand: extractSlashCommand(req.slashCommand),
  };
}

function extractRequestVariables(req: RawRequest, resp: RawRequest['response'], result: RawRequest['result']): {
  variableKinds: Record<string, number>;
  customInstructions: string[];
  skillsUsed: string[];
  toolsUsed: string[];
  investigationDelegations: ('research' | 'explore')[];
  webDomains: string[];
  editedFiles: string[];
  referencedFiles: string[];
  toolConfirmations: ToolConfirmation[];
} {
  const vd = req.variableData || {};
  const vdVars = (typeof vd === 'object' ? vd.variables : []) || [];
  const toolFiles = { edited: [] as string[], referenced: [] as string[] };
  const investigationDelegations = new Set<'research' | 'explore'>();
  const webDomains = new Set<string>();
  forEachToolCall(result, value => {
    if (!isObj(value) || typeof value.name !== 'string') return;
    if (!hasRecordedToolEvidence(value.name)) return;
    let args: unknown = value.arguments;
    if (typeof args === 'string' && value.name !== 'apply_patch') {
      try { args = JSON.parse(args); }
      catch (error) { debugCore('parser-vscode', 'Cannot read tool file evidence', error); return; }
    }
    const files = recordedToolFiles(value.name, args);
    const role = recordedInvestigation(value.name, args);
    if (role) investigationDelegations.add(role);
    for (const domain of recordedWebDomains(value.name, args)) webDomains.add(domain);
    toolFiles.edited.push(...files.edited);
    toolFiles.referenced.push(...files.referenced);
  });
  return {
    variableKinds: extractVariableKinds(vdVars),
    customInstructions: extractCustomInstructions(req.contentReferences),
    skillsUsed: extractSkillsUsed(vdVars, result),
    toolsUsed: extractToolsUsed(result),
    investigationDelegations: [...investigationDelegations],
    webDomains: [...webDomains],
    editedFiles: [...new Set([...extractEditedFiles(req.editedFileEvents), ...toolFiles.edited])],
    referencedFiles: [...new Set([...extractReferencedFiles(vdVars), ...toolFiles.referenced])],
    toolConfirmations: extractToolConfirmations(resp),
  };
}

function extractResultMetadata(result: RawRequest['result']): ParsedResultMetadata {
  const resultObj: Record<string, unknown> | null = typeof result === 'object' && result ? result : null;
  const resultMeta = resultObj?.metadata;
  const meta = (typeof resultMeta === 'object' && resultMeta ? resultMeta : {}) as Record<string, unknown>;
  return {
    resultObj,
    meta,
    resultIsFinalized: !!resultObj && Object.keys(resultObj).length > 0 && !!resultMeta,
  };
}

function extractTokenInfo(req: RawRequest, parsedResult: ParsedResultMetadata): TokenInfo {
  const { meta, resultIsFinalized } = parsedResult;
  const promptTokens = typeof meta.promptTokens === 'number' ? meta.promptTokens : null;
  const metaOutputTokens = typeof meta.outputTokens === 'number' ? meta.outputTokens : null;
  const topLevelCompletionTokens = resultIsFinalized
    && typeof req.completionTokens === 'number'
    && req.completionTokens > 0
    ? req.completionTokens
    : null;
  return {
    promptTokens,
    completionTokens: topLevelCompletionTokens ?? metaOutputTokens,
  };
}

function computeEndState(
  resultObj: ParsedResultMetadata['resultObj'],
  resultIsFinalized: boolean,
  promptTokens: TokenInfo['promptTokens'],
  completionTokens: TokenInfo['completionTokens'],
  meta: ParsedResultMetadata['meta'],
): 'pending' | 'errored' | 'no-data' | undefined {
  if (!resultObj || Object.keys(resultObj).length === 0) {
    return 'pending';
  }
  if (resultObj.errorDetails) {
    return 'errored';
  }
  if (!resultIsFinalized || promptTokens != null || completionTokens != null) {
    return undefined;
  }
  const hasAgenticMetadata = (
    'toolCallRounds' in meta
    || 'modelMessageId' in meta
    || 'responseId' in meta
    || 'renderedUserMessage' in meta
    || 'codeBlocks' in meta
  );
  return hasAgenticMetadata ? 'no-data' : undefined;
}

function extractCompaction(meta: ParsedResultMetadata['meta']): import('./types').CompactionEvent | null {
  const summaries = meta.summaries;
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  const s = summaries[0] as Record<string, unknown>;
  if (!s || typeof s.summarizationMode !== 'string') return null;
  return {
    mode: s.summarizationMode === 'simple' ? 'simple' : 'full',
    numRounds: typeof s.numRounds === 'number' ? s.numRounds : 0,
    numRoundsSinceLastSummarization: typeof s.numRoundsSinceLastSummarization === 'number' ? s.numRoundsSinceLastSummarization : 0,
    contextLengthBefore: typeof s.contextLengthBefore === 'number' ? s.contextLengthBefore : 0,
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
    model: typeof s.model === 'string' ? s.model : '',
    outcome: typeof s.outcome === 'string' ? s.outcome : '',
  };
}

export function parseRawRequest(req: RawRequest): SessionRequest {
  const { msgText, resp, respText } = extractRequestText(req);
  const result = req.result || {};
  const { firstProgress, totalElapsed, agentName, agentMode, slashCommand } = extractRequestMetadata(req, result);
  const {
    variableKinds,
    customInstructions,
    skillsUsed,
    toolsUsed,
    investigationDelegations,
    webDomains,
    editedFiles,
    referencedFiles,
    toolConfirmations,
  } = extractRequestVariables(req, resp, result);

  // Token counts come from two distinct sources (see VS Code chatModel.ts and toolCallingLoop.ts):
  //
  // 1. result.metadata.promptTokens / outputTokens — set by the Copilot extension from the
  //    API response of the FINAL LLM call. These are PER-ROUND values (last round only).
  //    For agentic tasks, metadata.outputTokens is often a dramatic undercount (e.g. just
  //    "Done." = 2 tokens), since it covers only the final round.
  //
  // 2. request.completionTokens — accumulated by VS Code core (ChatResponseModel.setUsage).
  //    This is CUMULATIVE across all agentic rounds: sum of completion_tokens from every
  //    LLM call in the request. Only available in recent VS Code versions (~April 2026+).
  //
  // For billing accuracy: request.completionTokens is the correct total output token count.
  // metadata.promptTokens is the last round's input size (not the sum across all rounds;
  // cumulative input tokens are NOT persisted to session files).
  //
  // When `result` is empty (`{}`), the request never completed (in-flight or abandoned);
  // any top-level `completionTokens` is stale, so we skip it.
  const { resultObj, meta, resultIsFinalized } = extractResultMetadata(result);

  // Per-request finalization state. We surface three non-recoverable
  // categories so the analyzer can exclude them from the coverage
  // denominator:
  //   - `pending`: `result` is empty/missing — the request never finalized
  //     (still in-flight, window closed mid-request, app crashed, etc.).
  //   - `errored`: `result.errorDetails` is present — the request completed
  //     with an error (user-canceled, network failure, length limit, rate
  //     limit, etc.). VS Code never received token usage.
  //   - `no-data`: the request completed successfully and the harness wrote
  //     full agentic metadata (toolCallRounds, responseId, codeBlocks, etc.)
  //     but did NOT record any token fields. Observed for some 2026-04
  //     requests against `copilot/auto` and `copilot/gpt-5.4`. There is no
  //     token data to recover, so don't count these as a parser gap.
  const { promptTokens, completionTokens } = extractTokenInfo(req, { resultObj, meta, resultIsFinalized });
  const endState = computeEndState(resultObj, resultIsFinalized, promptTokens, completionTokens, meta);
  const compaction = extractCompaction(meta);

  return createRequest({
    requestId: req.requestId || '',
    userEventId: req.requestId,
    answerEvidence: respText.trim() && !req.isCanceled && endState !== 'pending' && endState !== 'errored'
      ? resultIsFinalized ? 'final' : 'legacy' : 'missing',
    timestamp: req.timestamp ?? null,
    messageText: msgText,
    responseText: respText,
    isCanceled: req.isCanceled || false,
    agentName, agentMode,
    modelId: req.modelId || '',
    toolsUsed, editedFiles, referencedFiles,
    investigationDelegations,
    webDomains,
    slashCommand, variableKinds, customInstructions, skillsUsed,
    firstProgress,
    totalElapsed,
    toolConfirmations,
    promptTokens,
    completionTokens,
    compaction,
    todoSnapshot: extractTodoSnapshot(result),
    reasoningEffort: extractReasoningEffortFromModelId(req.modelId || ''),
    endState,
  });
}
