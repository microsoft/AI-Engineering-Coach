/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execFile } from 'child_process';
import * as os from 'os';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession } from './parser-shared';

const SQLITE_QUERY_OPTS = { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 50 * 1024 * 1024, cwd: os.tmpdir() } as const;

export function findAntigravityDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];
  const dirs: string[] = [];
  const paths = [
    path.join(home, '.gemini', 'antigravity', 'conversations'),
    path.join(home, '.gemini', 'antigravity-cli', 'conversations'),
    path.join(home, '.gemini', 'antigravity-ide', 'conversations'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) dirs.push(p);
  }
  return dirs;
}

function readVarint(buf: Buffer, offset: { val: number }): number {
  let result = 0;
  let shift = 0;
  while (true) {
    if (offset.val >= buf.length) throw new Error('Varint out of bounds');
    const b = buf[offset.val++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return result;
}

export function decodeProtobuf(buf: Buffer, depth = 0): Record<number, unknown> {
  const result: Record<number, unknown> = {};
  const offset = { val: 0 };
  while (offset.val < buf.length) {
    try {
      const key = readVarint(buf, offset);
      const fieldNum = key >> 3;
      const wireType = key & 0x07;
      if (wireType === 0) {
        result[fieldNum] = readVarint(buf, offset);
      } else if (wireType === 1) {
        if (offset.val + 8 > buf.length) break;
        result[fieldNum] = buf.subarray(offset.val, offset.val + 8);
        offset.val += 8;
      } else if (wireType === 2) {
        const len = readVarint(buf, offset);
        if (offset.val + len > buf.length) break;
        const val = buf.subarray(offset.val, offset.val + len);
        offset.val += len;

        const str = val.toString('utf-8');
        let isPrintable = true;
        for (let i = 0; i < Math.min(str.length, 100); i++) {
          const code = str.charCodeAt(i);
          if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            isPrintable = false;
            break;
          }
        }
        if (isPrintable && val.length > 0) {
          result[fieldNum] = str;
        } else if (depth < 4 && val.length <= 16384) {
          try {
            result[fieldNum] = decodeProtobuf(val, depth + 1);
          } catch {
            result[fieldNum] = val;
          }
        } else {
          result[fieldNum] = val;
        }
      } else if (wireType === 5) {
        if (offset.val + 4 > buf.length) break;
        result[fieldNum] = buf.subarray(offset.val, offset.val + 4);
        offset.val += 4;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return result;
}

function getRecord(obj: unknown): Record<number, unknown> | undefined {
  if (obj && typeof obj === 'object' && !Buffer.isBuffer(obj)) {
    return obj as Record<number, unknown>;
  }
  return undefined;
}

function sqliteQuery(dbPath: string, sql: string): string {
  assertTrustedPath(dbPath);
  try {
    return execFileSync('sqlite3', ['-cmd', 'PRAGMA busy_timeout=1000', '-json', dbPath, sql], { encoding: 'utf-8', ...SQLITE_QUERY_OPTS });
  } catch {
    return '';
  }
}

interface StepRow {
  idx: number;
  step_type: number;
  payload_hex: string;
}

interface MetadataResult {
  workspaceRootPath?: string;
  workspaceName: string;
  creationDate: number;
}

function decodeMetadataRows(metaRows: { hex_data?: string }[], birthtimeMs: number): MetadataResult {
  let workspaceRootPath: string | undefined;
  let workspaceName = 'Antigravity Workspace';
  let creationDate = birthtimeMs;

  if (metaRows[0] && metaRows[0].hex_data) {
    const metaBuf = Buffer.from(metaRows[0].hex_data, 'hex');
    const metaObj = decodeProtobuf(metaBuf);
    const p7 = metaObj[7];
    const p1 = metaObj[1];
    if (typeof p7 === 'string') {
      workspaceRootPath = p7.replace(/^file:\/\//, '');
    } else if (typeof p1 === 'string') {
      const m = p1.match(/file:\/\/[^\s"]+/);
      if (m) workspaceRootPath = m[0].replace(/^file:\/\//, '');
    }
    if (workspaceRootPath) {
      workspaceName = path.basename(workspaceRootPath);
    }
    const p2 = getRecord(metaObj[2]);
    if (p2 && typeof p2[1] === 'number') {
      creationDate = p2[1] * 1000;
    }
  }
  return { workspaceRootPath, workspaceName, creationDate };
}

function parseSqliteMultiResult(stdout: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let startIdx = -1;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '[') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (stdout[i] === ']') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        results.push(stdout.slice(startIdx, i + 1));
        startIdx = -1;
      }
    }
  }
  return results;
}

function processStepRow(
  row: StepRow,
  sessionId: string,
  creationDate: number,
  state: { currentReq: SessionRequest | null; requests: SessionRequest[]; lastMessageDate: number },
): void {
  if (!row.payload_hex) return;
  const payloadBuf = Buffer.from(row.payload_hex, 'hex');
  const payloadObj = decodeProtobuf(payloadBuf);

  let stepTime = creationDate;
  const p5 = getRecord(payloadObj[5]);
  if (p5) {
    const p5_1 = getRecord(p5[1]);
    if (p5_1 && typeof p5_1[1] === 'number') {
      stepTime = p5_1[1] * 1000;
      if (stepTime > state.lastMessageDate) state.lastMessageDate = stepTime;
    }
  }

  if (row.step_type === 14) {
    const p19 = getRecord(payloadObj[19]);
    const promptText = (p19 && typeof p19[2] === 'string') ? p19[2] : '';
    if (state.currentReq) state.requests.push(state.currentReq);
    state.currentReq = createRequest({
      requestId: `${sessionId}-${row.idx}`,
      timestamp: stepTime,
      messageText: promptText,
      responseText: '',
      agentName: 'Antigravity',
      agentMode: 'agent',
      toolsUsed: [],
      editedFiles: [],
      referencedFiles: [],
      promptTokens: 0,
      completionTokens: 0,
      variableKinds: {},
    });
  } else if (state.currentReq) {
    handleAssistantOrToolStep(row, payloadObj, state.currentReq);
  }
}

function handleAssistantOrToolStep(row: StepRow, payloadObj: Record<number, unknown>, currentReq: SessionRequest): void {
  if (row.step_type === 15 || row.step_type === 101) {
    let resp = '';
    const p114 = getRecord(payloadObj[114]);
    const p20 = getRecord(payloadObj[20]);
    if (row.step_type === 101 && p114 && typeof p114[1] === 'string') {
      resp = p114[1];
    } else if (p20 && typeof p20[1] === 'string') {
      resp = p20[1];
    }
    if (resp) {
      currentReq.responseText = currentReq.responseText ? `${currentReq.responseText}\n${resp}` : resp;
    }

    const p5 = getRecord(payloadObj[5]);
    const tokens = p5 ? getRecord(p5[9]) : undefined;
    if (tokens) {
      if (typeof tokens[1] === 'number') currentReq.promptTokens = (currentReq.promptTokens || 0) + tokens[1];
      if (typeof tokens[2] === 'number') currentReq.completionTokens = (currentReq.completionTokens || 0) + tokens[2];
    }
  } else if (row.step_type === 21) {
    const p5 = getRecord(payloadObj[5]);
    const p5_4 = p5 ? getRecord(p5[4]) : undefined;
    if (p5_4) {
      const toolName = (typeof p5_4[9] === 'string' ? p5_4[9] : (typeof p5_4[2] === 'string' ? p5_4[2] : ''));
      const toolArgsStr = typeof p5_4[3] === 'string' ? p5_4[3] : '';
      if (toolName) {
        currentReq.toolsUsed?.push(toolName);
        if (toolArgsStr) {
          parseToolArgsAndTrackFiles(toolName, toolArgsStr, currentReq);
        }
      }
    }
  } else if (row.step_type === 17) {
    const p24 = getRecord(payloadObj[24]);
    const p24_3 = p24 ? getRecord(p24[3]) : undefined;
    const errText = p24_3 ? (typeof p24_3[5] === 'string' ? p24_3[5] : (typeof p24_3[1] === 'string' ? p24_3[1] : '')) : '';
    if (errText) {
      currentReq.responseText = currentReq.responseText ? `${currentReq.responseText}\nError: ${errText}` : `Error: ${errText}`;
    }
  }
}

function parseToolArgsAndTrackFiles(toolName: string, toolArgsStr: string, currentReq: SessionRequest): void {
  try {
    const args = JSON.parse(toolArgsStr) as Record<string, unknown>;
    const filePath = typeof args.AbsolutePath === 'string' ? args.AbsolutePath :
                     typeof args.TargetFile === 'string' ? args.TargetFile :
                     typeof args.file_path === 'string' ? args.file_path :
                     typeof args.path === 'string' ? args.path : '';
    if (filePath) {
      if (['write_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
        currentReq.editedFiles?.push(filePath);
      } else {
        currentReq.referencedFiles?.push(filePath);
      }
    }
  } catch {
    // Ignore JSON parse error
  }
}

export function parseAntigravitySessions(conversationsDir: string): Session[] {
  const sessions: Session[] = [];
  if (!fs.existsSync(conversationsDir)) return sessions;

  let files: string[];
  try {
    files = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'));
  } catch {
    return sessions;
  }

  try {
    execFileSync('sqlite3', ['--version'], { timeout: 3000, cwd: os.tmpdir() });
  } catch {
    return sessions;
  }

  for (const file of files) {
    const dbPath = path.join(conversationsDir, file);
    const sessionId = path.basename(file, '.db');

    let birthtimeMs = Date.now();
    try {
      const stat = fs.statSync(dbPath);
      birthtimeMs = stat.birthtimeMs || stat.mtimeMs;
    } catch {
      // Keep default
    }

    const sql = "SELECT hex(data) as hex_data FROM trajectory_metadata_blob WHERE id = 'main'; SELECT idx, step_type, hex(step_payload) as payload_hex FROM steps ORDER BY idx;";
    const raw = sqliteQuery(dbPath, sql);
    const arrays = parseSqliteMultiResult(raw);
    if (arrays.length < 2) continue;

    let meta: MetadataResult;
    let stepRows: StepRow[];
    try {
      const metaRows = JSON.parse(arrays[0]) as { hex_data?: string }[];
      meta = decodeMetadataRows(metaRows, birthtimeMs);
      stepRows = JSON.parse(arrays[1]) as StepRow[];
    } catch {
      continue;
    }

    if (stepRows.length === 0) continue;

    const state = {
      currentReq: null as SessionRequest | null,
      requests: [] as SessionRequest[],
      lastMessageDate: meta.creationDate,
    };

    for (const row of stepRows) {
      processStepRow(row, sessionId, meta.creationDate, state);
    }

    if (state.currentReq) state.requests.push(state.currentReq);
    if (state.requests.length === 0) continue;

    const modelId = 'gemini-3.5-flash';
    for (const r of state.requests) {
      r.modelId = modelId;
    }

    const session = createSession({
      sessionId,
      workspaceId: `antigravity-${sessionId}`,
      workspaceName: meta.workspaceName,
      location: 'terminal',
      harness: 'Antigravity',
      creationDate: meta.creationDate,
      lastMessageDate: state.lastMessageDate,
      requests: state.requests,
      workspaceRootPath: meta.workspaceRootPath,
    });
    sessions.push(session);
  }

  return sessions;
}

function sqliteExecAsync(dbPath: string, args: string[]): Promise<string> {
  assertTrustedPath(dbPath);
  const newArgs = [...args];
  const idx = newArgs.indexOf('-json');
  if (idx !== -1) {
    newArgs.splice(idx, 0, '-cmd', 'PRAGMA busy_timeout=1000');
  }
  return new Promise(resolve => {
    execFile('sqlite3', newArgs, { encoding: 'utf-8', ...SQLITE_QUERY_OPTS }, (err, stdout) => {
      if (err) {
        resolve('');
      } else {
        resolve(stdout);
      }
    });
  });
}

async function sqliteQueryAsync(dbPath: string, sql: string): Promise<string> {
  return sqliteExecAsync(dbPath, ['-json', dbPath, sql]);
}


export async function parseAntigravitySessionsAsync(conversationsDir: string): Promise<Session[]> {
  const sessions: Session[] = [];
  if (!fs.existsSync(conversationsDir)) return sessions;

  let files: string[];
  try {
    files = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'));
  } catch {
    return sessions;
  }

  try {
    execFileSync('sqlite3', ['--version'], { timeout: 3000, cwd: os.tmpdir() });
  } catch {
    return sessions;
  }

  for (const file of files) {
    const dbPath = path.join(conversationsDir, file);
    const sessionId = path.basename(file, '.db');

    let birthtimeMs = Date.now();
    try {
      const stat = fs.statSync(dbPath);
      birthtimeMs = stat.birthtimeMs || stat.mtimeMs;
    } catch {
      // Keep default
    }

    const sql = "SELECT hex(data) as hex_data FROM trajectory_metadata_blob WHERE id = 'main'; SELECT idx, step_type, hex(step_payload) as payload_hex FROM steps ORDER BY idx;";
    const raw = await sqliteQueryAsync(dbPath, sql);
    const arrays = parseSqliteMultiResult(raw);
    if (arrays.length < 2) continue;

    let meta: MetadataResult;
    let stepRows: StepRow[];
    try {
      const metaRows = JSON.parse(arrays[0]) as { hex_data?: string }[];
      meta = decodeMetadataRows(metaRows, birthtimeMs);
      stepRows = JSON.parse(arrays[1]) as StepRow[];
    } catch {
      continue;
    }

    if (stepRows.length === 0) continue;

    const state = {
      currentReq: null as SessionRequest | null,
      requests: [] as SessionRequest[],
      lastMessageDate: meta.creationDate,
    };

    for (const row of stepRows) {
      processStepRow(row, sessionId, meta.creationDate, state);
    }

    if (state.currentReq) state.requests.push(state.currentReq);
    if (state.requests.length === 0) continue;

    const modelId = 'gemini-3.5-flash';
    for (const r of state.requests) {
      r.modelId = modelId;
    }

    const session = createSession({
      sessionId,
      workspaceId: `antigravity-${sessionId}`,
      workspaceName: meta.workspaceName,
      location: 'terminal',
      harness: 'Antigravity',
      creationDate: meta.creationDate,
      lastMessageDate: state.lastMessageDate,
      requests: state.requests,
      workspaceRootPath: meta.workspaceRootPath,
    });
    sessions.push(session);

    // Yield to event loop to keep the process responsive
    await new Promise<void>(r => setTimeout(r, 0));
  }

  return sessions;
}
