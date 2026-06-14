/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* RPC validation and dispatch helpers for the dashboard panel. */

import { Analyzer } from '../core/analyzer';
import { ParseResult } from '../core/parser';
import { loadSessionFromDisk } from '../core/cache';
import { extractSessionImages } from '../core/parser-vscode-files';
import { DateFilter, RpcMethodName, BurndownConfig } from '../core/types';
import type { RpcMethodMap, RpcResult } from '../core/types/rpc-types';
import {
  getAllRules,
  getRulePreviewStats,
  getRuleSource as getRuleSourceEngine,
  createRuleFromMarkdown,
  updateRuleThresholds,
  getRule,
  evaluateRule,
} from '../core/rule-engine';
import { runDetectors, runEmitters } from '../core/detector-registry';
import { parsePipeline, executePipeline, checkPipelineTrigger, resolveInheritance } from '../core/rule-pipeline';
import { parseRule, serializeRule } from '../core/rule-parser';
import { getRuleLayerInfo, getPersonalRulesDir, getProjectRulesDir } from '../core/rule-loader';
import { getPending, approve as approveTrust, getDefaultTrustStore } from '../core/rule-trust';
import { isoWeek } from '../core/helpers';
import { FIELD_SCHEMA, METRIC_PRIMITIVES, FUNCTION_CATALOG, compileFilter, validateExpression  } from '../core/dsl/index';
import {
  getAllMetrics,
  parseRuleExtensions,
  calibrate,
  runTestCases,
  serializeCalibration,
} from '../core/metric-engine';
import { compileNaturalLanguageRule } from '../core/rule-compiler';
import type { SessionRequest, Session } from '../core/types';
import { errorResult, isString, isNumber, isOptionalString, isRecord } from './panel-shared';
import { DSL_CHEATSHEET } from './dsl-cheatsheet';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';

/**
 * Pick `reqs` or `sessions` based on scope and return them typed as
 * DSL-friendly row records. Centralizes the cast so every DSL call site
 * uses the same shape. Accepts both 'sessions' (rule scope) and 'session'
 * (field scope) as truthy session values.
 */
type DslRow = Record<string, unknown>;
function pickRows(scope: string, reqs: SessionRequest[], sessions: Session[]): DslRow[] {
  const isSessionScope = scope === 'sessions' || scope === 'session';
  return (isSessionScope ? sessions : reqs) as unknown as DslRow[];
}

function isPathUnder(pathMod: typeof import('path'), resolved: string, dir: string): boolean {
  const base = pathMod.resolve(dir);
  return resolved === base || resolved.startsWith(base + pathMod.sep);
}

// `inAllowed` gates the write entirely; `isPersonal` gates auto-trust.
function classifyRuleWritePath(pathMod: typeof import('path'), filePath: string): {
  resolved: string;
  inAllowed: boolean;
  isPersonal: boolean;
} {
  const personalDir = getPersonalRulesDir();
  let workspaceRoot: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as typeof import('vscode');
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  } catch { /* test context */ }
  const allowedDirs = [personalDir, ...(workspaceRoot ? [getProjectRulesDir(workspaceRoot)] : [])];
  const resolved = pathMod.resolve(filePath);
  return {
    resolved,
    inAllowed: allowedDirs.some(d => isPathUnder(pathMod, resolved, d)),
    isPersonal: isPathUnder(pathMod, resolved, personalDir),
  };
}

function resolveRuleFilePath(
  fsMod: typeof import('fs'),
  pathMod: typeof import('path'),
  parsed: NonNullable<ReturnType<typeof parseRule>>,
  ruleIdParam: string,
): string {
  if (ruleIdParam) {
    const existing = getRule(ruleIdParam);
    if (existing?.sourceFilePath && (existing.source === 'personal' || existing.source === 'project')) {
      return existing.sourceFilePath;
    }
  }

  const dir = getPersonalRulesDir();
  try { fsMod.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const safeId = parsed.id.replaceAll(/[^a-zA-Z0-9_-]+/g, '-').replaceAll(/^-|-$/g, '') || 'custom-rule';
  return pathMod.join(dir, `${safeId}.md`);
}

export function validateDateFilter(p: Record<string, unknown>): DateFilter | undefined {
  const f: DateFilter = {};
  if (isString(p.fromDate)) f.fromDate = p.fromDate;
  if (isString(p.toDate)) f.toDate = p.toDate;
  if (isString(p.workspaceId)) f.workspaceId = p.workspaceId;
  else if (isString(p.workspace)) f.workspaceId = p.workspace;
  if (isString(p.harness)) f.harness = p.harness;
  return Object.keys(f).length > 0 ? f : undefined;
}

function validateBurndownConfig(raw: unknown): BurndownConfig {
  if (!isRecord(raw)) return { sku: 'pro' };
  const obj = raw;
  // Validate modelBudgets: must be Record<string, number> with positive values
  let modelBudgets: Record<string, number> | undefined;
  if (isRecord(obj.modelBudgets)) {
    modelBudgets = {};
    for (const [k, v] of Object.entries(obj.modelBudgets)) {
      if (isString(k) && isNumber(v) && v > 0) modelBudgets[k] = v;
    }
    if (Object.keys(modelBudgets).length === 0) modelBudgets = undefined;
  }
  return {
    sku: isString(obj.sku) ? obj.sku : 'pro',
    ...(isNumber(obj.customBudget) && { customBudget: obj.customBudget }),
    ...(isString(obj.month) && { month: obj.month }),
    ...(modelBudgets && { modelBudgets }),
  };
}

/**
 * Per-method typed handler: the return type is pinned to
 * `RpcResult<RpcMethodMap[M]['result']>` so handlers cannot silently drift
 * from the wire contract defined in `rpc-types.ts`.
 */
export type TypedRpcHandlers = {
  [M in RpcMethodName]: (
    analyzer: Analyzer,
    parseResult: ParseResult,
    params: Record<string, unknown>,
  ) => RpcResult<RpcMethodMap[M]['result']> | Promise<RpcResult<RpcMethodMap[M]['result']>>;
};

export type RpcHandler = TypedRpcHandlers[RpcMethodName];

function toDisplayText(value: unknown): string {
  if (isString(value)) return value;
  if (isNumber(value) || typeof value === 'boolean') return String(value);
  return '';
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = toDisplayText(value);
    if (text) return text;
  }
  return '';
}

function buildOccurrenceSessionSummary(session: Session): {
  sessionId: string;
  workspaceName: string;
  requestCount: number;
  harness: string;
  firstMessage: string;
  firstReferencedFiles: string[];
  firstAgentMode: string;
  firstSlashCommand: string;
  totalAiLoc: number;
  modelsUsed: string[];
  messagePreviews: string[];
} {
  const firstReq = session.requests[0];
  return {
    sessionId: session.sessionId,
    workspaceName: session.workspaceName,
    requestCount: session.requestCount,
    harness: session.harness,
    firstMessage: firstReq ? firstNonEmptyText(firstReq.messageText).substring(0, 500) : '',
    firstReferencedFiles: firstReq?.referencedFiles?.slice(0, 5) || [],
    firstAgentMode: firstReq?.agentMode || '',
    firstSlashCommand: firstReq?.slashCommand || '',
    totalAiLoc: session.requests.reduce((sum, r) => sum + (r.aiCode?.reduce((s, c) => s + (c.loc || 0), 0) || 0), 0),
    modelsUsed: [...new Set(session.requests.map(r => r.modelId).filter(Boolean))].slice(0, 5),
    messagePreviews: session.requests.slice(0, 5).map(r => firstNonEmptyText(r.messageText).substring(0, 120)),
  };
}

/* ── Rule generation helpers ── */

const GENERATE_RULE_SYSTEM_PROMPT = `You are an expert at writing detection rules for the AI Engineer Coach VS Code extension.
Rules are markdown files with YAML frontmatter and a Detection Logic block using a custom DSL.

${DSL_CHEATSHEET}

## Reference Examples by Category

### prompt-quality: Lazy Prompting (simple ratio rule)
\`\`\`markdown
---
id: lazy-prompting
name: Lazy Prompting
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [prompt, quality, short]
thresholds:
  minChars: 30
  maxRatio: 0.3
  minSample: 10
---

# Description
Detects requests with very short prompts that lack sufficient context for the AI to produce quality results.

# When Triggered
{{count}} requests ({{pct}}) are under {{extra.minChars}} characters. Very short prompts often produce poor results.

# How to Improve
Provide more context in your prompts: describe the intent, constraints, and expected output format.

# Examples
"{{message}}" ({{extra.charCount}} chars)

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: messageLength < thresholds.minChars AND messageLength > 0
aggregate: ratio
check: ratio > thresholds.maxRatio AND count > thresholds.minSample
examples: "{{messageText | truncate:80}}" ({{messageLength}} chars)
\\\`\\\`\\\`
\`\`\`

### prompt-quality: Context Engineering Gaps (multi-reduce rule with computed gaps)
\`\`\`markdown
---
id: context-engineering-gaps
name: Context Engineering Gaps
group: prompt-quality
severity: medium
scope: both
version: 1
tags: [context, agents, skills, mcp, instructions]
thresholds:
  minReqs: 30
  fileRefMinRate: 0.1
  instructionMinRate: 0.05
---

# Description
Audits your context engineering setup: custom agents, skills, MCP tools, file references, and custom instructions.

# When Triggered
{{count}} of 5 context engineering signals missing. Your AI lacks the context to be maximally effective.

# How to Improve
Level up your context engineering: create AGENTS.md for custom agents, SKILL.md for domain knowledge, connect MCP tools, use #file references, and add .instructions.md with project conventions.

# Examples
{{extra.gapCount}} of 5 context engineering signals missing

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: true
aggregate: count
reqCount: count
hasSubAgents: someWhere(allReqs, "agentName", "!=", "") AND someWhere(allReqs, "agentName", "!=", "copilot") AND someWhere(allReqs, "agentMode", "agent")
hasSkills: flatCount(allReqs, "skillsUsed") > 0
hasMcp: flatSomeWhere(allReqs, "toolsUsed", ".", "mcp_", "startsWith")
fileRefRate: countWhere(allReqs, "referencedFiles.length", ">", 0) / reqCount
instrRate: countWhere(allReqs, "customInstructions.length", ">", 0) / reqCount
gap1: hasSubAgents == 0
gap2: hasSkills == 0
gap3: hasMcp == 0
gap4: fileRefRate < thresholds.fileRefMinRate
gap5: instrRate < thresholds.instructionMinRate
gapCount: gap1 + gap2 + gap3 + gap4 + gap5
emitCount: gapCount
emitTotal: 5
check: gapCount > 0 AND reqCount >= thresholds.minReqs
severity: gapCount >= 4
\\\`\\\`\\\`
\`\`\`

### session-hygiene: Abandoned Sessions (simple session scan)
\`\`\`markdown
---
id: abandon-sessions
name: Abandoned Sessions
group: session-hygiene
severity: low
scope: sessions
version: 1
tags: [session, abandoned, single]
thresholds:
  maxAbandonRate: 0.4
  minSample: 10
---

# Description
Detects sessions with only a single message, indicating missed refinement opportunities.

# When Triggered
{{count}} sessions ({{pct}}) have only 1 message. You may be missing refinement opportunities.

# How to Improve
Use follow-up messages to refine Copilot's responses. Iterating produces much better results than one-shot prompts.

# Examples
{{extra.workspace}}: "{{message}}..."

# Detection Logic
\\\`\\\`\\\`detect
scan: sessions
match: requestCount == 1
aggregate: ratio
check: ratio > thresholds.maxAbandonRate AND count > thresholds.minSample
examples: {{workspaceName}}: abandoned after 1 message
\\\`\\\`\\\`
\`\`\`

### session-hygiene: Late-Night Coding (timestamp-based rule)
\`\`\`markdown
---
id: late-night-coding
name: Late-Night Coding
group: session-hygiene
severity: low
scope: requests
version: 1
tags: [session, health, hours]
thresholds:
  lateNightHour: 5
  minSample: 10
---

# Description
Detects requests made between midnight and early morning. Late-night coding correlates with more bugs.

# When Triggered
{{count}} requests were made between midnight and {{extra.lateNightHour}}am.

# How to Improve
Consider establishing healthier work hours. Quality drops significantly when fatigued.

# Examples
{{extra.timestamp}}: "{{message}}..."

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: timestamp > 0 AND hour(timestamp) >= 0 AND hour(timestamp) < thresholds.lateNightHour
aggregate: count
check: count > thresholds.minSample
examples: "{{messageText | truncate:50}}"
\\\`\\\`\\\`
\`\`\`

### code-review: Vibe Coding (complex multi-condition session rule)
\`\`\`markdown
---
id: vibe-coding
name: Vibe Coding
group: code-review
severity: high
scope: sessions
version: 1
tags: [review, vibe, quality]
thresholds:
  minAiLoc: 100
  maxUserPrompts: 5
  minSessions: 3
---

# Description
Detects sessions with high AI code output from minimal prompts with no specs, indicating velocity without understanding.

# When Triggered
{{count}} sessions show vibe-coding patterns: AI LoC generated with minimal prompts and no specs.

# How to Improve
Slow down. Write specs before coding. Review generated code line by line.

# Examples
{{extra.workspace}}: {{extra.aiLoc}} AI LoC in {{extra.messageCount}} messages

# Detection Logic
\\\`\\\`\\\`detect
scan: sessions
match: flatSumField(requests, "aiCode", "loc") >= thresholds.minAiLoc AND requestCount <= thresholds.maxUserPrompts AND NOT (matches(first(requests).messageText, "(?m)^[-*]\\\\s") OR matches(first(requests).messageText, "(?m)^\\\\d+[.)]\\\\s") OR matches(first(requests).messageText, "(?m)^#+\\\\s") OR matches(first(requests).messageText, "(?i)\\\\b(requirements?|spec|acceptance criteria|user stories?|given|when|then|should|must)\\\\b") OR lineCount(first(requests).messageText) >= 4)
aggregate: count
check: count >= thresholds.minSessions
examples: {{workspaceName}}: {{flatSumField(requests, "aiCode", "loc")}} AI LoC in {{requestCount}} messages
\\\`\\\`\\\`
\`\`\`

### code-review: YOLO Mode (helper function rule)
\`\`\`markdown
---
id: yolo-mode
name: YOLO Mode
group: code-review
severity: high
scope: requests
version: 1
tags: [review, security, auto-approve]
thresholds:
  autoApproveRate: 0.9
  minConfirmations: 15
---

# Description
Detects when the vast majority of tool actions are auto-approved, meaning the agent runs virtually unsupervised.

# When Triggered
{{count}} of {{total}} tool actions ({{pct}}) were auto-approved.

# How to Improve
Disable blanket auto-approve. Review file edits, terminal commands, and web searches individually.

# Examples
Auto-approved: {{extra.tools}}

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: toolConfirmations.length > 0
aggregate: count
yolo: yoloStats(matched)
emitCount: yolo.autoApproved
emitTotal: yolo.totalConfirmations
check: yolo.ratio > thresholds.autoApproveRate AND yolo.totalConfirmations >= thresholds.minConfirmations
\\\`\\\`\\\`
\`\`\`

### tool-mastery: Model Overreliance (helper function with emitCount/emitTotal)
\`\`\`markdown
---
id: model-overreliance
name: Model Overreliance
group: tool-mastery
severity: medium
scope: requests
version: 1
tags: [tools, model, diversity]
thresholds:
  maxTopModelRate: 0.8
  minSample: 10
  minModels: 3
---

# Description
Detects when the vast majority of requests use a single model, missing opportunities to use lighter models for simple tasks.

# When Triggered
{{pct}} of requests use {{extra.topModel}}. Different tasks benefit from different models.

# How to Improve
Use lighter models (gpt-4.1-mini, gemini-flash) for simple tasks to save premium quota and get faster responses.

# Examples
{{extra.model}}: {{extra.reqCount}} requests

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: true
aggregate: count
models: modelStats(allReqs)
emitCount: models.topCount
emitTotal: models.total
topModel: models.topModel
check: models.topShare > thresholds.maxTopModelRate AND models.modelCount < thresholds.minModels AND models.total > thresholds.minSample
\\\`\\\`\\\`
\`\`\`

### tool-mastery: No Plan Mode (boolean reduce + agent detection)
\`\`\`markdown
---
id: no-plan-mode
name: Never Uses Plan Mode
group: tool-mastery
severity: medium
scope: requests
version: 1
tags: [tools, planning, agent]
thresholds:
  minReqs: 30
  agentRate: 0.3
---

# Description
Detects heavy agentic usage with no use of plan mode, which helps the agent understand scope before implementation.

# When Triggered
{{extra.agenticReqs}} agentic requests but no use of plan mode.

# How to Improve
Use plan mode (or /plan) before complex tasks. Planning helps the agent understand scope and avoid wasted iterations.

# Examples
Switch to Plan mode in the mode picker before starting large features

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: agentMode == "agent" OR agentName != ""
aggregate: count
agentRatio: count / total
planUsage: someWhere(all, "slashCommand", "plan") OR someWhere(all, "agentMode", "matches", "(?i)plan")
agenticReqs: count
check: planUsage == 0 AND total >= thresholds.minReqs AND agentRatio >= thresholds.agentRate
\\\`\\\`\\\`
\`\`\`

### context-management: Missing File Context (simple array length check)
\`\`\`markdown
---
id: no-file-context
name: Missing File Context
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [prompt, context, files]
thresholds:
  maxNoContextRate: 0.7
  minSample: 10
---

# Description
Detects requests that have no file references, meaning the AI cannot see the relevant code context.

# When Triggered
{{pct}} of requests have no file references. The AI gives better answers with file context.

# How to Improve
Use #file to reference relevant files, or open files in the editor so the AI can use them as context.

# Examples
"{{message}}..."

# Detection Logic
\\\`\\\`\\\`detect
scan: requests
match: referencedFiles.length == 0 AND editedFiles.length == 0
aggregate: ratio
check: ratio > thresholds.maxNoContextRate AND count > thresholds.minSample
examples: "{{messageText | clip:80}}"
\\\`\\\`\\\`
\`\`\`

### Mega Sessions (simple count with threshold)
\`\`\`markdown
---
id: mega-sessions
name: Mega Sessions
group: session-hygiene
severity: high
scope: sessions
version: 1
tags: [session, length, context]
thresholds:
  maxMessages: 50
---

# Description
Detects sessions with an excessive number of messages. Long sessions degrade context quality.

# When Triggered
{{count}} session(s) have {{extra.maxMessages}}+ messages.

# How to Improve
Start new sessions periodically. Break large tasks into focused conversations of 15-25 messages.

# Examples
{{extra.workspace}}: {{extra.messageCount}} messages

# Detection Logic
\\\`\\\`\\\`detect
scan: sessions
match: requestCount >= thresholds.maxMessages
aggregate: count
check: count > 0
examples: {{workspaceName}}: {{requestCount}} messages
\\\`\\\`\\\`
\`\`\`

## Key Patterns to Follow
- Always use thresholds for configurable values (never hardcode numbers in match/check)
- Use aggregate: ratio when measuring "what fraction of items match"; use count when measuring "how many items match"
- Use helper functions (modelStats, yoloStats, etc.) for complex multi-field aggregations
- Use reduce keys for intermediate computations the check expression needs
- Use emitCount/emitTotal to control the displayed numerator/denominator
- Use severity: <expr> to dynamically upgrade severity when conditions are worse
- Template expressions in examples use {{fieldName}} or {{functionCall(...)}} syntax
- Backslash-escape regex special chars in matches() patterns

Output ONLY the raw markdown rule. No code fences around the whole output. No explanation.`;

function cleanRuleMarkdown(raw: string): string {
  let md = raw.trim();
  // Strip outer code fences
  md = md.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  // Strip leading prose before the frontmatter
  const fmIdx = md.indexOf('---');
  if (fmIdx > 0) md = md.substring(fmIdx);
  return md;
}

function validateRuleMarkdown(md: string): string[] {
  const issues: string[] = [];
  if (!md.match(/^---\n/)) issues.push('Missing YAML frontmatter (must start with ---)');
  if (!md.match(/\n---\n/)) issues.push('Frontmatter not properly closed (missing closing ---)');
  if (!md.match(/^id:\s*.+/m)) issues.push('Missing "id:" field in frontmatter');
  if (!md.match(/^name:\s*.+/m)) issues.push('Missing "name:" field in frontmatter');
  if (!md.match(/^group:\s*(prompt-quality|session-hygiene|code-review|tool-mastery|context-management)/m)) {
    issues.push('Missing or invalid "group:" (must be one of: prompt-quality, session-hygiene, code-review, tool-mastery, context-management)');
  }
  if (!md.match(/^severity:\s*(low|medium|high)/m)) issues.push('Missing or invalid "severity:" (must be low, medium, or high)');
  if (!md.match(/^scope:\s*(requests|sessions)/m)) issues.push('Missing or invalid "scope:" (must be requests or sessions)');
  if (!md.includes('# Description')) issues.push('Missing "# Description" section');
  if (!md.includes('# When Triggered')) issues.push('Missing "# When Triggered" section');
  if (!md.includes('# How to Improve')) issues.push('Missing "# How to Improve" section');
  if (!md.includes('```detect')) issues.push('Missing Detection Logic block (```detect ... ```)');
  else {
    const detectMatch = md.match(/```detect\n([\s\S]*?)```/);
    if (detectMatch) {
      const block = detectMatch[1];
      if (!block.match(/^scan:\s/m)) issues.push('Detection logic missing "scan:" directive');
      if (!block.match(/^match:\s/m)) issues.push('Detection logic missing "match:" expression');
      if (!block.match(/^check:\s/m)) issues.push('Detection logic missing "check:" expression');
    }
  }
  return issues;
}

function ruleTemplate(id: string, prompt: string): string {
  return `---
id: ${id}
name: ${prompt.substring(0, 60)}
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [custom]
thresholds:
  minReqs: 5
---

# Description
${prompt}

# When Triggered
{{count}} occurrences detected out of {{total}} ({{pct}}).

# How to Improve
Review flagged items and adjust your workflow to avoid this pattern.

# Examples
"{{message}}..."

# Detection Logic
\`\`\`detect
scan: requests
match: messageLength > 0
aggregate: count
check: count >= thresholds.minReqs
examples: "{{messageText | truncate:60}}"
\`\`\`
`;
}

const rpcHandlers: TypedRpcHandlers = {
  getWorkspaces: (a) => a.getWorkspaces(),
  getHarnesses: (a) => a.getHarnesses(),
  getHarnessBreakdown: (a, _p, params) => a.getHarnessBreakdown(validateDateFilter(params)),
  getDailyActivity: (a, _p, params) => a.getDailyActivity(validateDateFilter(params)),
  getWorkspaceBreakdown: (a, _p, params) => a.getWorkspaceBreakdown(validateDateFilter(params)),
  getHourlyDistribution: (a, _p, params) => a.getHourlyDistribution(validateDateFilter(params)),
  getHeatmap: (a, _p, params) => a.getHeatmap(validateDateFilter(params)),
  getCodeProduction: (a, _p, params) => a.getCodeProduction(validateDateFilter(params)),
  getConsumption: (a, _p, params) => FF_TOKEN_REPORTING_ENABLED ? a.getConsumption(validateDateFilter(params)) : errorResult('Token reporting is temporarily disabled'),
  getBurndown: (a, _p, params) => FF_TOKEN_REPORTING_ENABLED ? a.getBurndown(
    validateBurndownConfig(params?.config),
    isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined,
  ) : errorResult('Token reporting is temporarily disabled'),
  getAiCredits: (a, _p, params) => FF_TOKEN_REPORTING_ENABLED ? a.getAiCredits(validateDateFilter(params)) : errorResult('Token reporting is temporarily disabled'),
  getAiCreditBurndown: (a, _p, params) => FF_TOKEN_REPORTING_ENABLED ? a.getAiCreditBurndown(
    validateBurndownConfig(params?.config),
    isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined,
  ) : errorResult('Token reporting is temporarily disabled'),
  getTokenCoverage: (a, _p, params) => FF_TOKEN_REPORTING_ENABLED ? a.getTokenCoverage(validateDateFilter(params)) : errorResult('Token reporting is temporarily disabled'),
  getDayTimeline: (a, _p, params) => a.getDayTimeline(
    isOptionalString(params?.date) ? params.date : undefined,
    isOptionalString(params?.mode) ? params.mode : undefined,
    isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined,
  ),
  getSessions: (a, _p, params) => a.getSessions(
    isNumber(params?.page) ? params.page : 1,
    isNumber(params?.pageSize) ? Math.min(params.pageSize, 100) : 20,
    isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined,
    isOptionalString(params?.search) ? params.search : undefined,
  ),
  getSessionDetail: async (a, _p, params) => {
    const sessionId = params?.sessionId;
    if (!isString(sessionId)) return null;
    // In-memory sessions have text stripped for memory efficiency.
    // Try loading full session from disk cache for the detail view.
    const fromDisk = await loadSessionFromDisk(sessionId);
    if (fromDisk) return fromDisk;
    // Fall back to in-memory (stripped) session.
    return a.getSessionDetail(sessionId);
  },
  getWorkLifeBalance: (a, _p, params) => a.getWorkLifeBalance(validateDateFilter(params)),
  getAntiPatterns: (a, _p, params) => a.getAntiPatterns(validateDateFilter(params)),
  getHarnessComparison: (a, _p, params) => a.getHarnessComparison(validateDateFilter(params)),
  getParserCoverage: (a) => a.getParserCoverage(),
  getParserPreview: (a, _p, params) => a.getParserPreview(typeof params?.focusField === 'string' ? params.focusField : undefined),
  getWorkflowOptimization: (a, _p, params) => a.getWorkflowOptimization(validateDateFilter(params)),
  getStats: (a, _p, params) => a.getStats(validateDateFilter(params)),
  getConfigHealth: (a, _p, params) => a.getConfigHealth(validateDateFilter(params)),
  getInsights: (a, _p, params) => a.getInsights(validateDateFilter(params)),
  getFlowState: (a, _p, params) => a.getFlowState(validateDateFilter(params)),
  getContextManagement: (a, _p, params) => a.getContextManagement(validateDateFilter(isRecord(params?.filter) ? params.filter : params)),
  getWorkspaceContextSessions: (a, _p, params) => {
    const workspaceId = isString(params?.workspaceId) ? params.workspaceId : '';
    if (!workspaceId) {
      return {
        workspaceName: '',
        estimatedContextWindow: 0,
        thresholds: { optimalUtilization: 0, limitedUtilization: 0, adaptive: false, sampleSize: 0 },
        sessions: [],
      };
    }
    const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
    return a.getWorkspaceContextSessions(workspaceId, filter);
  },
  getContextRangeAvailability: (a, _p, params) => a.getContextRangeAvailability(validateDateFilter(isRecord(params?.filter) ? params.filter : params)),
  getCalendarActivity: (a, _p, params) => a.getCalendarActivity(validateDateFilter(params)),
  getProjectOverview: (a, _p, params) => a.getProjectOverview(validateDateFilter(params)),
  getImageGallery: (a, _p, params) => a.getImageGallery(validateDateFilter(params)),
  getSessionImages: (_a, p, params) => {
    const sessionId = isString(params?.sessionId) ? params.sessionId : '';
    const requestId = isString(params?.requestId) ? params.requestId : '';
    if (!sessionId || !requestId) return { images: [] };
    const source = p.sessionSourceIndex.get(sessionId);
    if (!source) return { images: [] };
    return { images: extractSessionImages(source.filePath, requestId) };
  },

  /* ---- Rule Editor methods ---- */
  getRuleEditor: (a, _p, params) => {
    const filter = validateDateFilter(params);
    const reqs = a.filterRequests(filter);
    const sessions = a.filterSessions(filter);
    const skipIde = !!(filter?.harness && !filter.harness.startsWith('Local Agent') && filter.harness !== 'Xcode');
    const detectorResults = runDetectors(reqs, sessions, skipIde);
    const emissions = runEmitters(reqs, sessions, skipIde);
    const previews = getRulePreviewStats(reqs, sessions, skipIde, detectorResults, emissions);
    const rules = getAllRules().map(r => ({
      id: r.id,
      name: r.name,
      group: r.group,
      severity: r.severity,
      scope: r.scope,
      requiresIdeContext: r.requiresIdeContext,
      description: r.descriptionTemplate
        ? r.descriptionTemplate.replaceAll(/\{\{[^}]+\}\}/g, '...').substring(0, 200)
        : r.name,
      descriptionTemplate: r.descriptionTemplate,
      suggestionTemplate: r.suggestionTemplate,
      exampleTemplate: r.exampleTemplate,
      thresholds: r.thresholds,
      tags: r.tags,
      source: r.source,
      sourceFilePath: r.sourceFilePath,
      version: r.version,
      rawSource: '',  // Don't send full source in list view
    }));
    let workspaceRoot: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require('vscode') as typeof import('vscode');
      workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    } catch { /* running in test context */ }
    const layers = getRuleLayerInfo(workspaceRoot);

    // Compute per-rule weekly date histograms (last 8 weeks)
    const weekBuckets = new Map<string, typeof reqs>();
    for (const r of reqs) {
      if (!r.timestamp) continue;
      const wk = isoWeek(new Date(r.timestamp));
      if (!weekBuckets.has(wk)) weekBuckets.set(wk, []);
      weekBuckets.get(wk)!.push(r);
    }
    const sortedWeeks = Array.from(weekBuckets.keys()).sort().slice(-8);
    const dateHistograms: Record<string, { labels: string[]; counts: number[] }> = {};
    if (sortedWeeks.length >= 2) {
      const weekEmissions = new Map<string, Map<string, number>>();
      for (const wk of sortedWeeks) {
        const wkReqs = weekBuckets.get(wk) || [];
        const wkEmissions = runEmitters(wkReqs, sessions, skipIde);
        const counts = new Map<string, number>();
        for (const [ruleId, emission] of wkEmissions) {
          counts.set(ruleId, emission.count);
        }
        weekEmissions.set(wk, counts);
      }
      for (const rule of rules) {
        const counts = sortedWeeks.map(wk => weekEmissions.get(wk)?.get(rule.id) ?? 0);
        dateHistograms[rule.id] = { labels: sortedWeeks, counts };
      }
    }

    return { rules, previews, layers, dateHistograms, pending: getPending().map(p => ({
      filePath: p.filePath,
      layer: p.layer,
      kind: p.kind,
    })) };
  },

  getRulePreview: (a, _p, params) => {
    const ruleId = isString(params?.ruleId) ? params.ruleId : '';
    const rule = getRule(ruleId);
    if (!rule) return { ruleId, triggered: false, occurrences: 0, total: 0, pct: 0, severity: 'low', group: 'prompt-quality', previewDescription: 'Rule not found.', previewExamples: [] };
    const filter = validateDateFilter(params);
    const reqs = a.filterRequests(filter);
    const sessions = a.filterSessions(filter);
    const skipIde = !!(filter?.harness && !filter.harness.startsWith('Local Agent') && filter.harness !== 'Xcode');
    const detectorResults = runDetectors(reqs, sessions, skipIde);
    const emissions = runEmitters(reqs, sessions, skipIde);
    const previews = getRulePreviewStats(reqs, sessions, skipIde, detectorResults, emissions);
    return previews.find(p => p.ruleId === ruleId) || { ruleId, triggered: false, occurrences: 0, total: 0, pct: 0, severity: rule.severity, group: rule.group, previewDescription: 'No data.', previewExamples: [] };
  },

  getRuleSource: (_a, _p, params) => {
    const ruleId = isString(params?.ruleId) ? params.ruleId : '';
    const source = getRuleSourceEngine(ruleId);
    return { source: source || '' };
  },

  saveRule: async (_a, _p, params) => {
    const markdown = isString(params?.markdown) ? params.markdown : '';
    const ruleIdParam = isString(params?.ruleId) ? params.ruleId : '';
    if (!markdown.trim()) return { ok: false };

    const parsed = parseRule(markdown);
    if (!parsed) return { ok: false };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');

    const filePath = resolveRuleFilePath(fs, path, parsed, ruleIdParam);

    const { inAllowed, isPersonal } = classifyRuleWritePath(path, filePath);
    if (!inAllowed) return { ok: false, error: 'Refusing to write outside rules directories' };

    try {
      fs.writeFileSync(filePath, markdown, 'utf-8');
    } catch (err) {
      return { ok: false, error: `Failed to write ${filePath}: ${String(err)}` };
    }

    const store = getDefaultTrustStore();
    if (store && isPersonal) {
      try { await approveTrust(store, filePath, markdown); } catch { /* ignore */ }
    }

    const rule = createRuleFromMarkdown(markdown);
    if (rule) rule.sourceFilePath = filePath;
    return { ok: !!rule, filePath };
  },

  updateRuleThreshold: (_a, _p, params) => {
    const ruleId = isString(params?.ruleId) ? params.ruleId : '';
    const key = isString(params?.key) ? params.key : '';
    const value = isNumber(params?.value) ? params.value : 0;
    if (!ruleId || !key) return { ok: false };
    const result = updateRuleThresholds(ruleId, { [key]: value });
    return { ok: !!result };
  },

  reviewLocalRules: async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require('vscode') as typeof import('vscode');
      await vscode.commands.executeCommand('aiEngineerCoach.reviewLocalRules');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  testRuleLive: (a, _p, params) => {
    const markdown = isString(params?.markdown) ? params.markdown : '';
    if (!markdown.trim()) return { ok: false, triggered: false, occurrences: 0, total: 0, pct: '0%', severity: 'low', description: '', suggestion: '', examples: [], error: 'No rule markdown provided' };
    try {
      const rule = parseRule(markdown);
      if (!rule) return { ok: false, triggered: false, occurrences: 0, total: 0, pct: '0%', severity: 'low', description: '', suggestion: '', examples: [], error: 'Failed to parse rule. Check frontmatter and detection logic.' };
      rule.source = 'personal';
      const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
      const reqs = a.filterRequests(filter);
      const sessions = a.filterSessions(filter);
      const resolved = resolveInheritance(rule);
      const pipeline = parsePipeline(resolved);
      const emission = executePipeline(pipeline, resolved, { reqs, sessions, skipIdeDetectors: false });
      const triggered = checkPipelineTrigger(pipeline, emission, resolved);
      const evalResult = evaluateRule(resolved, triggered ? emission : null);
      const pct = emission.total > 0 ? `${(emission.count / emission.total * 100).toFixed(0)}%` : '0%';
      return {
        ok: true,
        triggered,
        occurrences: emission.count,
        total: emission.total,
        pct,
        severity: evalResult.severity,
        description: evalResult.description,
        suggestion: evalResult.suggestion,
        examples: emission.examples.slice(0, 5),
      };
    } catch (err: unknown) {
      return { ok: false, triggered: false, occurrences: 0, total: 0, pct: '0%', severity: 'low', description: '', suggestion: '', examples: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  explainOccurrence: async (a, _p, params) => {
    const ruleId = isString(params?.ruleId) ? params.ruleId : '';
    const sessionId = isString(params?.sessionId) ? params.sessionId : '';
    if (!ruleId || !sessionId) return { ok: false, explanation: '', error: 'Missing ruleId or sessionId' };
    try {
      const rule = getRule(ruleId);
      if (!rule) return { ok: false, explanation: '', error: 'Rule not found' };

      const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
      const session = a.filterSessions(filter).find(s => s.sessionId === sessionId);
      if (!session) return { ok: false, explanation: '', error: 'Session not found' };

      const sessionSummary = buildOccurrenceSessionSummary(session);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require('vscode') as typeof import('vscode');
      const { callLlm } = await import('./panel-llm');

      const systemPrompt = `You are an expert explaining why a specific coding session triggered an AI Engineer Coach detection rule.
You will receive the rule (in DSL form) and a summary of the session. Explain in 2-4 short sentences:
1. What the rule is looking for
2. Which specific aspects of this session match the rule
3. One concrete action the user can take for this specific session

Be specific. Reference actual values from the session. Keep it under 80 words. No preamble.`;

      const userPrompt = `Rule: ${rule.name}
Description: ${rule.description}

Rule DSL (markdown):
${rule.rawSource || serializeRule(rule)}

Session summary:
${JSON.stringify(sessionSummary, null, 2)}

Explain why this session triggered the rule.`;

      const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ];

      const explanation = await callLlm(messages);
      return { ok: true, explanation: explanation.trim() };
    } catch (err: unknown) {
      return { ok: false, explanation: '', error: err instanceof Error ? err.message : String(err) };
    }
  },

  getRuleCoverage: (a, _p, params) => {
    try {
      const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
      const reqs = a.filterRequests(filter);
      const sessions = a.filterSessions(filter);
      const skipIde = !!(filter?.harness && !filter.harness.startsWith('Local Agent') && filter.harness !== 'Xcode');

      // Enrich requests with session info (needed by rules that reference workspaceName/sessionId)
      const sessionMap = new Map<string, { sessionId: string; workspaceName: string }>();
      for (const s of sessions) for (const r of s.requests) sessionMap.set(r.requestId, { sessionId: s.sessionId, workspaceName: s.workspaceName });
      const enrichedReqs = reqs.map(r => {
        const s = sessionMap.get(r.requestId);
        if (!s) return r;
        const e = r as typeof r & { sessionId: string; workspaceName: string };
        e.sessionId = s.sessionId; e.workspaceName = s.workspaceName;
        return e;
      });

      const detectorResults = runDetectors(enrichedReqs, sessions, skipIde);
      // Build workspaces list (top N by session count)
      const wsCounts = new Map<string, number>();
      for (const s of sessions) {
        const ws = s.workspaceName || '(unknown)';
        wsCounts.set(ws, (wsCounts.get(ws) || 0) + 1);
      }
      const workspaces = [...wsCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([ws]) => ws);
      const workspaceSet = new Set(workspaces);

      // For each detected pattern, count occurrences per workspace via its `details`
      const matrix: Record<string, Record<string, number>> = {};
      const rulesMeta: Array<{ id: string; name: string; group: string }> = [];
      for (const pat of detectorResults) {
        rulesMeta.push({ id: pat.id, name: pat.name, group: pat.group });
        const byWs: Record<string, number> = {};
        for (const d of pat.details || []) {
          const ws = d.workspace || '(unknown)';
          if (!workspaceSet.has(ws)) continue;
          byWs[ws] = (byWs[ws] || 0) + 1;
        }
        matrix[pat.id] = byWs;
      }

      // Sort rules by group order then name
      const groupOrder: Record<string, number> = { 'prompt-quality': 0, 'session-hygiene': 1, 'code-review': 2, 'tool-mastery': 3, 'context-management': 4 };
      rulesMeta.sort((x, y) => (groupOrder[x.group] ?? 9) - (groupOrder[y.group] ?? 9) || x.name.localeCompare(y.name));

      return { rules: rulesMeta, workspaces, matrix };
    } catch (err: unknown) {
      return { rules: [], workspaces: [], matrix: {}, error: err instanceof Error ? err.message : String(err) };
    }
  },

  generateRule: async (_a, _p, params) => {
    const prompt = isString(params?.prompt) ? params.prompt : '';
    const id = prompt
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '')
      .substring(0, 40) || 'custom-rule';

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require('vscode') as typeof import('vscode');
      const { callLlm } = await import('./panel-llm');

      const messages = [
        vscode.LanguageModelChatMessage.User(GENERATE_RULE_SYSTEM_PROMPT),
        vscode.LanguageModelChatMessage.User(`Generate a complete detection rule for: ${prompt}\n\nUse id: ${id}`),
      ];

      const MAX_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const result = await callLlm(messages);
        const markdown = cleanRuleMarkdown(result);
        const issues = validateRuleMarkdown(markdown);
        if (issues.length === 0) return { markdown };

        // Retry: tell the LLM what was wrong
        messages.push(vscode.LanguageModelChatMessage.Assistant(result));
        messages.push(vscode.LanguageModelChatMessage.User(
          `The generated rule has issues:\n${issues.map(i => `- ${i}`).join('\n')}\n\nPlease fix and output the complete corrected rule markdown. No code fences around the output.`
        ));
      }

      // After retries, return the last attempt even if imperfect
      const lastResult = await callLlm(messages);
      return { markdown: cleanRuleMarkdown(lastResult) };
    } catch (err: unknown) {
      // Log so the Output channel shows why; fall back to a template so the
      // editor still has something usable to edit.
      const { warnCore } = await import('../core/log');
      warnCore('generateRule', 'LLM call failed, using template fallback', err);
      return { markdown: ruleTemplate(id, prompt) };
    }
  },

  /* ---- DSL / Metric / Playground / Explorer handlers ---- */

  getFieldSchema: () => {
    return { fields: FIELD_SCHEMA };
  },

  getMetricPrimitives: () => {
    return { primitives: METRIC_PRIMITIVES };
  },

  getFunctionCatalog: () => {
    return { functions: FUNCTION_CATALOG };
  },

  getMetricList: () => {
    return { metrics: getAllMetrics().map(m => ({
      id: m.id, name: m.name, scope: m.scope, tags: m.tags,
      filterExpr: m.filterExpr, aggregationExpr: m.aggregationExpr,
      source: m.source,
    })) };
  },

  evaluateExpression: (a, _p, params) => {
    const expr = isString(params?.expr) ? params.expr : '';
    const scope = isString(params?.scope) ? params.scope : 'requests';
    if (!expr.trim()) return errorResult('Empty expression');

    const validErr = validateExpression(expr);
    if (validErr) return errorResult(validErr);

    const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
    const reqs = a.filterRequests(filter);
    const sessions = a.filterSessions(filter);
    const rows = pickRows(scope, reqs, sessions);

    try {
      const filterFn = compileFilter(expr);
      const matched = rows.filter(filterFn);
      const ratio = rows.length > 0 ? matched.length / rows.length : 0;
      const examples = matched.slice(0, 5).map(r => firstNonEmptyText(r.messageText, r.workspaceName, r.sessionId).substring(0, 100));
      return {
        matched: matched.length,
        total: rows.length,
        ratio: Math.round(ratio * 1000) / 10,
        examples,
      };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },

  calibrateRule: (a, _p, params) => {
    const ruleId = isString(params?.ruleId) ? params.ruleId : '';
    const rule = getRule(ruleId);
    if (!rule) return errorResult('Rule not found');

    const ext = parseRuleExtensions(rule.rawSource);
    if (!ext.filterExpr && !ext.metricRef) return errorResult('Rule has no DSL filter or metric reference');

    const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
    const reqs = a.filterRequests(filter);
    const sessions = a.filterSessions(filter);
    const rows = pickRows(rule.scope, reqs, sessions);

    const result = calibrate(
      ext.filterExpr || '',
      'ratio',
      ext.triggerExpr || '',
      rows,
      rule.thresholds,
    );

    return { calibration: result, comment: serializeCalibration(result) };
  },

  runRuleTests: (_a, _p, params) => {
    const ruleId = isString(params?.ruleId) ? params.ruleId : '';
    const rule = getRule(ruleId);
    if (!rule) return errorResult('Rule not found');

    const ext = parseRuleExtensions(rule.rawSource);
    if (ext.testCases.length === 0) return errorResult('No test cases found in rule');

    const results = runTestCases(
      ext.filterExpr || '',
      'ratio',
      ext.triggerExpr || '',
      ext.testCases,
      rule.thresholds,
    );
    const passed = results.filter(r => r.passed).length;
    return { results, passed, total: results.length };
  },

  compileNlRule: async (_a, _p, params) => {
    const prompt = isString(params?.prompt) ? params.prompt : '';
    if (!prompt.trim()) return errorResult('Empty prompt');
    const group = isString(params?.group) ? params.group : undefined;
    const severity = isString(params?.severity) ? params.severity : undefined;
    const scope = isString(params?.scope) ? params.scope : undefined;

    const result = await compileNaturalLanguageRule(prompt, { group, severity, scope });
    return {
      markdown: result.markdown,
      valid: !!result.rule,
      usedLlm: result.usedLlm,
      notes: result.notes,
    };
  },

  getDataExplorerFields: (a, _p, params) => {
    const filter = validateDateFilter(params || {});
    const reqs = a.filterRequests(filter);
    const sessions = a.filterSessions(filter);

    // Compute summary stats for each field
    const fieldSummaries = FIELD_SCHEMA.map(field => {
      const rows = pickRows(field.scope, reqs, sessions);

      const values = rows.map(r => r[field.name]).filter(v => v != null && v !== '' && v !== 0);
      const nonEmpty = values.length;
      const total = rows.length;
      const fillRate = total > 0 ? Math.round((nonEmpty / total) * 100) : 0;

      return {
        ...field,
        nonEmpty,
        total,
        fillRate,
      };
    });

    return { fields: fieldSummaries, requestCount: reqs.length, sessionCount: sessions.length };
  },

  getDataExplorer: (a, _p, params) => {
    const fieldName = isString(params?.field) ? params.field : '';
    if (!fieldName) return errorResult('No field specified');

    const fieldInfo = FIELD_SCHEMA.find(f => f.name === fieldName);
    if (!fieldInfo) return errorResult(`Unknown field: ${fieldName}`);

    const filter = isRecord(params?.filter) ? validateDateFilter(params.filter) : undefined;
    const reqs = a.filterRequests(filter);
    const sessions = a.filterSessions(filter);
    const rows = pickRows(fieldInfo.scope, reqs, sessions);

    const values = rows.map(r => r[fieldName]).filter(v => v != null);

    // Compute type-appropriate stats
    if (fieldInfo.type === 'number' || fieldInfo.type === 'number | null') {
      const nums = values.map(v => typeof v === 'number' ? v : 0).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
      return {
        field: fieldInfo,
        count: nums.length,
        stats: nums.length > 0 ? {
          min: nums[0],
          max: nums[nums.length - 1],
          avg: Math.round(nums.reduce((s, n) => s + n, 0) / nums.length * 10) / 10,
          p25: nums[Math.floor(nums.length * 0.25)],
          p50: nums[Math.floor(nums.length * 0.50)],
          p75: nums[Math.floor(nums.length * 0.75)],
        } : null,
        histogram: buildNumericHistogram(nums, 10),
      };
    }

    if (fieldInfo.type === 'boolean') {
      const trueCount = values.filter(v => v === true).length;
      return {
        field: fieldInfo,
        count: values.length,
        trueCount,
        falseCount: values.length - trueCount,
        trueRate: values.length > 0 ? Math.round((trueCount / values.length) * 1000) / 10 : 0,
      };
    }

    if (fieldInfo.type === 'string') {
      const freqMap = new Map<string, number>();
      for (const v of values) {
        const s = toDisplayText(v);
        if (!s) continue;
        freqMap.set(s, (freqMap.get(s) || 0) + 1);
      }
      const topValues = [...freqMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([value, count]) => ({ value, count, pct: Math.round((count / values.length) * 1000) / 10 }));
      return { field: fieldInfo, count: values.length, uniqueCount: freqMap.size, topValues };
    }

    if (fieldInfo.type === 'string[]' || fieldInfo.type === 'object[]') {
      const lengths = values.map(v => Array.isArray(v) ? v.length : 0);
      const avgLen = lengths.length > 0 ? Math.round(lengths.reduce((s, n) => s + n, 0) / lengths.length * 10) / 10 : 0;
      const emptyCount = lengths.filter(l => l === 0).length;
      return { field: fieldInfo, count: values.length, avgLength: avgLen, emptyCount, emptyRate: values.length > 0 ? Math.round((emptyCount / values.length) * 1000) / 10 : 0 };
    }

    return { field: fieldInfo, count: values.length };
  },

  importRegistryRules: () => {
    // The registry is the extension's own git repo - built-in rules are already loaded.
    // This endpoint returns the list of available built-in rules for import/review.
    const rules = getAllRules().filter(r => r.source === 'built-in');
    return {
      imported: rules.length,
      rules: rules.map(r => ({ id: r.id, name: r.name, group: r.group, severity: r.severity })),
    };
  },

  getRegistryCatalog: () => {
    const rules = getAllRules();
    const metrics = getAllMetrics();
    return {
      rules: rules.map(r => ({
        id: r.id, name: r.name, group: r.group, severity: r.severity,
        scope: r.scope, source: r.source, tags: r.tags, version: r.version,
      })),
      metrics: metrics.map(m => ({
        id: m.id, name: m.name, scope: m.scope, source: m.source, tags: m.tags,
      })),
    };
  },
};

function buildNumericHistogram(sorted: number[], buckets: number): { label: string; count: number }[] {
  if (sorted.length === 0) return [];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === max) return [{ label: String(min), count: sorted.length }];

  const step = (max - min) / buckets;
  const bins: { label: string; count: number }[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = min + i * step;
    const hi = i === buckets - 1 ? max + 1 : min + (i + 1) * step;
    const count = sorted.filter(v => v >= lo && v < hi).length;
    bins.push({ label: `${Math.round(lo)}-${Math.round(hi)}`, count });
  }
  return bins;
}

export function getRpcHandler(method: string): RpcHandler | undefined {
  if (!Object.prototype.hasOwnProperty.call(rpcHandlers, method)) return undefined;
  const handler = rpcHandlers[method as RpcMethodName];
  return typeof handler === 'function' ? handler : undefined;
}
