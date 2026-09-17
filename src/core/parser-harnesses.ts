/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* External harness collection registry for parser orchestration. */

import * as fs from 'fs';
import { Workspace, Session } from './types';
import type { SessionSource } from './cache';
import { findClaudeDirs, parseClaudeSessions, parseClaudeSessionsAsync } from './parser-claude';
import { findCodexDirs, parseCodexSessions } from './parser-codex';
import { findOpenCodeDirs, parseOpenCodeSessions } from './parser-opencode';
import { EditLocIndex } from './edit-loc-diff';

type WorkspaceMap = Map<string, Workspace>;

interface HarnessCollectionContext {
  workspaces: WorkspaceMap;
  sessions: Session[];
  editLocIndex: EditLocIndex;
}

interface ExternalHarnessCollector {
  name: string;
  collectSync(ctx: HarnessCollectionContext): void;
  collectAsync?(ctx: HarnessCollectionContext, reportDetail?: (detail: string) => void): Promise<void>;
}

function addSession(workspaces: WorkspaceMap, sessions: Session[], session: Session, rootPath: string): void {
  sessions.push(session);
  if (!workspaces.has(session.workspaceId)) {
    const sessionRootPath = session.workspaceRootPath && fs.existsSync(session.workspaceRootPath) ? session.workspaceRootPath : rootPath;
    workspaces.set(session.workspaceId, { id: session.workspaceId, name: session.workspaceName, path: sessionRootPath });
  }
}

const EXTERNAL_HARNESSES: ExternalHarnessCollector[] = [
  {
    name: 'Claude Code',
    collectSync(ctx) {
      for (const claudeDir of findClaudeDirs()) {
        for (const { sessions } of parseClaudeSessions(claudeDir, ctx.editLocIndex)) {
          for (const session of sessions) addSession(ctx.workspaces, ctx.sessions, session, claudeDir);
        }
      }
    },
    async collectAsync(ctx, reportDetail) {
      for (const claudeDir of findClaudeDirs()) {
        const results = await parseClaudeSessionsAsync(claudeDir, (idx, total, name) => {
          reportDetail?.(`${idx}/${total}: ${name}`);
        }, ctx.editLocIndex);
        for (const { sessions } of results) {
          for (const session of sessions) addSession(ctx.workspaces, ctx.sessions, session, claudeDir);
        }
      }
    },
  },
  {
    name: 'Codex CLI',
    collectSync(ctx) {
      for (const codexDir of findCodexDirs()) {
        for (const session of parseCodexSessions(codexDir, ctx.editLocIndex)) addSession(ctx.workspaces, ctx.sessions, session, codexDir);
      }
    },
  },
  {
    name: 'OpenCode',
    collectSync(ctx) {
      for (const ocDir of findOpenCodeDirs()) {
        for (const session of parseOpenCodeSessions(ocDir, ctx.editLocIndex)) addSession(ctx.workspaces, ctx.sessions, session, ocDir);
      }
    },
  },
];

export interface ExternalHarnessProgressHandlers {
  onHarnessStart?: (name: string, index: number, total: number, sessionCount: number) => void;
  onHarnessDetail?: (name: string, detail: string, sessionCount: number) => void;
  onHarnessError?: (name: string, error: unknown) => void;
  yieldToLoop?: () => Promise<void>;
}

/** Returns true if any external-harness (Claude Code, Codex, OpenCode) session
 *  source exists on disk. The dashboard uses this so it does not abort when the
 *  only available logs come from a non-VS Code harness — e.g. a headless
 *  Remote-SSH host that has Claude Code sessions under `~/.claude/projects` but
 *  no VS Code workspace storage or Copilot directories. */
export function hasExternalHarnessSources(): boolean {
  // Without a home directory the find* helpers would join against an empty
  // string and probe relative paths (e.g. `.claude/projects`) under the current
  // working directory, which could report false positives. Bail out instead.
  if (!process.env.HOME && !process.env.USERPROFILE) return false;
  return findClaudeDirs().length > 0 || findCodexDirs().length > 0 || findOpenCodeDirs().length > 0;
}

/**
 * Register the on-disk source file for external-harness sessions that carry one,
 * so lazy re-reads (image extraction for the Coding Moments gallery, full-text
 * session detail) can find the raw bytes stripped from the in-memory model.
 *
 * Only single-file harnesses set `sourceFilePath` — currently Claude Code, whose
 * sessions are self-contained `*.jsonl` files. Codex / OpenCode sessions carry no
 * source path and are skipped (they reference no images, so the gallery never
 * needs to re-read them). Call after each external-harness collection pass.
 *
 * Subagent image requests are a special case: parseClaudeSessions merges them
 * into their parent session, but their bytes stay in a different file
 * (`<session>/subagents/agent-*.jsonl`). Those carry their own request-level
 * `sourceFilePath`, and are indexed under a `<sessionId>::<requestId>` composite
 * key so image extraction reads the subagent file, not the parent. Only
 * image-bearing requests get an entry, keeping the serialized index small.
 */
export function registerExternalHarnessSources(
  sessions: Session[],
  sessionSourceIndex: Map<string, SessionSource>,
): void {
  for (const s of sessions) {
    if (s.sourceFilePath) {
      sessionSourceIndex.set(s.sessionId, {
        kind: 'claude-session-file',
        filePath: s.sourceFilePath,
        workspaceId: s.workspaceId,
        workspaceName: s.workspaceName,
        harness: s.harness,
      });
    }
    for (const r of s.requests) {
      if (!r.sourceFilePath || r.sourceFilePath === s.sourceFilePath) continue;
      if ((r.variableKinds.image ?? 0) <= 0) continue;
      sessionSourceIndex.set(`${s.sessionId}::${r.requestId}`, {
        kind: 'claude-session-file',
        filePath: r.sourceFilePath,
        workspaceId: s.workspaceId,
        workspaceName: s.workspaceName,
        harness: s.harness,
      });
    }
  }
}

export function collectExternalHarnessesSync(
  workspaces: WorkspaceMap,
  sessions: Session[],
  editLocIndex: EditLocIndex,
): void {
  const ctx: HarnessCollectionContext = { workspaces, sessions, editLocIndex };
  for (const harness of EXTERNAL_HARNESSES) {
    harness.collectSync(ctx);
  }
}

/** Harness values set on sessions by external harness collectors.
 *  The cache reconciliation in parser.ts uses this set to identify and
 *  refresh cached external-harness sessions, so every value the collectors
 *  can produce must be listed here. */
export const EXTERNAL_HARNESS_SET = new Set<string>([
  'Claude',
  'Codex',
  'OpenCode',
]);

export async function collectExternalHarnessesAsync(
  workspaces: WorkspaceMap,
  sessions: Session[],
  editLocIndex: EditLocIndex,
  handlers: ExternalHarnessProgressHandlers = {},
): Promise<void> {
  const ctx: HarnessCollectionContext = { workspaces, sessions, editLocIndex };
  const total = EXTERNAL_HARNESSES.length;

  for (let index = 0; index < EXTERNAL_HARNESSES.length; index++) {
    const harness = EXTERNAL_HARNESSES[index];
    handlers.onHarnessStart?.(harness.name, index, total, sessions.length);
    if (handlers.yieldToLoop) await handlers.yieldToLoop();

    try {
      if (harness.collectAsync) {
        await harness.collectAsync(ctx, (detail) => handlers.onHarnessDetail?.(harness.name, detail, sessions.length));
      } else {
        harness.collectSync(ctx);
      }
    } catch (error) {
      handlers.onHarnessError?.(harness.name, error);
    }

    if (handlers.yieldToLoop) await handlers.yieldToLoop();
  }
}
