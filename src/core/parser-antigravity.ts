/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Antigravity (Google) agent conversation parser
 *
 * Data layout:
 *   ~/.gemini/antigravity-cli/conversations/<conversation-uuid>.db   -- one SQLite db per conversation
 *   ~/.gemini/antigravity-cli/cache/last_conversations.json          -- {cwd: conversation-uuid} map
 *
 * Each conversation db has a `steps` table (idx, step_type, step_payload)
 * where step_payload is an undocumented protobuf blob. The field numbers used
 * below were reverse-engineered from real conversations and are read with a
 * minimal protobuf wire-format decoder; every access is best-effort, so a
 * schema drift degrades to missing data instead of a crash:
 *
 *   field 5   step metadata
 *     5.1     google.protobuf.Timestamp {1: seconds, 2: nanos}
 *     5.4     tool call {1: id, 2: tool name, 3: arguments JSON}
 *     5.9     generation usage {2: input tokens, 3: output tokens}
 *   field 19  user message {2: prompt text}          (step_type 14)
 *   field 20  model generation {1: response text, 3: thinking,
 *             7: tool call {2: name, 3: arguments JSON}}   (step_type 15)
 *
 * Requires the node:sqlite builtin (Node >= 22.5); the source is skipped
 * gracefully when it is unavailable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';

const STEP_TYPE_USER_MESSAGE = 14;

const AG_WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'edit_file', 'multi_edit', 'write_file']);
const AG_READ_TOOLS = new Set(['view_file', 'view_code_item', 'find_by_name', 'grep_search', 'list_dir', 'read_file']);

type NodeSqlite = typeof import('node:sqlite');

function loadNodeSqlite(): NodeSqlite | null {
  try {
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    return (getBuiltinModule?.call(process, 'node:sqlite') as NodeSqlite | undefined) ?? null;
  } catch {
    return null;
  }
}

export function findAntigravityDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const conversationsDir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  return fs.existsSync(conversationsDir) ? [conversationsDir] : [];
}

/* ------------------------------- protobuf ------------------------------- */

type ProtoValue = bigint | Buffer;
type ProtoFields = Map<number, ProtoValue[]>;

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let p = pos;

  while (p < buf.length) {
    const byte = buf[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, p];
    shift += 7n;
  }

  return [result, p];
}

/** Decodes one message level of protobuf wire format; returns null on malformed input. */
function decodeProto(buf: Buffer): ProtoFields | null {
  const fields: ProtoFields = new Map();
  let pos = 0;

  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);

    const fieldNo = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNo === 0) return null;

    let value: ProtoValue;

    if (wireType === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) return null;
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) return null;
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else if (wireType === 2) {
      let length: bigint;
      [length, pos] = readVarint(buf, pos);
      const end = pos + Number(length);
      if (end > buf.length) return null;
      value = buf.subarray(pos, end);
      pos = end;
    } else {
      return null;
    }

    const existing = fields.get(fieldNo);
    if (existing) existing.push(value);
    else fields.set(fieldNo, [value]);
  }

  return fields;
}

function subMessage(fields: ProtoFields | null, fieldNo: number): ProtoFields | null {
  const value = fields?.get(fieldNo)?.[0];
  return Buffer.isBuffer(value) ? decodeProto(value) : null;
}

function intField(fields: ProtoFields | null, fieldNo: number): number | null {
  const value = fields?.get(fieldNo)?.[0];
  return typeof value === 'bigint' ? Number(value) : null;
}

function stringField(fields: ProtoFields | null, fieldNo: number): string | null {
  const value = fields?.get(fieldNo)?.[0];
  if (!Buffer.isBuffer(value)) return null;

  const text = value.toString('utf8');
  // Reject buffers that are clearly nested messages rather than text.
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? null : text;
}

/* ------------------------------ step reading ----------------------------- */

interface AgStep {
  stepType: number;
  timestampMs: number | null;
  userText: string | null;
  responseText: string | null;
  toolName: string | null;
  toolArgsJson: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function timestampMsOf(meta: ProtoFields | null): number | null {
  const ts = subMessage(meta, 1);
  const seconds = intField(ts, 1);
  return seconds ? seconds * 1000 : null;
}

function readStep(stepType: number, payload: Buffer): AgStep | null {
  const root = decodeProto(payload);
  if (!root) return null;

  const meta = subMessage(root, 5);
  const metaTool = subMessage(meta, 4);
  const usage = subMessage(meta, 9);
  const userMessage = subMessage(root, 19);
  const generation = subMessage(root, 20);
  const generationTool = subMessage(generation, 7);

  return {
    stepType,
    timestampMs: timestampMsOf(meta),
    userText: stringField(userMessage, 2),
    responseText: stringField(generation, 1),
    toolName: stringField(metaTool, 2) ?? stringField(generationTool, 2),
    toolArgsJson: stringField(metaTool, 3) ?? stringField(generationTool, 3),
    inputTokens: intField(usage, 2),
    outputTokens: intField(usage, 3),
  };
}

/* ---------------------------- session assembly --------------------------- */

interface AgTurnData {
  textParts: string[];
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  inputTokens: number;
  outputTokens: number;
  sawUsage: boolean;
  lastTs: number | null;
}

function filePathFromArgs(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const candidate = args['AbsolutePath'] ?? args['TargetFile'] ?? args['SearchDirectory'] ?? args['path'];
    return typeof candidate === 'string' ? candidate : null;
  } catch {
    return null;
  }
}

function applyAgStep(step: AgStep, turn: AgTurnData): void {
  if (step.timestampMs && (!turn.lastTs || step.timestampMs > turn.lastTs)) turn.lastTs = step.timestampMs;
  if (step.responseText) turn.textParts.push(step.responseText);

  if (step.inputTokens !== null || step.outputTokens !== null) {
    turn.sawUsage = true;
    turn.inputTokens += step.inputTokens ?? 0;
    turn.outputTokens += step.outputTokens ?? 0;
  }

  if (!step.toolName) return;
  turn.toolsUsed.push(step.toolName);

  const filePath = filePathFromArgs(step.toolArgsJson);
  if (!filePath) return;

  const tool = step.toolName.toLowerCase();
  if (AG_WRITE_TOOLS.has(tool)) turn.editedFiles.push(filePath);
  else if (AG_READ_TOOLS.has(tool)) turn.referencedFiles.push(filePath);
}

function buildAgRequest(userStep: AgStep, turn: AgTurnData): SessionRequest {
  const userTs = userStep.timestampMs;

  return createRequest({
    timestamp: userTs,
    messageText: userStep.userText ?? '',
    responseText: turn.textParts.join('\n'),
    agentName: 'Antigravity',
    toolsUsed: turn.toolsUsed,
    editedFiles: [...new Set(turn.editedFiles)],
    referencedFiles: [...new Set(turn.referencedFiles)],
    totalElapsed: userTs && turn.lastTs && turn.lastTs > userTs ? turn.lastTs - userTs : null,
    promptTokens: turn.sawUsage ? turn.inputTokens : null,
    completionTokens: turn.sawUsage ? turn.outputTokens : null,
  });
}

function buildAgRequests(steps: AgStep[]): SessionRequest[] {
  const requests: SessionRequest[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.stepType !== STEP_TYPE_USER_MESSAGE || !step.userText) continue;

    const turn: AgTurnData = {
      textParts: [],
      toolsUsed: [],
      editedFiles: [],
      referencedFiles: [],
      inputTokens: 0,
      outputTokens: 0,
      sawUsage: false,
      lastTs: step.timestampMs,
    };

    let j = i + 1;
    for (; j < steps.length; j++) {
      if (steps[j].stepType === STEP_TYPE_USER_MESSAGE && steps[j].userText) break;
      applyAgStep(steps[j], turn);
    }

    requests.push(buildAgRequest(step, turn));
    i = j - 1;
  }

  return requests;
}

/** Reads {cwd: conversation-id} from cache/last_conversations.json and inverts it. */
function readConversationCwdMap(conversationsDir: string): Map<string, string> {
  const result = new Map<string, string>();
  const cachePath = path.join(path.dirname(conversationsDir), 'cache', 'last_conversations.json');

  try {
    assertTrustedPath(cachePath);
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    for (const [cwd, conversationId] of Object.entries(raw)) {
      if (typeof conversationId === 'string') result.set(conversationId, cwd);
    }
  } catch {
    /* no cwd mapping available */
  }

  return result;
}

function parseAgConversation(sqlite: NodeSqlite, dbPath: string, conversationId: string, cwd: string | undefined): Session | null {
  let db: InstanceType<NodeSqlite['DatabaseSync']> | null = null;
  const steps: AgStep[] = [];

  try {
    assertTrustedPath(dbPath);
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      'SELECT step_type, step_payload FROM steps WHERE step_payload IS NOT NULL ORDER BY idx',
    ).all() as unknown as { step_type: number; step_payload: Uint8Array }[];

    for (const row of rows) {
      const step = readStep(row.step_type, Buffer.from(row.step_payload));
      if (step) steps.push(step);
    }
  } catch {
    return null;
  } finally {
    db?.close();
  }

  const requests = buildAgRequests(steps);
  if (requests.length === 0) return null;

  const workspaceName = cwd
    ? (cwd.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown')
    : 'Antigravity';

  return createSession({
    sessionId: `antigravity-${conversationId}`,
    workspaceId: `antigravity-${cwd ?? 'unknown'}`,
    workspaceName,
    location: 'terminal',
    harness: 'Antigravity',
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, cwd),
    workspaceRootPath: cwd,
  });
}

export function parseAntigravitySessions(conversationsDir: string): Session[] {
  const sqlite = loadNodeSqlite();
  if (!sqlite) return [];

  const sessions: Session[] = [];
  const cwdByConversation = readConversationCwdMap(conversationsDir);

  let files: string[];
  try {
    files = fs.readdirSync(conversationsDir).filter(name => name.endsWith('.db'));
  } catch {
    return sessions;
  }

  for (const file of files) {
    const conversationId = file.slice(0, -3);
    const session = parseAgConversation(
      sqlite,
      path.join(conversationsDir, file),
      conversationId,
      cwdByConversation.get(conversationId),
    );
    if (session) sessions.push(session);
  }

  return sessions;
}
