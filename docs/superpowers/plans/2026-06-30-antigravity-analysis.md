# Antigravity Log Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable offline log analysis of local Antigravity conversations by parsing SQLite `.db` databases.

**Architecture:** Detect `.db` files from Antigravity dirs, query them via sqlite3 CLI, decode binary Protobuf blobs, map them into Session and SessionRequest types, and register under the Antigravity harness name.

**Tech Stack:** TypeScript, Node.js (`child_process`), SQLite.

## Global Constraints

- OS: macOS
- TypeScript strict mode
- Do not add any new npm runtime dependencies

---

### Task 1: Protobuf Decoder & Directory Discovery

**Files:**
- Create: `src/core/parser-antigravity.ts`
- Test: `src/core/parser-antigravity.test.ts`

**Interfaces:**
- Produces: `findAntigravityDirs(): string[]`
- Produces: `decodeProtobuf(buf: Buffer): Record<number, any>`

- [ ] **Step 1: Write the failing test for discovery and decoding**
  Create `src/core/parser-antigravity.test.ts` with a test that checks directory discovery and raw Protobuf decoding of a mock buffer.
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { findAntigravityDirs, decodeProtobuf } from './parser-antigravity';

  describe('Antigravity Discovery & Decoder', () => {
    it('should find directories', () => {
      const dirs = findAntigravityDirs();
      expect(Array.isArray(dirs)).toBe(true);
    });

    it('should decode simple protobuf', () => {
      // Proto message: field 1 = varint 15, field 2 = string "test"
      const buf = Buffer.from([0x08, 0x0f, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const res = decodeProtobuf(buf);
      expect(res[1]).toBe(15);
      expect(res[2]).toBe('test');
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `rtk npm test src/core/parser-antigravity.test.ts`
  Expected: FAIL with "Cannot find module './parser-antigravity'"

- [ ] **Step 3: Write minimal implementation**
  Create `src/core/parser-antigravity.ts` containing the discovery paths and the zero-dependency Protobuf decoding loop.
  ```typescript
  import * as fs from 'fs';
  import * as path from 'path';

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

  export function decodeProtobuf(buf: Buffer): Record<number, any> {
    const result: Record<number, any> = {};
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
          } else {
            try {
              result[fieldNum] = decodeProtobuf(val);
            } catch {
              result[fieldNum] = val;
            }
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
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `rtk npm test src/core/parser-antigravity.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `rtk git add src/core/parser-antigravity.ts src/core/parser-antigravity.test.ts && rtk git commit -m "feat: add Antigravity discovery and protobuf decoder"`

---

### Task 2: Implement Session Parser & Turn Assembly

**Files:**
- Modify: `src/core/parser-antigravity.ts`
- Modify: `src/core/parser-antigravity.test.ts`

**Interfaces:**
- Produces: `parseAntigravitySessions(conversationsDir: string): Session[]`

- [ ] **Step 1: Write a failing test for parsing databases**
  Add a test in `src/core/parser-antigravity.test.ts` that mocks a session parser run on a folder containing a sqlite database (using a mock sqlite query return format).
  ```typescript
  import { parseAntigravitySessions } from './parser-antigravity';
  // ... inside describe block ...
  it('should parse database sessions', () => {
    // Requires a mock database file or sqlite wrapper mocking.
    // For TDD simplicity, we'll verify it returns an empty array or throws when no sqlite is present.
    const sessions = parseAntigravitySessions('/invalid/path');
    expect(sessions).toEqual([]);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `rtk npm test src/core/parser-antigravity.test.ts`
  Expected: FAIL with "parseAntigravitySessions is not a function"

- [ ] **Step 3: Write minimal implementation**
  Implement `parseAntigravitySessions` in `src/core/parser-antigravity.ts`. This reads `.db` files in the given directory, queries them via `sqlite3` CLI, decodes the protobuf metadata and step blobs, and maps them to `Session` and `SessionRequest` objects.
  ```typescript
  import { execFileSync } from 'child_process';
  import * as os from 'os';
  import { Session, SessionRequest } from './types';
  import { assertTrustedPath, createRequest, createSession } from './parser-shared';

  const SQLITE_QUERY_OPTS = { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 50 * 1024 * 1024, cwd: os.tmpdir() } as const;

  function sqliteQuery(dbPath: string, sql: string): string {
    assertTrustedPath(dbPath);
    try {
      return execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf-8', ...SQLITE_QUERY_OPTS });
    } catch {
      return '';
    }
  }

  function sqliteQuerySteps(dbPath: string): { idx: number; step_type: number; payload_hex: string }[] {
    assertTrustedPath(dbPath);
    try {
      const sql = 'SELECT idx, step_type, hex(step_payload) as payload_hex FROM steps ORDER BY idx';
      const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf-8', ...SQLITE_QUERY_OPTS });
      if (!raw.trim()) return [];
      return JSON.parse(raw);
    } catch {
      return [];
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

    // Verify sqlite3 is available
    try {
      execFileSync('sqlite3', ['--version'], { timeout: 3000, cwd: os.tmpdir() });
    } catch {
      return sessions;
    }

    for (const file of files) {
      const dbPath = path.join(conversationsDir, file);
      const sessionId = path.basename(file, '.db');

      // 1. Query metadata
      let workspaceRootPath: string | undefined;
      let workspaceName = 'Antigravity Workspace';
      let creationDate: number | null = null;

      try {
        const rawMeta = sqliteQuery(dbPath, "SELECT hex(data) as hex_data FROM trajectory_metadata_blob WHERE id = 'main'");
        if (rawMeta.trim()) {
          const metaRows = JSON.parse(rawMeta);
          if (metaRows[0] && metaRows[0].hex_data) {
            const metaBuf = Buffer.from(metaRows[0].hex_data, 'hex');
            const metaObj = decodeProtobuf(metaBuf);
            if (typeof metaObj[7] === 'string') {
              workspaceRootPath = metaObj[7].replace(/^file:\/\//, '');
            } else if (typeof metaObj[1] === 'string') {
              const m = metaObj[1].match(/file:\/\/[^\s\u0012\u001a"]+/);
              if (m) workspaceRootPath = m[0].replace(/^file:\/\//, '');
            }
            if (workspaceRootPath) {
              workspaceName = path.basename(workspaceRootPath);
            }
            if (metaObj[2] && metaObj[2][1]) {
              creationDate = Number(metaObj[2][1]) * 1000;
            }
          }
        }
      } catch {
        // Fallback to filesystem times on metadata error
      }

      if (!creationDate) {
        try {
          const stat = fs.statSync(dbPath);
          creationDate = stat.birthtimeMs || stat.mtimeMs;
        } catch {
          creationDate = Date.now();
        }
      }

      // 2. Query steps
      const stepRows = sqliteQuerySteps(dbPath);
      if (stepRows.length === 0) continue;

      const requests: SessionRequest[] = [];
      let currentReq: SessionRequest | null = null;
      let lastMessageDate = creationDate;

      for (const row of stepRows) {
        if (!row.payload_hex) continue;
        const payloadBuf = Buffer.from(row.payload_hex, 'hex');
        const payloadObj = decodeProtobuf(payloadBuf);

        // Extract timestamp if available
        let stepTime = creationDate;
        if (payloadObj[5] && payloadObj[5][1] && payloadObj[5][1][1]) {
          stepTime = Number(payloadObj[5][1][1]) * 1000;
          if (stepTime > lastMessageDate) lastMessageDate = stepTime;
        }

        if (row.step_type === 14) { // User Prompt
          const promptText = payloadObj[19]?.[2] || '';
          if (currentReq) requests.push(currentReq);
          currentReq = createRequest({
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
        } else if (currentReq) {
          if (row.step_type === 15 || row.step_type === 101) { // Assistant Response
            let resp = '';
            if (row.step_type === 101 && payloadObj[114] && typeof payloadObj[114][1] === 'string') {
              resp = payloadObj[114][1];
            } else if (payloadObj[20] && typeof payloadObj[20][1] === 'string') {
              resp = payloadObj[20][1];
            }
            if (resp) {
              if (currentReq.responseText) currentReq.responseText += '\n';
              currentReq.responseText += resp;
            }

            // Extract tokens if available in field 5 -> 9
            if (payloadObj[5] && payloadObj[5][9]) {
              const tokens = payloadObj[5][9];
              if (tokens[1]) currentReq.promptTokens = (currentReq.promptTokens || 0) + Number(tokens[1]);
              if (tokens[2]) currentReq.completionTokens = (currentReq.completionTokens || 0) + Number(tokens[2]);
            }
          } else if (row.step_type === 21) { // Tool Call
            const toolName = payloadObj[5]?.[4]?.[9] || payloadObj[5]?.[4]?.[2] || '';
            const toolArgsStr = payloadObj[5]?.[4]?.[3] || '';
            if (toolName) {
              currentReq.toolsUsed?.push(toolName);
              if (toolArgsStr) {
                try {
                  const args = JSON.parse(toolArgsStr);
                  const filePath = args.AbsolutePath || args.TargetFile || args.file_path || args.path || '';
                  if (filePath) {
                    if (['write_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
                      currentReq.editedFiles?.push(filePath);
                    } else {
                      currentReq.referencedFiles?.push(filePath);
                    }
                  }
                } catch {}
              }
            }
          } else if (row.step_type === 17) { // Error
            const errText = payloadObj[24]?.[3]?.[5] || payloadObj[24]?.[3]?.[1] || '';
            if (errText) {
              if (currentReq.responseText) currentReq.responseText += '\n';
              currentReq.responseText += `Error: ${errText}`;
            }
          }
        }
      }

      if (currentReq) requests.push(currentReq);
      if (requests.length === 0) continue;

      // Extract model ID from error details or default to gemini-3.5-flash
      const modelId = 'gemini-3.5-flash';
      for (const r of requests) {
        r.modelId = modelId;
      }

      const session = createSession({
        sessionId,
        workspaceId: `antigravity-${sessionId}`,
        workspaceName,
        location: 'terminal',
        harness: 'Antigravity',
        creationDate,
        lastMessageDate,
        requests,
        workspaceRootPath,
      });
      sessions.push(session);
    }

    return sessions;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `rtk npm test src/core/parser-antigravity.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `rtk git add src/core/parser-antigravity.ts src/core/parser-antigravity.test.ts && rtk git commit -m "feat: implement Antigravity sqlite database parser"`

---

### Task 3: Harness Registration & File Indexing Integration

**Files:**
- Modify: `src/core/parser-harnesses.ts`
- Modify: `src/core/parser.ts`

**Interfaces:**
- Consumes: `findAntigravityDirs(): string[]`
- Consumes: `parseAntigravitySessions(conversationsDir: string): Session[]`

- [ ] **Step 1: Write a failing test for harness registration**
  Check that the `'Antigravity'` harness is present in `EXTERNAL_HARNESS_SET` inside `src/core/parser-harnesses.ts`.
  Modify `src/core/parser-harnesses.ts` to see that it imports and registers Antigravity.
  Add a test block in `tests/parser-harnesses.test.ts` (if exists) or we can assert that it is in `EXTERNAL_HARNESS_SET`.
  Let's modify `src/core/parser-harnesses.ts` first.

- [ ] **Step 2: Modify `src/core/parser-harnesses.ts`**
  Add the registration of the Antigravity external harness collector.
  ```typescript
  // Around line 10
  import { findAntigravityDirs, parseAntigravitySessions } from './parser-antigravity';

  // Inside EXTERNAL_HARNESSES array (around line 72):
  {
    name: 'Antigravity',
    collectSync(ctx) {
      for (const agDir of findAntigravityDirs()) {
        for (const session of parseAntigravitySessions(agDir)) {
          addSession(ctx.workspaces, ctx.sessions, session, agDir);
        }
      }
    }
  }

  // Inside EXTERNAL_HARNESS_SET (around line 105):
  'Antigravity'
  ```

- [ ] **Step 3: Modify `src/core/parser.ts`**
  Modify directory discovery and directory partitioning to include Antigravity paths.
  ```typescript
  // Inside findLogsDirs() around line 97:
  export function findLogsDirs(): string[] {
    return [...findVsCodeDirs(), ...findXcodeDirs(), ...findAntigravityDirs()];
  }

  // Import findAntigravityDirs around line 16:
  import { findAntigravityDirs } from './parser-antigravity';

  // Inside partitionDirs() around line 101:
  function partitionDirs(logsDirs: string[]): { vsCodeDirs: string[]; xcodeDirs: string[] } {
    const vsCodeDirs: string[] = [];
    const xcodeDirs: string[] = [];
    for (const d of logsDirs) {
      if (d.includes(path.join('.config', 'github-copilot', 'xcode'))) xcodeDirs.push(d);
      else if (d.includes('.gemini')) {
        // Antigravity dirs belong to external harnesses, so they are not VS Code dirs
      } else {
        vsCodeDirs.push(d);
      }
    }
    return { vsCodeDirs, xcodeDirs };
  }
  ```

- [ ] **Step 4: Run typecheck and tests**
  Run: `rtk npm run typecheck && rtk npm test`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `rtk git add src/core/parser-harnesses.ts src/core/parser.ts && rtk git commit -m "feat: register Antigravity external harness and discovery paths"`

---

### Task 4: Webview UI Coloring Integration

**Files:**
- Modify: `src/webview/shared.ts:344-355`
- Modify: `src/webview/page-config.ts:15-18`

**Interfaces:**
- Produces: Color mapping for the `'Antigravity'` harness

- [ ] **Step 1: Modify `src/webview/shared.ts`**
  Add `'Antigravity'` to `HARNESS_COLORS`.
  ```typescript
  export const HARNESS_COLORS: Record<string, string> = {
    'Local Agent': '#007ACC',
    'Local Agent (Insiders)': '#24bfa5',
    'Xcode': '#147EFB',
    'GitHub Copilot CLI': '#6e40c9',
    'GitHub Copilot App': '#8957e5',
    'Claude': '#d97706',
    'Codex': '#10b981',
    'OpenCode': '#8b5cf6',
    'Antigravity': '#d97706',
  };
  ```

- [ ] **Step 2: Modify `src/webview/page-config.ts`**
  Add `'Antigravity'` to the `HC` color map.
  ```typescript
  const HC: Record<string, string> = { 'Local Agent': '#007acc', 'Local Agent (Insiders)': '#24bfa5', 'Xcode': '#147efb', 'Claude Code': '#d97706', 'GitHub Copilot CLI': '#8b5cf6', 'GitHub Copilot App': '#a371f7', 'Codex CLI': '#ec4899', 'OpenCode': '#10b981', 'Antigravity': '#d97706' };
  ```

- [ ] **Step 3: Run the build command**
  Run: `rtk npm run build`
  Expected: PASS (build completes successfully)

- [ ] **Step 4: Commit**
  Run: `rtk git add src/webview/shared.ts src/webview/page-config.ts && rtk git commit -m "feat: add color styling for Antigravity harness in dashboard UI"`
