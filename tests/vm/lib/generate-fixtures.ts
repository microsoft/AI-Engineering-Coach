/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Synthetic session-log fixture generator (AUTHLESS).
 *
 * Writes deterministic, parser-valid session logs into a target HOME directory
 * for every harness the extension understands:
 *
 *   - Claude Code        ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 *   - Codex CLI          ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl
 *   - GitHub Copilot CLI ~/.copilot/session-state/<id>/events.jsonl
 *   - VS Code Local Agent ~/.config/Code/User/workspaceStorage/<hash>/chatSessions/<id>.json
 *   - OpenCode           ~/.local/share/opencode/storage/{session,message,part}/...
 *
 * No login, network, or Copilot account is required — this is pure file I/O, so
 * it can run unattended in CI / a container to exercise the full analytics
 * pipeline and webview without any real agent data collection.
 *
 * The log formats here mirror the shapes asserted by the parser unit tests
 * (src/core/parser-*.test.ts), so the real parser ingests them unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FixtureOptions {
  /** Target HOME directory the parser will scan (HOME / USERPROFILE). */
  home: string;
  /** Number of days of history to span (default 21 → multi-week trends). */
  days?: number;
  /** Anchor "now"; defaults to the current time. Sessions are spread before it. */
  now?: Date;
}

export interface FixtureSummary {
  home: string;
  claudeSessions: number;
  codexSessions: number;
  copilotCliSessions: number;
  vscodeSessions: number;
  openCodeSessions: number;
  totalSessions: number;
}

const TS_PROJECTS = ['my-api', 'frontend-app', 'data-pipeline', 'infra-tools'];

/** A reproducible code block so the analyzer attributes lines-of-code. */
function tsCodeBlock(lines: number): string {
  const body = Array.from({ length: Math.max(1, lines - 2) }, (_, i) => `  const v${i} = compute(${i});`).join('\n');
  return ['```typescript', 'export function handler() {', body, '}', '```'].join('\n');
}

function pyCodeBlock(lines: number): string {
  const body = Array.from({ length: Math.max(1, lines - 1) }, (_, i) => `    x${i} = transform(${i})`).join('\n');
  return ['```python', 'def run():', body, '```'].join('\n');
}

function iso(date: Date): string {
  return date.toISOString();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(file: string, lines: object[]): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
}

function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

/** Deterministic pseudo-id without external deps. */
function pseudoId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function generateClaude(home: string, now: Date, days: number): number {
  const projectsDir = path.join(home, '.claude', 'projects');
  let count = 0;
  for (let d = 0; d < days; d++) {
    // Two Claude projects, alternating, one session each on even days.
    if (d % 2 !== 0) continue;
    const project = TS_PROJECTS[d % 2];
    const cwd = `/home/dev/${project}`;
    const encoded = cwd.replace(/\//g, '-');
    const projDir = path.join(projectsDir, encoded);
    const sessionId = pseudoId('claude', count);
    const base = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    base.setHours(9 + (d % 6), 15, 0, 0);
    const lines: object[] = [];
    const turns = 3 + (d % 4);
    let t = base.getTime();
    for (let turn = 0; turn < turns; turn++) {
      t += 60_000;
      lines.push({
        type: 'user',
        timestamp: iso(new Date(t)),
        sessionId,
        cwd,
        gitBranch: 'main',
        version: '1.0.0',
        message: { role: 'user', content: [{ type: 'text', text: `Refactor the auth module, iteration ${turn + 1}. Please keep it small and focused.` }] },
      });
      t += 30_000;
      lines.push({
        type: 'assistant',
        timestamp: iso(new Date(t)),
        sessionId,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: `Here is the updated implementation:\n\n${tsCodeBlock(8 + turn)}` },
            { type: 'tool_use', name: 'edit_file', input: { path: `src/auth-${turn}.ts` } },
          ],
          usage: { input_tokens: 4200 + turn * 800, output_tokens: 120 + turn * 30, cache_read_input_tokens: 1000 },
        },
      });
    }
    writeJsonl(path.join(projDir, `${sessionId}.jsonl`), lines);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

function generateCodex(home: string, now: Date, days: number): number {
  let count = 0;
  for (let d = 1; d < days; d += 3) {
    const day = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    day.setHours(13, 30, 0, 0);
    const yyyy = String(day.getFullYear());
    const mm = String(day.getMonth() + 1).padStart(2, '0');
    const dd = String(day.getDate()).padStart(2, '0');
    const sessionsDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
    const cwd = `/home/dev/${TS_PROJECTS[2]}`;
    const sessionId = pseudoId('codex', count);
    const lines: object[] = [
      { type: 'session_meta', timestamp: iso(day), payload: { id: sessionId, cwd, cli_version: '0.20.0', source: 'cli' } },
      { type: 'turn_context', timestamp: iso(day), payload: { model: 'gpt-5.3-codex', effort: 'high' } },
    ];
    let t = day.getTime();
    const turns = 2 + (d % 3);
    let inTok = 0;
    let outTok = 0;
    for (let turn = 0; turn < turns; turn++) {
      t += 45_000;
      lines.push({ type: 'event_msg', timestamp: iso(new Date(t)), payload: { type: 'user_message', message: `Add an ETL step ${turn + 1} with retries.` } });
      t += 20_000;
      lines.push({ type: 'event_msg', timestamp: iso(new Date(t)), payload: { type: 'function_call', name: 'shell' } });
      t += 25_000;
      lines.push({ type: 'event_msg', timestamp: iso(new Date(t)), payload: { type: 'assistant_message', content: `Implemented the step:\n\n${pyCodeBlock(6 + turn)}` } });
      inTok += 3000 + turn * 500;
      outTok += 200 + turn * 40;
      t += 5_000;
      lines.push({
        type: 'event_msg',
        timestamp: iso(new Date(t)),
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inTok, output_tokens: outTok, cached_input_tokens: Math.floor(inTok * 0.2) } } },
      });
    }
    lines.push({ type: 'event_msg', timestamp: iso(new Date(t + 1000)), payload: { type: 'task_complete' } });
    writeJsonl(path.join(sessionsDir, `rollout-${yyyy}-${mm}-${dd}-${sessionId}.jsonl`), lines);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI
// ---------------------------------------------------------------------------

function generateCopilotCli(home: string, now: Date, days: number): number {
  const root = path.join(home, '.copilot', 'session-state');
  let count = 0;
  for (let d = 2; d < days; d += 5) {
    const start = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    start.setHours(16, 0, 0, 0);
    const sessionId = pseudoId('cli', count);
    const entryDir = path.join(root, sessionId);
    const lines: object[] = [
      { type: 'session.start', timestamp: iso(start), data: { sessionId, startTime: iso(start), selectedModel: 'gpt-5.5' } },
    ];
    let t = start.getTime();
    const turns = 2 + (d % 2);
    for (let turn = 0; turn < turns; turn++) {
      t += 30_000;
      lines.push({ type: 'user.message', timestamp: iso(new Date(t)), data: { content: `Generate unit tests for module ${turn}.` } });
      t += 40_000;
      lines.push({
        id: `assistant-${turn}`,
        type: 'assistant.message',
        timestamp: iso(new Date(t)),
        data: {
          content: `Added tests:\n\n${tsCodeBlock(5 + turn)}`,
          modelId: 'gpt-5.5',
          outputTokens: 300 + turn * 50,
          toolRequests: [{ toolName: 'read_file' }, { toolName: 'apply_patch' }],
        },
      });
    }
    writeJsonl(path.join(entryDir, 'events.jsonl'), lines);
    // Minimal workspace descriptor so the harness gets a friendly name.
    writeJson(path.join(entryDir, 'workspace.yaml'), {});
    fs.writeFileSync(path.join(entryDir, 'workspace.yaml'), `folder: /home/dev/${TS_PROJECTS[0]}\n`, 'utf-8');
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// VS Code Local Agent (workspaceStorage chat sessions)
// ---------------------------------------------------------------------------

function generateVsCode(home: string, now: Date, days: number): number {
  const storage = path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
  let count = 0;
  for (let d = 0; d < days; d++) {
    if (d % 2 === 0) continue; // interleave with Claude (even days)
    const project = TS_PROJECTS[d % TS_PROJECTS.length];
    const hash = `ws${String(d).padStart(4, '0')}hash`;
    const entryDir = path.join(storage, hash);
    const folderPath = `/home/dev/${project}`;
    writeJson(path.join(entryDir, 'workspace.json'), { folder: `file://${folderPath}` });

    const start = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    start.setHours(10 + (d % 5), 0, 0, 0);
    const sessionId = pseudoId('vscode', count);
    const turns = 3 + (d % 5);
    const requests: object[] = [];
    let t = start.getTime();
    for (let turn = 0; turn < turns; turn++) {
      t += 90_000;
      const isGiant = turn === 0 && d % 6 === 1; // occasional giant prompt anti-pattern
      const promptText = isGiant
        ? 'Please ' + 'do a very large refactor with lots of context '.repeat(60)
        : `Implement feature ${turn + 1} and add error handling.`;
      requests.push({
        requestId: `${sessionId}-r${turn}`,
        timestamp: t,
        message: { text: promptText },
        response: [{ value: `Done. Implemented it:\n\n${tsCodeBlock(10 + turn)}` }],
        modelId: turn % 2 === 0 ? 'copilot/gpt-5.5' : 'copilot/claude-sonnet-4',
        agent: { id: 'agent', extensionDisplayName: 'GitHub Copilot' },
        variableData: { variables: [{ kind: 'file', value: { path: `${folderPath}/src/index.ts` } }] },
        editedFileEvents: [{ uri: { path: `${folderPath}/src/feature-${turn}.ts` } }],
        result: { timings: { firstProgress: 1200, totalElapsed: 30_000 + turn * 1000 }, metadata: { promptTokens: 8000 + turn * 2000, outputTokens: 200 + turn * 40 } },
        completionTokens: 220 + turn * 45,
      });
    }
    writeJson(path.join(entryDir, 'chatSessions', `${sessionId}.json`), {
      version: 3,
      sessionId,
      creationDate: start.getTime(),
      lastMessageDate: t,
      initialLocation: 'panel',
      inputState: { mode: { id: 'agent' } },
      requests,
    });
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function generateOpenCode(home: string, now: Date, days: number): number {
  const storage = path.join(home, '.local', 'share', 'opencode', 'storage');
  const sessionDir = path.join(storage, 'session', 'global');
  let count = 0;
  for (let d = 4; d < days; d += 7) {
    const start = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    start.setHours(11, 0, 0, 0);
    const sessionId = pseudoId('opencode', count);
    writeJson(path.join(sessionDir, `${sessionId}.json`), {
      id: sessionId,
      title: `OpenCode session ${count}`,
      directory: `/home/dev/${TS_PROJECTS[3]}`,
      time: { created: start.getTime(), updated: start.getTime() + 600_000 },
      version: '0.1.0',
    });
    const turns = 2;
    let t = start.getTime();
    for (let turn = 0; turn < turns; turn++) {
      const userMsgId = `${sessionId}-u${turn}`;
      const asstMsgId = `${sessionId}-a${turn}`;
      t += 30_000;
      writeJson(path.join(storage, 'message', sessionId, `${userMsgId}.json`), {
        id: userMsgId, sessionID: sessionId, role: 'user', time: { created: t },
      });
      writeJson(path.join(storage, 'part', userMsgId, 'p0.json'), {
        id: 'p0', messageID: userMsgId, sessionID: sessionId, type: 'text', text: `Add logging to the pipeline, step ${turn}.`,
      });
      t += 40_000;
      writeJson(path.join(storage, 'message', sessionId, `${asstMsgId}.json`), {
        id: asstMsgId, sessionID: sessionId, role: 'assistant', time: { created: t, completed: t + 5000 },
        modelID: 'claude-sonnet-4', providerID: 'anthropic',
        tokens: { input: 2500, output: 180, cache: { read: 500, write: 0 } },
      });
      writeJson(path.join(storage, 'part', asstMsgId, 'p0.json'), {
        id: 'p0', messageID: asstMsgId, sessionID: sessionId, type: 'text', text: `Added logging:\n\n${pyCodeBlock(5 + turn)}`,
      });
      writeJson(path.join(storage, 'part', asstMsgId, 'p1.json'), {
        id: 'p1', messageID: asstMsgId, sessionID: sessionId, type: 'step-finish',
      });
    }
    count++;
  }
  return count;
}

/** Generate the complete authless fixture set into `options.home`. */
export function generateFixtures(options: FixtureOptions): FixtureSummary {
  const home = options.home;
  const days = options.days ?? 21;
  const now = options.now ?? new Date();

  ensureDir(home);

  const claudeSessions = generateClaude(home, now, days);
  const codexSessions = generateCodex(home, now, days);
  const copilotCliSessions = generateCopilotCli(home, now, days);
  const vscodeSessions = generateVsCode(home, now, days);
  const openCodeSessions = generateOpenCode(home, now, days);

  return {
    home,
    claudeSessions,
    codexSessions,
    copilotCliSessions,
    vscodeSessions,
    openCodeSessions,
    totalSessions: claudeSessions + codexSessions + copilotCliSessions + vscodeSessions + openCodeSessions,
  };
}
