/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* LLM schemas and request helpers for the dashboard panel. */

import * as vscode from 'vscode';
import { runtimeDebug } from '../core/runtime-debug';
import {
  listCandidateModels,
  listAvailableModels,
  setPreferredModelId,
  getPreferredModelId,
  type AvailableModel,
} from '../core/llm-models';

// Re-exported so existing importers keep a single entry point while model
// selection lives centrally in core/llm-models.
export { listAvailableModels, setPreferredModelId, getPreferredModelId };
export type { AvailableModel };

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

function structuredOutputOptions(spec: JsonSchemaSpec): Record<string, unknown> {
  return {
    response_format: {
      type: 'json_schema',
      json_schema: { name: spec.name, strict: true, schema: spec.schema },
    },
  };
}

export const SCHEMA_QUIZ: JsonSchemaSpec = {
  name: 'quiz_questions',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            choices: { type: 'array', items: { type: 'string' } },
            correctIndex: { type: 'number' },
            explanation: { type: 'string' },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
            topic: { type: 'string' },
          },
          required: ['question', 'choices', 'correctIndex', 'explanation', 'difficulty', 'topic'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

export const SCHEMA_CODE_REVIEW: JsonSchemaSpec = {
  name: 'code_comparison_rounds',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            snippetA: { type: 'string' },
            snippetB: { type: 'string' },
            betterSnippet: { type: 'string', enum: ['A', 'B'] },
            title: { type: 'string' },
            category: { type: 'string', enum: ['performance', 'safety', 'readability', 'correctness', 'security'] },
            explanation: { type: 'string' },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
            language: { type: 'string' },
          },
          required: ['snippetA', 'snippetB', 'betterSnippet', 'title', 'category', 'explanation', 'difficulty', 'language'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

export const SCHEMA_DID_YOU_KNOW: JsonSchemaSpec = {
  name: 'did_you_know_facts',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fact: { type: 'string' },
            project: { type: 'string' },
            category: { type: 'string', enum: ['performance', 'api', 'pitfall', 'config', 'debug'] },
          },
          required: ['fact', 'project', 'category'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

export const SCHEMA_RESOURCES: JsonSchemaSpec = {
  name: 'learning_resources',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            type: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['title', 'url', 'type', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

export const SCHEMA_TRIAGE: JsonSchemaSpec = {
  name: 'skill_triage',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The cluster id this verdict refers to, copied from the input.' },
            verdict: { type: 'string', enum: ['strong', 'maybe', 'skip'], description: 'Whether the cluster is a strong, maybe, or skip candidate for a skill file.' },
            reason: { type: 'string', description: 'One sentence explaining the verdict.' },
            suggestedSkillName: { type: 'string', description: 'Short kebab-case skill name, or an empty string when no skill is suggested.' },
          },
          required: ['id', 'verdict', 'reason', 'suggestedSkillName'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

export const SCHEMA_CATALOG_PICKS: JsonSchemaSpec = {
  name: 'catalog_picks',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

export const SCHEMA_CONTEXT_REVIEW: JsonSchemaSpec = {
  name: 'context_file_review',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            workspaceId: { type: 'string' },
            overallScore: { type: 'number' },
            categoryScores: { type: 'object', additionalProperties: { type: 'number' } },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  category: { type: 'string' },
                  severity: { type: 'string', enum: ['good', 'warning', 'critical'] },
                  file: { type: 'string' },
                  finding: { type: 'string' },
                  suggestion: { type: 'string' },
                },
                required: ['category', 'severity', 'file', 'finding', 'suggestion'],
                additionalProperties: false,
              },
            },
            missingFiles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: { type: 'string' },
                  reason: { type: 'string' },
                  impact: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
                required: ['filename', 'reason', 'impact'],
                additionalProperties: false,
              },
            },
            summary: { type: 'string' },
          },
          required: ['workspaceId', 'overallScore', 'categoryScores', 'findings', 'missingFiles', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

function parseLlmJson<T>(text: string): T {
  let cleaned = text.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replaceAll(/^```(?:json|jsonc|jsonl)?\s*/gm, '').replaceAll(/```\s*$/gm, '').trim();

  // Strip single-line JS comments that LLMs sometimes insert
  cleaned = cleaned.replaceAll(/^\s*\/\/[^\n]*$/gm, '');

  // Handle JSONL: if the text has multiple top-level JSON objects on separate lines, wrap in array
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every(l => l.startsWith('{') && l.endsWith('}'))) {
    const jsonlArray = '[' + lines.join(',') + ']';
    try { return JSON.parse(jsonlArray) as T; } catch { /* fall through */ }
  }

  // Locate the outermost JSON boundary
  const arrStart = cleaned.indexOf('[');
  const objStart = cleaned.indexOf('{');
  if (arrStart === -1 && objStart === -1) throw new Error('No JSON structure found in LLM response');

  let start: number;
  if (arrStart === -1) start = objStart;
  else if (objStart === -1) start = arrStart;
  else start = Math.min(arrStart, objStart);

  const openChar = cleaned[start];
  const closeChar = openChar === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(closeChar);
  if (end <= start) throw new Error('Malformed JSON structure in LLM response');

  cleaned = cleaned.slice(start, end + 1);

  // Attempt 1: direct parse
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }

  // Attempt 2: fix common LLM quirks
  let fixed = cleaned;
  // Remove trailing commas before closing brackets/braces
  fixed = fixed.replaceAll(/,\s*([}\]])/g, '$1');
  // Replace smart/curly quotes with straight ones
  fixed = fixed.replaceAll(/[\u201C\u201D\u2033]/g, '"').replaceAll(/[\u2018\u2019\u2032]/g, "'");
  // Fix single-quoted strings to double-quoted (simple heuristic for keys/values)
  fixed = fixed.replaceAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  // Remove control characters except \n \r \t
  // eslint-disable-next-line no-control-regex
  fixed = fixed.replaceAll(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  try { return JSON.parse(fixed) as T; } catch { /* fall through */ }

  // Attempt 3: close a truncated response by balancing unclosed strings and
  // brackets in the correct order, then dropping any dangling trailing comma.
  const balanced = balanceTruncatedJson(fixed).replaceAll(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(balanced) as T; } catch { /* fall through */ }

  throw new Error('Failed to parse JSON from LLM response');
}

/**
 * Repair JSON that was cut off mid-stream (e.g. when the model hit its output
 * token limit). Walks the text tracking string state and a stack of open
 * brackets, then appends the closers needed to make it parseable. Works for
 * both array-root and object-wrapped payloads.
 */
function balanceTruncatedJson(input: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') closers.push('}');
    else if (char === '[') closers.push(']');
    else if (char === '}' || char === ']') closers.pop();
  }

  let result = input;
  if (inString) result += '"';
  for (let i = closers.length - 1; i >= 0; i--) result += closers[i];
  return result;
}

const LLM_MAX_RETRIES = 2;
/** Hard cap for a single LLM streaming request (ms). Prevents the UI from
 *  spinning forever when the model hangs or the user never grants consent. */
const LLM_REQUEST_TIMEOUT_MS = 90_000;

/** Shown when every available model returns an empty response (all disabled). */
const EMPTY_RESPONSE_MESSAGE =
  'Every available language model returned an empty response after multiple attempts. ' +
  'Some models can be disabled for your Copilot plan or organization. ' +
  'Pick a specific model from the "AI Model" selector in the dashboard sidebar and try again.';

/** Race a promise against a timeout. Rejects with a clear message on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => {
      clearTimeout(t);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

export async function callLlm(messages: vscode.LanguageModelChatMessage[]): Promise<string> {
  const candidates = await listCandidateModels();

  let lastError: unknown;
  let sawEmpty = false;
  for (const model of candidates) {
    for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
      const cts = new vscode.CancellationTokenSource();
      try {
        const streamText = async () => {
          const response = await model.sendRequest(messages, {}, cts.token);
          let text = '';
          for await (const chunk of response.text) text += chunk;
          return text;
        };
        const text = await withTimeout(streamText(), LLM_REQUEST_TIMEOUT_MS, 'LLM request');
        // An empty response usually means this model is disabled for the plan or
        // organization but still selectable — move on to the next candidate.
        if (text.trim().length === 0) {
          sawEmpty = true;
          runtimeDebug('panel-llm', 'empty-response', `model=${model.id}(${model.family}) plain attempt=${attempt + 1}`);
          break;
        }
        return text;
      } catch (err) {
        cts.cancel();
        lastError = err;
        if (err instanceof vscode.CancellationError) throw err;
      } finally {
        cts.dispose();
      }
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(sawEmpty ? EMPTY_RESPONSE_MESSAGE : 'LLM request failed');
}

type JsonAttemptOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'empty' }
  | { kind: 'error'; error: unknown; parseFailures: number };

/**
 * Run the retry loop for a single model: stream the response, parse JSON,
 * recover from structured-output rejections and nudge the model back to valid
 * JSON. Returns a value on success, `empty` when the model returned nothing
 * (likely disabled for the plan/organization) or `error` with the last failure.
 */
async function requestJsonFromModel<T>(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  jsonSchema?: JsonSchemaSpec,
): Promise<JsonAttemptOutcome<T>> {
  const options: vscode.LanguageModelChatRequestOptions = jsonSchema
    ? { modelOptions: structuredOutputOptions(jsonSchema) }
    : {};
  const retryMessages = [...messages];
  let lastError: unknown;
  let parseFailures = 0;
  let sawEmpty = false;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const cts = new vscode.CancellationTokenSource();
    let text = '';
    try {
      const response = await model.sendRequest(retryMessages, options, cts.token);
      for await (const chunk of response.text) text += chunk;
      // An empty response usually means this model is disabled for the plan or
      // organization but still selectable. Drop structured output first (in
      // case that is the cause), then signal the caller to try the next model.
      if (text.trim().length === 0) {
        sawEmpty = true;
        runtimeDebug('panel-llm', 'empty-response',
          `model=${model.id}(${model.family}) schema=${jsonSchema?.name ?? 'none'} attempt=${attempt + 1} hadModelOptions=${options.modelOptions !== undefined}`);
        if (options.modelOptions) { options.modelOptions = undefined; continue; }
        break;
      }
      try {
        return { kind: 'value', value: JSON.parse(text.trim()) as T };
      } catch {
        return { kind: 'value', value: parseLlmJson<T>(text) };
      }
    } catch (err) {
      lastError = err;
      runtimeDebug('panel-llm', 'call-failed',
        `schema=${jsonSchema?.name ?? 'none'} attempt=${attempt + 1} structured=${options.modelOptions !== undefined} ` +
        `model=${model.id} textLen=${text.length} error=${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof vscode.CancellationError) { cts.dispose(); throw err; }
      // Drop structured output so later attempts can recover in plain mode.
      if (jsonSchema && options.modelOptions && err instanceof Error &&
          /response_format|modelOptions|not supported|JSON|parse/i.test(err.message)) {
        options.modelOptions = undefined;
      }
      // On parse failures, nudge the model to return valid JSON on the next attempt.
      if (err instanceof Error && /JSON|parse/i.test(err.message)) {
        parseFailures++;
        if (retryMessages.length === messages.length) {
          retryMessages.push(vscode.LanguageModelChatMessage.User(
            'Your previous response was not valid JSON. Please respond ONLY with a valid JSON object or array, no markdown fences, no commentary.'
          ));
        }
      }
    } finally {
      cts.dispose();
    }
  }

  if (sawEmpty) return { kind: 'empty' };
  return { kind: 'error', error: lastError, parseFailures };
}

export async function callLlmJson<T>(messages: vscode.LanguageModelChatMessage[], jsonSchema?: JsonSchemaSpec): Promise<T> {
  const candidates = await listCandidateModels();

  let lastError: unknown;
  let parseFailures = 0;
  let sawEmpty = false;

  for (const model of candidates) {
    const outcome = await requestJsonFromModel<T>(model, messages, jsonSchema);
    if (outcome.kind === 'value') return outcome.value;
    if (outcome.kind === 'empty') { sawEmpty = true; continue; }
    lastError = outcome.error;
    parseFailures += outcome.parseFailures;
  }

  let label: string;
  if (parseFailures > 0) {
    label = `LLM returned invalid JSON after ${LLM_MAX_RETRIES + 1} attempts. Please try again.`;
  } else if (lastError instanceof Error) {
    label = lastError.message;
  } else if (sawEmpty) {
    label = EMPTY_RESPONSE_MESSAGE;
  } else {
    label = 'LLM request failed after retries';
  }
  throw new Error(label);
}
