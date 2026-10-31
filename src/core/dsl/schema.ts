/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Field schema for SessionRequest and Session types.
 * Used by the Data Explorer and Rule Playground to show available fields.
 * Also used by the NL compiler to generate valid DSL expressions.
 */

export interface FieldInfo {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'string[]' | 'object' | 'object[]' | 'number | null';
  description: string;
  scope: 'request' | 'session' | 'both';
  example?: string;
}

export const FIELD_SCHEMA: FieldInfo[] = [
  // SessionRequest fields
  { name: 'requestId',          type: 'string',       description: 'Unique request identifier',                          scope: 'request' },
  { name: 'timestamp',          type: 'number | null', description: 'Request timestamp (epoch ms)',                      scope: 'request', example: '1713216000000' },
  { name: 'messageText',        type: 'string',       description: 'User message text',                                  scope: 'request' },
  { name: 'responseText',       type: 'string',       description: 'AI response text',                                   scope: 'request' },
  { name: 'isCanceled',         type: 'boolean',      description: 'Whether the request was canceled',                    scope: 'request' },
  { name: 'agentName',          type: 'string',       description: 'Agent name (copilot, custom agent, etc.)',            scope: 'request' },
  { name: 'agentMode',          type: 'string',       description: 'Agent mode: agent, ask, edit, plan, or custom agent name',  scope: 'request', example: '"agent"' },
  { name: 'modelId',            type: 'string',       description: 'Model identifier (gpt-4.1, claude-sonnet, etc.)',      scope: 'request', example: '"gpt-4.1"' },
  { name: 'toolsUsed',          type: 'string[]',     description: 'List of tools used in this request',                  scope: 'request' },
  { name: 'editedFiles',        type: 'string[]',     description: 'Files edited during this request',                    scope: 'request' },
  { name: 'referencedFiles',    type: 'string[]',     description: 'Files referenced via #file or @workspace',            scope: 'request' },
  { name: 'slashCommand',       type: 'string',       description: 'Slash command used (empty if none)',                   scope: 'request' },
  { name: 'variableKinds',      type: 'object',       description: 'Record<string,number> of variable kinds used',        scope: 'request', example: '{ "file": 2 }' },
  { name: 'customInstructions', type: 'string[]',     description: 'Custom instruction files active',                     scope: 'request' },
  { name: 'skillsUsed',         type: 'string[]',     description: 'Skills invoked during this request',                  scope: 'request' },
  { name: 'firstProgress',      type: 'number | null', description: 'Time to first progress event (ms)',                 scope: 'request' },
  { name: 'totalElapsed',       type: 'number | null', description: 'Total response time (ms)',                           scope: 'request' },
  { name: 'messageLength',      type: 'number',       description: 'User message length in characters',                   scope: 'request', example: '45' },
  { name: 'responseLength',     type: 'number',       description: 'AI response length in characters',                    scope: 'request' },
  { name: 'userCode',           type: 'object[]',     description: 'Code blocks in user message [{language, loc}]',       scope: 'request' },
  { name: 'aiCode',             type: 'object[]',     description: 'Code blocks in AI response [{language, loc}]',        scope: 'request' },
  { name: 'toolConfirmations',  type: 'object[]',     description: 'Tool confirmation events',                            scope: 'request' },
  { name: 'promptTokens',       type: 'number | null', description: 'Prompt token count (total input context size, includes cached portion)', scope: 'request' },
  { name: 'completionTokens',   type: 'number | null', description: 'Completion token count',                             scope: 'request' },
  { name: 'cacheReadTokens',    type: 'number | null', description: 'Cached tokens read (subset of promptTokens); null when the harness doesn\'t report cache usage, 0 when it reported none', scope: 'request' },
  { name: 'cacheWriteTokens',   type: 'number | null', description: 'Cached tokens written / cache creation; null when the harness doesn\'t report cache usage, 0 when it reported none', scope: 'request' },
  { name: 'reasoningEffort',    type: 'string',       description: 'Reasoning effort level (max | high | medium | low) when known', scope: 'request', example: '"high"' },
  { name: 'workType',           type: 'string',       description: 'Work type classification: feature, bugfix, refactor, etc.', scope: 'request' },

  // Session fields
  { name: 'sessionId',          type: 'string',       description: 'Unique session identifier',                           scope: 'session' },
  { name: 'workspaceId',        type: 'string',       description: 'Workspace identifier',                                scope: 'session' },
  { name: 'workspaceName',      type: 'string',       description: 'Workspace display name',                              scope: 'session' },
  { name: 'location',           type: 'string',       description: 'Workspace file path',                                 scope: 'session' },
  { name: 'harness',            type: 'string',       description: 'IDE harness: VS Code, Local Agent, Xcode, etc.',      scope: 'session', example: '"VS Code"' },
  { name: 'creationDate',       type: 'number | null', description: 'Session creation timestamp (epoch ms)',              scope: 'session' },
  { name: 'lastMessageDate',    type: 'number | null', description: 'Timestamp of last message (epoch ms)',               scope: 'session' },
  { name: 'requestCount',       type: 'number',       description: 'Number of requests in the session',                   scope: 'session', example: '12' },
  { name: 'requests',           type: 'object[]',     description: 'Array of SessionRequest objects',                     scope: 'session' },
  { name: 'hasDevcontainer',    type: 'boolean',      description: 'Session ran in a devcontainer (detected from runtime /workspaces/ paths)',  scope: 'session' },
  { name: 'customInstructionsBytes', type: 'number',  description: 'Bytes in .github/copilot-instructions.md (0 if absent)', scope: 'session', example: '4200' },
];

/** Built-in named metric primitives that can be referenced in .metric.md or .rule.md files. */
export interface MetricPrimitive {
  id: string;
  name: string;
  description: string;
  scope: 'requests' | 'sessions';
  /** DSL filter expression */
  filter: string;
  /** How to aggregate: ratio, count, sum(field), avg(field), etc. */
  aggregation: string;
  /** Example template for matching items */
  exampleTemplate?: string;
}

export const METRIC_PRIMITIVES: MetricPrimitive[] = [
  {
    id: 'cancel_rate',
    name: 'Cancellation Rate',
    description: 'Ratio of canceled requests to total requests',
    scope: 'requests',
    filter: 'isCanceled == true',
    aggregation: 'ratio',
  },
  {
    id: 'avg_message_length',
    name: 'Average Message Length',
    description: 'Average character length of user messages',
    scope: 'requests',
    filter: 'messageLength > 0',
    aggregation: 'avg(messageLength)',
  },
  {
    id: 'avg_response_time',
    name: 'Average Response Time',
    description: 'Average total elapsed time in milliseconds',
    scope: 'requests',
    filter: 'totalElapsed > 0',
    aggregation: 'avg(totalElapsed)',
  },
  {
    id: 'unique_models',
    name: 'Unique Models Used',
    description: 'Count of distinct model IDs',
    scope: 'requests',
    filter: 'modelId != ""',
    aggregation: 'unique(modelId)',
  },
  {
    id: 'files_per_request',
    name: 'File References per Request',
    description: 'Average number of referenced files per request',
    scope: 'requests',
    filter: 'messageLength > 0',
    aggregation: 'avg(referencedFiles.length)',
  },
  {
    id: 'session_length',
    name: 'Session Length',
    description: 'Average number of requests per session',
    scope: 'sessions',
    filter: 'requestCount > 0',
    aggregation: 'avg(requestCount)',
  },
  {
    id: 'tool_usage_rate',
    name: 'Tool Usage Rate',
    description: 'Ratio of requests that used at least one tool',
    scope: 'requests',
    filter: 'toolsUsed.length > 0',
    aggregation: 'ratio',
  },
  {
    id: 'agent_mode_rate',
    name: 'Agent Mode Usage',
    description: 'Ratio of requests using agentic modes (agent, plan, edit, custom)',
    scope: 'requests',
    filter: 'agentMode != "" && agentMode != "chat" && agentMode != "ask"',
    aggregation: 'ratio',
  },
  {
    id: 'code_output_rate',
    name: 'Code Output Rate',
    description: 'Ratio of requests that produced code blocks',
    scope: 'requests',
    filter: 'aiCode.length > 0',
    aggregation: 'ratio',
  },
  {
    id: 'custom_instructions_rate',
    name: 'Custom Instructions Rate',
    description: 'Ratio of requests with custom instructions active',
    scope: 'requests',
    filter: 'customInstructions.length > 0',
    aggregation: 'ratio',
  },
];

/** Available DSL functions for documentation and autocomplete. */
export interface FunctionInfo {
  name: string;
  signature: string;
  description: string;
  category: 'string' | 'math' | 'date' | 'array' | 'object' | 'utility';
}

export const FUNCTION_CATALOG: FunctionInfo[] = [
  { name: 'length',     signature: 'length(x)',           description: 'Array or string length',        category: 'string' },
  { name: 'contains',   signature: 'contains(s, sub)',    description: 'String contains substring',     category: 'string' },
  { name: 'startsWith', signature: 'startsWith(s, sub)',  description: 'String starts with prefix',     category: 'string' },
  { name: 'endsWith',   signature: 'endsWith(s, sub)',    description: 'String ends with suffix',       category: 'string' },
  { name: 'matches',    signature: 'matches(s, /re/)',    description: 'Regex match',                   category: 'string' },
  { name: 'lower',      signature: 'lower(s)',            description: 'To lower case',                 category: 'string' },
  { name: 'upper',      signature: 'upper(s)',            description: 'To upper case',                 category: 'string' },
  { name: 'trim',       signature: 'trim(s)',             description: 'Strip whitespace',              category: 'string' },
  { name: 'truncate',   signature: 'truncate(s, n)',      description: 'Truncate to n chars',           category: 'string' },
  { name: 'split',      signature: 'split(s, sep)',       description: 'Split into array',              category: 'string' },
  { name: 'join',       signature: 'join(arr, sep)',      description: 'Join array to string',          category: 'string' },
  { name: 'abs',        signature: 'abs(n)',              description: 'Absolute value',                category: 'math' },
  { name: 'floor',      signature: 'floor(n)',            description: 'Floor',                         category: 'math' },
  { name: 'ceil',       signature: 'ceil(n)',             description: 'Ceiling',                       category: 'math' },
  { name: 'round',      signature: 'round(n)',            description: 'Round',                         category: 'math' },
  { name: 'min',        signature: 'min(a, b)',           description: 'Minimum of two values',         category: 'math' },
  { name: 'max',        signature: 'max(a, b)',           description: 'Maximum of two values',         category: 'math' },
  { name: 'hour',       signature: 'hour(ts)',            description: 'Extract hour (0-23) from ms',   category: 'date' },
  { name: 'dayOfWeek',  signature: 'dayOfWeek(ts)',       description: 'Day of week (0=Sun)',           category: 'date' },
  { name: 'month',      signature: 'month(ts)',           description: 'Month (0=Jan)',                 category: 'date' },
  { name: 'year',       signature: 'year(ts)',            description: 'Full year',                     category: 'date' },
  { name: 'includes',   signature: 'includes(arr, val)',  description: 'Array includes value',          category: 'array' },
  { name: 'some',       signature: 'some(arr, field)',    description: 'Any element has truthy field',  category: 'array' },
  { name: 'count',      signature: 'count(arr)',          description: 'Array length',                  category: 'array' },
  { name: 'sum',        signature: 'sum(arr, field)',     description: 'Sum numeric field across array',category: 'array' },
  { name: 'avg',        signature: 'avg(arr, field)',     description: 'Average numeric field',         category: 'array' },
  { name: 'unique',     signature: 'unique(arr, field)',  description: 'Count distinct values',         category: 'array' },
  { name: 'flatUnique', signature: 'flatUnique(arr, field)', description: 'Count distinct values across sub-arrays', category: 'array' },
  { name: 'reasoningEffortStats', signature: 'reasoningEffortStats(reqs[, level])', description: 'Premium reasoning-effort usage ratio (level: "high"|"max")', category: 'array' },
  { name: 'instructionBloatStats', signature: 'instructionBloatStats(sessions[, maxBytes])', description: 'Custom-instructions size analysis per workspace', category: 'array' },

  { name: 'excessFileContextStats', signature: 'excessFileContextStats(reqs[, minFiles])', description: 'Outlier requests with huge referencedFiles arrays', category: 'array' },
  { name: 'hasSkillByPattern', signature: 'hasSkillByPattern(reqs, /pat/)', description: '1 if any skillsUsed entry matches the regex', category: 'array' },
  { name: 'keys',       signature: 'keys(obj)',           description: 'Object keys',                  category: 'object' },
  { name: 'values',     signature: 'values(obj)',         description: 'Object values',                 category: 'object' },
  { name: 'has',        signature: 'has(obj, key)',       description: 'Object has key',                category: 'object' },
  { name: 'coalesce',   signature: 'coalesce(a, b, ...)',description: 'First non-null value',          category: 'utility' },
  { name: 'iif',        signature: 'iif(cond, t, f)',    description: 'Conditional expression',        category: 'utility' },
];
