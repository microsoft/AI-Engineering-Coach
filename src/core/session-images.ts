/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { SessionSource } from './cache';
import type { Session, TimelineSessionText, TimelineTextScope } from './types';
import type { ScrubContext } from './session-labels';
import { timelineSessionText } from './timeline-text';
import { extractCLIImageReferences, parseCLIEventsFile } from './parser-vscode-cli';
import { earliestRequestTime, extractClaudeImageReferences, isClaudeSubagentFile, parseClaudeSessionFile } from './parser-claude';
import { extractCodexImageReferences, parseCodexSessionFile } from './parser-codex';
import { loadOpenCodeSession, readOpenCodeImageReferences } from './parser-opencode';
import { loadXcodeSession, readXcodeImageReferences } from './parser-xcode';
import { parseSessionFile } from './parser-vscode';
import { extractSessionImages } from './parser-vscode-files';
import { loadImageReferences, type ImageReference, type ImageRequestMatch } from './image-data';

export interface SessionImagesRequest extends ImageRequestMatch {
  type: 'session-images';
  source: SessionSource;
  sessionId: string;
  requestId: string;
}

export interface SessionDetailRequest {
  type: 'session-detail';
  source: SessionSource;
  sessionId: string;
}

/** The text behind one Timeline lane, built in the worker so the full session never crosses to the extension host. */
export interface TimelineTextRequest {
  type: 'timeline-text';
  source: SessionSource;
  sessionId: string;
  scope: TimelineTextScope;
  /** The turns the analysis kept, by identity, when it dropped a fork's copied turns. */
  kept?: string[];
  labels: ScrubContext;
}

export type SessionSourceRequest = SessionImagesRequest | SessionDetailRequest | TimelineTextRequest;

/** Runs in the parse worker: the lane's scoped, scrubbed text, or null when its log can't be read again. */
export function loadTimelineText(request: TimelineTextRequest): TimelineSessionText | null {
  const session = loadSourceSession(request.source, request.sessionId);
  return session ? timelineSessionText(session, request.labels, request.scope, request.kept ? new Set(request.kept) : undefined) : null;
}

/** Runs in the parse worker: a session for its detail view, without the text only the Timeline shows (the agent's
 *  own messages apart from its code, and what each question and permission prompt asked and you answered). That
 *  reaches the extension only through `loadTimelineText`, scoped and scrubbed. */
export function loadSourceSessionDetail(source: SessionSource, sessionId: string): Session | null {
  const session = loadSourceSession(source, sessionId);
  if (!session) return null;
  for (const r of session.requests) {
    delete r.replyText;
    for (const w of r.userWaits ?? []) delete w.text;
  }
  for (const w of session.userWaits ?? []) delete w.text;
  return session;
}

export function loadSourceSession(source: SessionSource, sessionId: string): Session | null {
  switch (source.kind) {
    case 'vscode-session-file':
      return parseSessionFile(source.filePath, source.workspaceId, source.workspaceName, source.harness);
    case 'cli-events':
      return parseCLIEventsFile(source.filePath, source.workspaceId, source.workspaceName);
    case 'codex-jsonl':
      return parseCodexSessionFile(source.filePath);
    case 'claude-jsonl': {
      const sessions = [source.filePath, ...source.additionalFilePaths ?? []]
        .map(file => parseClaudeSessionFile(file, source.workspaceId, source.workspaceName, { subagentFile: isClaudeSubagentFile(file) }))
        .filter((session): session is Session => session !== null);
      if (!sessions[0]) return null;
      // Each user line once, as the parser counts it, and none that another session counted.
      const seen = new Set(source.droppedUserEventIds);
      const requests = sessions.flatMap(session => session.requests)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        .filter(request => {
          if (!request.userEventId) return true;
          if (seen.has(request.userEventId)) return false;
          seen.add(request.userEventId);
          return true;
        });
      return {
        ...sessions[0],
        sessionId,
        // Dated from the turns it kept, as the parser dates every session.
        creationDate: earliestRequestTime(requests),
        requests,
        requestCount: requests.length,
        lastMessageDate: Math.max(...sessions.map(session => session.lastMessageDate ?? 0)) || null,
      };
    }
    case 'opencode-storage':
    case 'opencode-db':
      return loadOpenCodeSession(source.filePath, sessionId);
    case 'xcode-db':
      return loadXcodeSession(source.filePath, sessionId);
  }
}

/** Runs in the parse worker; raw payloads never enter the analytics cache. */
export function extractSourceImages(source: SessionSource, sessionId: string, requestId: string, match?: ImageRequestMatch): string[] {
  let references: ImageReference[] = [];
  switch (source.kind) {
    case 'vscode-session-file':
      return extractSessionImages(source.filePath, requestId, source.workspaceRootPath);
    case 'cli-events':
      references = extractCLIImageReferences(source.filePath, sessionId, requestId, match);
      break;
    case 'codex-jsonl':
      references = extractCodexImageReferences(source.filePath, sessionId, requestId, match);
      break;
    case 'claude-jsonl':
      for (const file of [source.filePath, ...source.additionalFilePaths ?? []]) {
        const result = extractClaudeImageReferences(file, requestId, match);
        if (result.images.length > 0) {
          return loadImageReferences(result.images, path.dirname(file), result.workspaceRootPath ?? source.workspaceRootPath);
        }
      }
      return [];
    case 'opencode-storage':
    case 'opencode-db':
      references = readOpenCodeImageReferences(source.filePath, sessionId, requestId);
      break;
    case 'xcode-db':
      references = readXcodeImageReferences(source.filePath, sessionId, requestId);
      break;
  }
  return loadImageReferences(references, path.dirname(source.filePath), source.workspaceRootPath);
}
