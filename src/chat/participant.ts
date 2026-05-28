/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @aicoach chat participant — conversational interface to AI Engineer Coach data.
 * Delegates tool calls to the LM tools registered in tools.ts.
 */

import * as vscode from 'vscode';
import { TOOL_DEFS } from '../mcp/tools';
import { buildSystemPrompt } from './system-prompt';

const PARTICIPANT_ID = 'aiEngineerCoach.aicoach';
const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY_CHARS = 12_000;

/* ---- slash commands ---- */

interface SlashCommand {
  name: string;
  description: string;
  /** Injected into the user prompt when the slash command is used with no additional text. */
  defaultPrompt: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'summary', description: 'Get a quick summary of your AI coding usage', defaultPrompt: 'Give me a concise overview of my AI coding usage, highlighting strengths and top areas to improve.' },
  { name: 'improve', description: 'Get improvement recommendations', defaultPrompt: 'Analyze my usage patterns and give me the top 3 things I should improve, with specific actions.' },
  { name: 'compare', description: 'Compare your AI coding tools', defaultPrompt: 'Compare the AI coding tools I use and tell me which is most effective for what.' },
  { name: 'flow', description: 'Analyze your flow & focus', defaultPrompt: 'Analyze my flow state and deep work patterns. When am I most productive, and how can I protect that time?' },
];

/* ---- build tools array for sendRequest ---- */

function getChatTools(): vscode.LanguageModelChatTool[] {
  return TOOL_DEFS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/* ---- conversation history ---- */

/**
 * Convert prior chat turns into LanguageModelChatMessages so the model
 * has awareness of the ongoing conversation — including turns handled by
 * other participants (e.g. default Copilot, @workspace).
 */
function buildHistoryMessages(
  history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
): vscode.LanguageModelChatMessage[] {
  const msgs: vscode.LanguageModelChatMessage[] = [];
  let totalChars = 0;

  // Convert history in its natural order, then walk `entries` backward below
  // so we keep the most recent turns while dropping older ones when over budget.
  const entries: vscode.LanguageModelChatMessage[] = [];
  for (const turn of history) {
    if ('prompt' in turn) {
      const label = turn.participant && turn.participant !== PARTICIPANT_ID
        ? `[User to @${turn.participant}]: `
        : '';
      entries.push(vscode.LanguageModelChatMessage.User(`${label}${turn.prompt}`));
    } else if ('response' in turn) {
      const text = turn.response
        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => p.value.value)
        .join('');
      if (!text) continue;
      const label = turn.participant && turn.participant !== PARTICIPANT_ID
        ? `[@${turn.participant}]: `
        : '';
      entries.push(vscode.LanguageModelChatMessage.Assistant(`${label}${text}`));
    }
  }

  // Keep most recent turns within budget
  for (let i = entries.length - 1; i >= 0; i--) {
    const content = entries[i].content as unknown[];
    const len = content.reduce((n: number, p: unknown) => {
      if (p && typeof p === 'object' && 'value' in p) return n + String((p as { value: string }).value).length;
      return n;
    }, 0);
    if (totalChars + len > MAX_HISTORY_CHARS) break;
    totalChars += len;
    msgs.unshift(entries[i]);
  }

  return msgs;
}

/* ---- agentic tool loop ---- */

async function runAgenticLoop(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = resolveUserPrompt(request);
  const historyMessages = buildHistoryMessages(chatContext.history);

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    ...historyMessages,
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];

  const tools = getChatTools();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const chatResponse = await request.model.sendRequest(messages, { tools }, token);

    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let textSoFar = '';

    for await (const chunk of chatResponse.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        textSoFar += chunk.value;
        response.markdown(chunk.value);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(chunk);
      }
    }

    // No tool calls → model is done
    if (toolCalls.length === 0) {
      return {};
    }

    // Append assistant message with tool calls
    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    if (textSoFar) {
      assistantParts.push(new vscode.LanguageModelTextPart(textSoFar));
    }
    assistantParts.push(...toolCalls);
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    // Invoke each tool and collect results
    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      response.progress(`Calling ${call.name}…`);
      const result = await vscode.lm.invokeTool(call.name, {
        input: call.input,
        toolInvocationToken: request.toolInvocationToken,
      }, token);

      resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
    }

    // Append user message with tool results
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
  }

  // Exhausted rounds
  response.markdown('\n\n*Reached the maximum number of tool calls. Please ask a more focused question.*');
  return {};
}

/* ---- prompt resolution ---- */

function resolveUserPrompt(request: vscode.ChatRequest): string {
  if (request.command) {
    const cmd = SLASH_COMMANDS.find(c => c.name === request.command);
    if (cmd) {
      return request.prompt.trim() || cmd.defaultPrompt;
    }
  }
  return request.prompt || 'Give me a coaching summary.';
}

/* ---- follow-ups ---- */

function getFollowups(result: vscode.ChatResult): vscode.ChatFollowup[] {
  const meta = result.metadata as Record<string, unknown> | undefined;
  if (meta?.['suppressFollowups']) return [];

  return [
    { prompt: 'What should I improve next?', label: 'Improve', command: 'improve' },
    { prompt: 'Compare my AI tools', label: 'Compare tools', command: 'compare' },
    { prompt: 'How is my focus & flow?', label: 'Flow state', command: 'flow' },
  ];
}

/* ---- registration ---- */

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token) => {
    return runAgenticLoop(request, chatContext, response, token);
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');

  participant.followupProvider = {
    provideFollowups(result, _context, _token) {
      return getFollowups(result);
    },
  };

  context.subscriptions.push(participant);
}

export { SLASH_COMMANDS, PARTICIPANT_ID };
