/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { SessionSource } from './cache';
import type { Session } from './types';
import { extractCLIImageReferences, parseCLIEventsFile } from './parser-vscode-cli';
import { extractClaudeImageReferences, parseClaudeSessionFile } from './parser-claude';
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

export type SessionSourceRequest = SessionImagesRequest | SessionDetailRequest;

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
        .map(file => parseClaudeSessionFile(file, source.workspaceId, source.workspaceName))
        .filter((session): session is Session => session !== null);
      if (!sessions[0]) return null;
      const requests = sessions.flatMap(session => session.requests)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const creationDates = sessions.map(session => session.creationDate).filter((date): date is number => date !== null);
      return {
        ...sessions[0],
        sessionId,
        creationDate: creationDates.length > 0 ? Math.min(...creationDates) : null,
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
