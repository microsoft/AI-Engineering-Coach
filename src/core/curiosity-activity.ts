/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionRequest } from './types';
import { debugCore } from './log';

export type CuriosityActivity = 'direct' | 'web' | 'repository' | 'action';
export type ActivityCounts = Record<CuriosityActivity, number>;
export const emptyActivityCounts = (): ActivityCounts => ({ direct: 0, web: 0, repository: 0, action: 0 });
export const inquiryCount = (counts: ActivityCounts): number => counts.direct + counts.web + counts.repository;
export const activityCount = (counts: ActivityCounts): number => inquiryCount(counts) + counts.action;

// Tool identities describe recorded capabilities, not words in the user's prompt.
const READ_TOOLS = new Set([
  'view', 'read', 'read_file', 'readfile', 'copilot_readfile', 'show_file',
  'rg', 'grep', 'glob', 'ls', 'find', 'list_dir', 'list_directory',
  'file_search', 'grep_search', 'semantic_search', 'codebase', 'get_errors',
  'search_workspace_symbols', 'lexical_code_search',
]);
const WEB_TOOLS = new Set([
  'web_search', 'web_fetch', 'websearch', 'webfetch', 'fetch_webpage', 'search_web',
  'microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search',
]);
const WRITE_TOOLS = new Set([
  'edit', 'create', 'write', 'edit_file', 'write_file', 'create_file', 'overwrite',
  'multiedit', 'multiedittool', 'multi_edit', 'replace_string_in_file', 'insert_edit_into_file',
  'apply_patch', 'apply_diff', 'patch',
]);
const COMMAND_TOOLS = new Set([
  'bash', 'terminal', 'shell', 'shell_command', 'exec', 'exec_command', 'execute_command',
  'run_command', 'run_in_terminal', 'run_terminal_command', 'execute',
  'read_bash', 'read_process', 'get_terminal_output', 'stop_bash',
  'powershell', 'read_powershell', 'stop_powershell',
]);
const NEUTRAL_TOOLS = new Set([
  'report_intent', 'skill', 'manage_todo_list', 'todowrite', 'todoread', 'rename_session',
  'list_bash', 'list_powershell', 'task_complete',
]);
const CLARIFICATION_TOOLS = new Set(['ask_user', 'askuserquestion', 'vscode_askquestions']);
const INVESTIGATION_TOOLS = new Set(['task', 'agent', 'spawn_agent']);

export function toolIdentity(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

export function hasRecordedToolEvidence(name: string): boolean {
  const id = toolIdentity(name);
  return READ_TOOLS.has(id) || WEB_TOOLS.has(id) || WRITE_TOOLS.has(id)
    || INVESTIGATION_TOOLS.has(id) || name === 'multi_tool_use.parallel';
}

export function toolCapability(name: string): 'repository' | 'web' | 'write' | 'command' | 'neutral' | 'clarification' | 'unknown' {
  const id = toolIdentity(name);
  if (READ_TOOLS.has(id)) return 'repository';
  if (WEB_TOOLS.has(id)) return 'web';
  if (WRITE_TOOLS.has(id)) return 'write';
  if (COMMAND_TOOLS.has(id)) return 'command';
  if (NEUTRAL_TOOLS.has(id)) return 'neutral';
  if (CLARIFICATION_TOOLS.has(id)) return 'clarification';
  return 'unknown';
}

export type UnclassifiedReason = 'noQuestion' | 'noAnswer' | 'unknownTool' | 'clarification' | 'canceled';
export function classifyCuriosityActivity(request: SessionRequest): CuriosityActivity | UnclassifiedReason {
  const capabilities = request.toolsUsed.map(toolCapability);
  if (request.editedFiles.length || capabilities.includes('write') || capabilities.includes('command')
    || request.toolConfirmations.some(confirmation => confirmation.isTerminal)) return 'action';
  if (request.isCanceled || request.endState === 'errored') return 'canceled';
  if (capabilities.includes('clarification')) return 'clarification';
  if (capabilities.includes('unknown')) return 'unknownTool';
  if (request.curiosity?.kind !== 'analyzed' || !request.curiosity.features.question.count) return 'noQuestion';
  if (!request.answerEvidence || request.answerEvidence === 'missing' || request.endState === 'pending') return 'noAnswer';
  if (capabilities.includes('repository')) return 'repository';
  if (capabilities.includes('web')) return 'web';
  return 'direct';
}

export function isCuriosityActivity(value: CuriosityActivity | UnclassifiedReason): value is CuriosityActivity {
  return value === 'direct' || value === 'web' || value === 'repository' || value === 'action';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function recordedInvestigation(name: string, args: unknown): 'research' | 'explore' | undefined {
  if (!INVESTIGATION_TOOLS.has(toolIdentity(name))) return undefined;
  const data = record(args);
  const role = data?.agent_type ?? data?.subagent_type;
  if (typeof role !== 'string') return undefined;
  const normalized = role.toLowerCase();
  return normalized === 'research' || normalized === 'explore' ? normalized : undefined;
}

/** Expand a recorded parallel wrapper; an unexpanded wrapper remains an unknown tool. */
export function recordedTools(name: string, args: unknown): { name: string; args: unknown }[] {
  if (name !== 'multi_tool_use.parallel') return [{ name, args }];
  const children = record(args)?.tool_uses;
  if (!Array.isArray(children) || children.length > 64) return [{ name, args }];
  const calls = children.flatMap(child => {
    const data = record(child);
    return typeof data?.recipient_name === 'string' ? [{ name: data.recipient_name, args: data.parameters }] : [];
  });
  return calls.length === children.length && calls.length ? calls : [{ name, args }];
}

/** Keep only explicit web-tool URL hosts; queries, prompts and response prose are not sources. */
export function recordedWebDomains(name: string, args: unknown): string[] {
  if (name !== 'multi_tool_use.parallel' && toolCapability(name) !== 'web') return [];
  const domains = new Set<string>();
  for (const call of recordedTools(name, args)) {
    if (toolCapability(call.name) !== 'web') continue;
    const data = record(call.args);
    const urls: unknown[] = Array.isArray(data?.urls) ? data.urls : [];
    const values = [data?.url, data?.uri, ...urls];
    for (const value of values) {
      if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
      try {
        const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
        if (hostname) domains.add(hostname);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        debugCore('curiosity', 'Invalid URL in recorded web-tool arguments');
      }
    }
  }
  return [...domains];
}

/** Paths from structured tool arguments only; never scan prompts or terminal commands. */
export function recordedToolFiles(name: string, args: unknown): { edited: string[]; referenced: string[] } {
  const capability = toolCapability(name);
  if (capability !== 'write' && capability !== 'repository') return { edited: [], referenced: [] };
  const paths: string[] = [];
  if (typeof args === 'string' && toolIdentity(name) === 'apply_patch') {
    for (const match of args.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:) (.+)$/gm)) paths.push(match[1].trim());
  } else {
    const data = record(args);
    if (data) {
      for (const key of ['path', 'file_path', 'filePath', 'filename', 'uri']) {
        if (typeof data[key] === 'string') paths.push(data[key]);
      }
      if (Array.isArray(data.paths)) for (const value of data.paths) if (typeof value === 'string') paths.push(value);
    }
  }
  return {
    edited: capability === 'write' ? [...new Set(paths)] : [],
    referenced: capability === 'repository' ? [...new Set(paths)] : [],
  };
}
