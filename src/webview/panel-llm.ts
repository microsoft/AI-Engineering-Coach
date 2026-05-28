/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* LLM schemas and request helpers for the dashboard panel. */

import * as vscode from 'vscode';

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
            id: { type: 'string' },
            verdict: { type: 'string', enum: ['strong', 'maybe', 'skip'] },
            reason: { type: 'string' },
            suggestedSkillName: { type: ['string', 'null'] },
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

  // Attempt 3: balance unmatched brackets
  const opens = (fixed.match(/[{[]/g) || []).length;
  const closes = (fixed.match(/[}\]]/g) || []).length;
  for (let i = 0; i < opens - closes; i++) {
    const lastOpen = Math.max(fixed.lastIndexOf('{'), fixed.lastIndexOf('['));
    fixed += fixed[lastOpen] === '{' ? '}' : ']';
  }

  try { return JSON.parse(fixed) as T; } catch { /* fall through */ }

  // Attempt 4: truncate to last complete object in an array
  const lastCompleteA = fixed.lastIndexOf('}]');
  const lastCompleteB = fixed.lastIndexOf('},');
  const lastComplete = Math.max(lastCompleteA, lastCompleteB);
  if (lastComplete > 0) {
    const truncated = fixed.slice(0, lastComplete + 1) + ']';
    try { return JSON.parse(truncated) as T; } catch { /* fall through */ }
  }

  throw new Error('Failed to parse JSON from LLM response');
}

const LLM_MAX_RETRIES = 2;
const LLM_FAMILY = 'gpt-4.1';
/** Hard cap for a single LLM streaming request (ms). Prevents the UI from
 *  spinning forever when the model hangs or the user never grants consent. */
const LLM_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Pick a Copilot chat model. Tries the preferred family first, then a short
 * fallback list, then any available model. Throws a descriptive error when
 * nothing is available so callers can surface a useful message.
 */
async function selectModel(): Promise<vscode.LanguageModelChat> {
  const families = [LLM_FAMILY, 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4', 'claude-sonnet', 'claude-3.5-sonnet', 'o4-mini', 'o3-mini'];
  for (const family of families) {
    const models = await vscode.lm.selectChatModels({ family });
    if (models.length > 0) return models[0];
  }
  const any = await vscode.lm.selectChatModels({});
  if (any.length > 0) return any[0];
  throw new Error('No language model available. Make sure GitHub Copilot is installed and signed in.');
}

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
  const model = await selectModel();

  let lastError: unknown;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const cts = new vscode.CancellationTokenSource();
    try {
      const streamText = async () => {
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = '';
        for await (const chunk of response.text) text += chunk;
        return text;
      };
      return await withTimeout(streamText(), LLM_REQUEST_TIMEOUT_MS, 'LLM request');
    } catch (err) {
      cts.cancel();
      lastError = err;
      if (err instanceof vscode.CancellationError) throw err;
    } finally {
      cts.dispose();
    }
  }
  throw lastError;
}

export async function callLlmJson<T>(messages: vscode.LanguageModelChatMessage[], jsonSchema?: JsonSchemaSpec): Promise<T> {
  const model = await selectModel();

  const options: vscode.LanguageModelChatRequestOptions = jsonSchema
    ? { modelOptions: structuredOutputOptions(jsonSchema) }
    : {};

  let lastError: unknown;
  let parseFailures = 0;
  const retryMessages = [...messages];

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const cts = new vscode.CancellationTokenSource();
    try {
      const response = await model.sendRequest(retryMessages, options, cts.token);
      let text = '';
      for await (const chunk of response.text) text += chunk;
      try {
        return JSON.parse(text.trim()) as T;
      } catch {
        return parseLlmJson<T>(text);
      }
    } catch (err) {
      lastError = err;
      if (err instanceof vscode.CancellationError) { cts.dispose(); throw err; }
      // If structured output isn't supported, fall back to plain mode
      if (attempt === 0 && jsonSchema && lastError instanceof Error && /response_format|modelOptions|not supported/i.test(lastError.message)) {
        options.modelOptions = undefined;
      }
      // On parse failures, nudge the model to return valid JSON on the next attempt
      if (lastError instanceof Error && /JSON|parse/i.test(lastError.message)) {
        parseFailures++;
        // Після першого parse failure, скидаємо structured output і додаємо explicit JSON instruction
        options.modelOptions = undefined;
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

  const label = parseFailures > 0
    ? `LLM returned invalid JSON after ${LLM_MAX_RETRIES + 1} attempts. Please try again.`
    : (lastError instanceof Error ? lastError.message : 'LLM request failed after retries');
  throw new Error(label);
}