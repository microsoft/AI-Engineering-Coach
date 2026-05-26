/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Windsurf (Cascade) session parser
 *
 * Data layout (macOS):
 *   ~/Library/Application Support/Windsurf/IndexedDB/vscode-file_vscode-app_0.indexeddb.leveldb/
 *
 * Windsurf stores Cascade session history in a Chromium IndexedDB backed by LevelDB.
 * The LevelDB values are JSON wrappers: { "type": "string", "value": "<base64>" }
 * where the base64 payload is a serialised protobuf TrajectorySummaries message.
 *
 * Protobuf schema (reverse-engineered):
 *   TrajectorySummaries   repeated TrajectoryEntry  (field 1)
 *   TrajectoryEntry {
 *     field 1  string   trajectoryId (UUID)
 *     field 2  message  TrajectorySummary {
 *       field 1  string   conversationId
 *       field 2  string   title
 *       field 3  varint   requestCount
 *       field 4  message  createdAtTs  { field 1 varint seconds, field 2 varint nanos }
 *       field 5  message  updatedAtTs  { ... }
 *       field 6  string   conversationId (dup)
 *       field 7  message  turns[]  (repeated)
 *       field 9  message  workspace { field 1 string folderUri, field 2 string folderUri }
 *       field 26 varint   bool (devcontainer?)
 *       field 27 message  gitInfo { field 1 string repoSlug, field 2 string remoteUrl, field 3 string branch }
 *       field 10 message  lastMsgTs
 *       field 18 varint   bool
 *       field 26 string   modelId
 *       field 34 string   modelId (dup)
 *     }
 *   }
 *   Turn {
 *     field 1  string   turnId
 *     field 2  message  TurnBody {
 *       field 2  varint   role (1=user, 2=assistant? check)
 *       field 3  varint   status
 *       field 11 message  context  (repeated – files, refs)
 *       field 26 string   userMessage
 *       field 27 string   botId
 *       field 34 string   modelId
 *       field 42 string   responseText or title/summary
 *     }
 *   }
 *
 * Because the schema is partially reverse-engineered, this parser extracts
 * the fields it can confirm and falls back gracefully on anything unknown.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { createRequest, createSession } from './parser-shared';

/* ---- Minimal protobuf wire decoder ---- */

interface ProtoField {
  fieldNum: number;
  wireType: number;
  value: bigint | Buffer;
}

function decodeVarint(buf: Buffer, offset: number): { value: bigint; offset: number } | null {
  let result = 0n;
  let shift = 0n;
  while (offset < buf.length) {
    const b = buf[offset++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) return { value: result, offset };
    if (shift > 63n) return null;
  }
  return null;
}

function decodeProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagResult = decodeVarint(buf, offset);
    if (!tagResult) break;
    offset = tagResult.offset;
    const tag = tagResult.value;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNum === 0 || fieldNum > 1000) break;

    if (wireType === 0) {
      const r = decodeVarint(buf, offset);
      if (!r) break;
      offset = r.offset;
      fields.push({ fieldNum, wireType, value: r.value });
    } else if (wireType === 2) {
      const lenResult = decodeVarint(buf, offset);
      if (!lenResult) break;
      offset = lenResult.offset;
      const len = Number(lenResult.value);
      if (len < 0 || offset + len > buf.length) break;
      fields.push({ fieldNum, wireType, value: buf.slice(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ fieldNum, wireType, value: buf.slice(offset, offset + 4) });
      offset += 4;
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ fieldNum, wireType, value: buf.slice(offset, offset + 8) });
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

function bufToString(v: bigint | Buffer): string {
  if (Buffer.isBuffer(v)) {
    try { return v.toString('utf8'); } catch { return ''; }
  }
  return '';
}

function bufToMessage(v: bigint | Buffer): Buffer | null {
  return Buffer.isBuffer(v) ? v : null;
}

/* ---- Timestamp helper ---- */

/** Decode a google.protobuf.Timestamp-like message: field 1 = seconds, field 2 = nanos */
function decodeTimestampMs(buf: Buffer): number | null {
  const fields = decodeProtoFields(buf);
  let seconds = 0n;
  for (const f of fields) {
    if (f.fieldNum === 1 && typeof f.value === 'bigint') seconds = f.value;
  }
  if (seconds === 0n) return null;
  const ms = Number(seconds) * 1000;
  // Sanity: must be between 2020 and 2040
  if (ms < 1_577_836_800_000 || ms > 2_208_988_800_000) return null;
  return ms;
}

/** The LevelDB value timestamps are packed differently — raw seconds since epoch as a varint */
function decodePackedTs(buf: Buffer): number | null {
  const fields = decodeProtoFields(buf);
  for (const f of fields) {
    if (f.fieldNum === 1 && typeof f.value === 'bigint') {
      const ms = Number(f.value) * 1000;
      if (ms > 1_577_836_800_000 && ms < 2_208_988_800_000) return ms;
    }
  }
  return null;
}

/* ---- Turn decoding ---- */

interface DecodedTurn {
  turnId: string;
  userMessage: string;
  responseText: string;
  modelId: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  timestamp: number | null;
  isCanceled: boolean;
}

function decodeTurn(buf: Buffer): DecodedTurn {
  const result: DecodedTurn = {
    turnId: '',
    userMessage: '',
    responseText: '',
    modelId: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    timestamp: null,
    isCanceled: false,
  };

  const fields = decodeProtoFields(buf);
  for (const f of fields) {
    const s = Buffer.isBuffer(f.value) ? bufToString(f.value) : '';
    const sub = bufToMessage(f.value);

    if (f.fieldNum === 1 && Buffer.isBuffer(f.value)) {
      // Could be turnId or nested message
      if (/^[0-9a-zA-Z-]{8,}$/.test(s) && s.includes('-')) {
        result.turnId = s;
      } else if (sub) {
        // Nested turn body
        const inner = decodeTurnBody(sub);
        if (inner.userMessage) result.userMessage = inner.userMessage;
        if (inner.responseText) result.responseText = inner.responseText;
        if (inner.modelId) result.modelId = inner.modelId;
        if (inner.toolsUsed.length) result.toolsUsed.push(...inner.toolsUsed);
        if (inner.editedFiles.length) result.editedFiles.push(...inner.editedFiles);
        if (inner.referencedFiles.length) result.referencedFiles.push(...inner.referencedFiles);
        if (inner.timestamp) result.timestamp = inner.timestamp;
        if (inner.isCanceled) result.isCanceled = true;
      }
    } else if (f.fieldNum === 2 && sub) {
      const inner = decodeTurnBody(sub);
      if (inner.userMessage) result.userMessage = inner.userMessage;
      if (inner.responseText) result.responseText = inner.responseText;
      if (inner.modelId) result.modelId = inner.modelId;
      if (inner.toolsUsed.length) result.toolsUsed.push(...inner.toolsUsed);
      if (inner.editedFiles.length) result.editedFiles.push(...inner.editedFiles);
      if (inner.referencedFiles.length) result.referencedFiles.push(...inner.referencedFiles);
      if (inner.timestamp) result.timestamp = inner.timestamp;
      if (inner.isCanceled) result.isCanceled = true;
    }
  }

  return result;
}

interface TurnBody {
  userMessage: string;
  responseText: string;
  modelId: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  timestamp: number | null;
  isCanceled: boolean;
}

function isFileUri(s: string): boolean {
  return s.startsWith('file://');
}

function uriToPath(uri: string): string {
  try { return decodeURIComponent(uri.replace(/^file:\/\//, '')); } catch { return uri; }
}

function decodeTurnBody(buf: Buffer): TurnBody {
  const result: TurnBody = {
    userMessage: '',
    responseText: '',
    modelId: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    timestamp: null,
    isCanceled: false,
  };

  const fields = decodeProtoFields(buf);
  for (const f of fields) {
    if (!Buffer.isBuffer(f.value)) continue;
    const s = bufToString(f.value);
    const sub = f.value;

    switch (f.fieldNum) {
      case 3: {
        // Status/role varint — skip, it's nested
        break;
      }
      case 11: {
        // Context / file references (repeated)
        const ctxFields = decodeProtoFields(sub);
        for (const cf of ctxFields) {
          if (Buffer.isBuffer(cf.value)) {
            const cs = bufToString(cf.value);
            if (isFileUri(cs)) result.referencedFiles.push(uriToPath(cs));
          }
        }
        break;
      }
      case 26: {
        // User message text
        if (s && !isFileUri(s) && s.length > 1) result.userMessage = s;
        break;
      }
      case 34: {
        // Model id
        if (s && (s.includes('claude') || s.includes('gpt') || s.includes('MODEL_'))) result.modelId = s;
        break;
      }
      case 42: {
        // Response text or todo items or summary
        if (s && s.length > 1 && !isFileUri(s)) {
          if (!result.responseText) result.responseText = s;
        }
        break;
      }
      default: {
        // Look for file URIs in any string field
        if (isFileUri(s)) {
          result.referencedFiles.push(uriToPath(s));
        }
        // Look for tool names in nested messages (simplified)
        if (sub.length > 2 && sub.length < 200) {
          const toolFields = decodeProtoFields(sub);
          for (const tf of toolFields) {
            if (Buffer.isBuffer(tf.value)) {
              const ts = bufToString(tf.value);
              if (ts && ts.length > 2 && ts.length < 80 && /^[a-z_A-Z][a-z_A-Z0-9]*$/.test(ts)) {
                // Looks like a tool name
                if (KNOWN_TOOLS.has(ts.toLowerCase()) || ts.toLowerCase().includes('file') || ts.toLowerCase().includes('edit')) {
                  if (!result.toolsUsed.includes(ts)) result.toolsUsed.push(ts);
                }
              }
            }
          }
        }
        break;
      }
    }
  }

  return result;
}

const KNOWN_TOOLS = new Set([
  'read_file', 'write_to_file', 'edit', 'create', 'run_command', 'find_by_name',
  'grep_search', 'list_dir', 'browser_preview', 'code_search', 'multi_edit',
  'read', 'write', 'bash', 'computer', 'str_replace_editor',
]);

/* ---- Trajectory (session) decoding ---- */

interface DecodedTrajectory {
  trajectoryId: string;
  conversationId: string;
  title: string;
  requestCount: number;
  workspaceFolderUri: string;
  modelId: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  turns: DecodedTurn[];
}

function decodeTrajectoryEntry(buf: Buffer): DecodedTrajectory | null {
  const result: DecodedTrajectory = {
    trajectoryId: '',
    conversationId: '',
    title: '',
    requestCount: 0,
    workspaceFolderUri: '',
    modelId: '',
    createdAtMs: null,
    updatedAtMs: null,
    turns: [],
  };

  const fields = decodeProtoFields(buf);
  for (const f of fields) {
    if (f.fieldNum === 1 && Buffer.isBuffer(f.value)) {
      const s = bufToString(f.value);
      if (/^[0-9a-zA-Z-]{8,}$/.test(s) && s.includes('-')) {
        result.trajectoryId = s;
      }
    } else if (f.fieldNum === 2 && Buffer.isBuffer(f.value)) {
      decodeTrajectorySummary(f.value, result);
    }
  }

  if (!result.trajectoryId || result.turns.length === 0) return null;
  return result;
}

function decodeTrajectorySummary(buf: Buffer, result: DecodedTrajectory): void {
  const fields = decodeProtoFields(buf);

  for (const f of fields) {
    const s = Buffer.isBuffer(f.value) ? bufToString(f.value) : '';
    const sub = bufToMessage(f.value);

    switch (f.fieldNum) {
      case 1:
        if (s && /^[0-9a-zA-Z-]{8,}$/.test(s) && s.includes('-')) result.conversationId = s;
        break;
      case 2:
        if (s && s.length > 1 && s.length < 200) result.title = s;
        break;
      case 3:
        if (typeof f.value === 'bigint') result.requestCount = Number(f.value);
        break;
      case 4:
        if (sub) {
          const ts = decodeTimestampMs(sub) ?? decodePackedTs(sub);
          if (ts) result.createdAtMs = ts;
        }
        break;
      case 5:
        if (sub) {
          const ts = decodeTimestampMs(sub) ?? decodePackedTs(sub);
          if (ts) result.updatedAtMs = ts;
        }
        break;
      case 7:
        // Repeated turns
        if (sub) {
          const turn = decodeTurn(sub);
          if (turn.userMessage || turn.responseText) result.turns.push(turn);
        }
        break;
      case 9:
        // Workspace message: field 1 = folderUri
        if (sub) {
          const wf = decodeProtoFields(sub);
          for (const wff of wf) {
            if (Buffer.isBuffer(wff.value)) {
              const ws = bufToString(wff.value);
              if (ws.startsWith('file://')) { result.workspaceFolderUri = ws; break; }
            }
          }
        }
        break;
      case 10:
        // Last message timestamp
        if (sub) {
          const ts = decodeTimestampMs(sub) ?? decodePackedTs(sub);
          if (ts) result.updatedAtMs = ts;
        }
        break;
      case 26:
        // modelId or boolean
        if (typeof f.value === 'bigint') break;
        if (s && (s.includes('claude') || s.includes('gpt') || s.includes('MODEL_') || s.includes('gemini'))) {
          result.modelId = s;
        }
        break;
      case 34:
        if (s && (s.includes('claude') || s.includes('gpt') || s.includes('MODEL_') || s.includes('gemini'))) {
          result.modelId = s;
        }
        break;
      default:
        // Capture any file URIs as workspace hints
        if (Buffer.isBuffer(f.value)) {
          if (s.startsWith('file://') && !result.workspaceFolderUri) {
            result.workspaceFolderUri = s;
          }
        }
        break;
    }
  }
}

/* ---- TrajectorySummaries top-level decode ---- */

function decodeTrajectorySummaries(buf: Buffer): DecodedTrajectory[] {
  const trajectories: DecodedTrajectory[] = [];
  const fields = decodeProtoFields(buf);
  for (const f of fields) {
    if (f.fieldNum === 1 && Buffer.isBuffer(f.value)) {
      const t = decodeTrajectoryEntry(f.value);
      if (t) trajectories.push(t);
    }
  }
  return trajectories;
}

/* ---- LevelDB raw scan ---- */

/**
 * Scan all LDB/LOG files in the Windsurf IndexedDB LevelDB directory for
 * base64-encoded trajectory summaries stored as {"type":"string","value":"<b64>"}.
 */
function* scanLevelDbForTrajectories(leveldbDir: string): Generator<DecodedTrajectory[]> {
  let files: string[];
  try {
    files = fs.readdirSync(leveldbDir)
      .filter(f => f.endsWith('.ldb') || f.endsWith('.log'))
      .map(f => path.join(leveldbDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    let data: Buffer;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 20 * 1024 * 1024) continue; // skip files > 20MB
      data = fs.readFileSync(file);
    } catch {
      continue;
    }

    // Find {"type":"string","value":"<base64>"} patterns
    const text = data.toString('latin1');
    const re = /\{"type":"string","value":"([A-Za-z0-9+/]+=*)"\}/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((m = re.exec(text)) !== null) {
      const b64 = m[1];
      if (seen.has(b64)) continue;
      seen.add(b64);

      let decoded: Buffer;
      try {
        decoded = Buffer.from(b64, 'base64');
      } catch {
        continue;
      }

      // Attempt to decode as TrajectorySummaries
      try {
        const trajectories = decodeTrajectorySummaries(decoded);
        if (trajectories.length > 0) yield trajectories;
      } catch {
        // not a trajectory blob — skip
      }
    }
  }
}

/* ---- Path helpers ---- */

export function findWindsurfDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];

  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Windsurf', 'IndexedDB'),
    );
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || '';
    candidates.push(path.join(appdata, 'Windsurf', 'IndexedDB'));
  } else {
    candidates.push(path.join(home, '.config', 'Windsurf', 'IndexedDB'));
  }

  for (const candidate of candidates) {
    // Look for the LevelDB subdirectory
    if (!fs.existsSync(candidate)) continue;
    try {
      const entries = fs.readdirSync(candidate, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith('.leveldb')) {
          dirs.push(path.join(candidate, e.name));
        }
      }
    } catch {
      // skip
    }
  }

  return dirs;
}

function workspaceNameFromUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const clean = decoded.replace(/^file:\/\//, '').replace(/\/+$/, '');
    return clean.split('/').pop() || 'windsurf';
  } catch {
    return 'windsurf';
  }
}

function workspaceRootFromUri(uri: string): string | undefined {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
  } catch {
    return undefined;
  }
}

/* ---- Session assembly ---- */

function trajectoryToSession(traj: DecodedTrajectory, _leveldbDir: string): Session | null {
  if (traj.turns.length === 0) return null;

  const wsUri = traj.workspaceFolderUri || '';
  const wsName = workspaceNameFromUri(wsUri) || 'windsurf';
  const wsRoot = workspaceRootFromUri(wsUri);
  const wsId = `windsurf-${wsName}-${traj.trajectoryId.slice(0, 8)}`;
  const defaultModel = traj.modelId || 'Windsurf';

  const requests: SessionRequest[] = traj.turns.map((turn, idx) => {
    const model = turn.modelId || defaultModel;
    const editedFiles = [...new Set(turn.editedFiles)];
    const referencedFiles = [...new Set(turn.referencedFiles)];

    return createRequest({
      requestId: turn.turnId || `windsurf-${traj.trajectoryId.slice(0, 8)}-${idx}`,
      timestamp: turn.timestamp,
      messageText: turn.userMessage,
      responseText: turn.responseText,
      isCanceled: turn.isCanceled,
      agentName: 'Cascade',
      agentMode: 'agent',
      modelId: model,
      toolsUsed: turn.toolsUsed,
      editedFiles,
      referencedFiles,
      totalElapsed: null,
      promptTokens: null,
      completionTokens: null,
    });
  });

  if (requests.length === 0) return null;

  return createSession({
    sessionId: traj.trajectoryId,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'panel',
    harness: 'Windsurf',
    creationDate: traj.createdAtMs,
    lastMessageDate: traj.updatedAtMs,
    requests,
    workspaceRootPath: wsRoot,
  });
}

/* ---- Public API ---- */

export function parseWindsurfSessions(leveldbDir: string): Session[] {
  const sessions: Session[] = [];
  const seenIds = new Set<string>();

  for (const trajectories of scanLevelDbForTrajectories(leveldbDir)) {
    for (const traj of trajectories) {
      if (seenIds.has(traj.trajectoryId)) continue;
      seenIds.add(traj.trajectoryId);
      const session = trajectoryToSession(traj, leveldbDir);
      if (session) sessions.push(session);
    }
  }

  return sessions;
}
