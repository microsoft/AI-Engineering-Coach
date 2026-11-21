/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { fileUriToPath, toDateStr } from './helpers';
import { techFromPath } from './parser-shared';
import { toolCapability } from './curiosity-activity';
import type { Session, SessionRequest } from './types';
import type { CuriositySession } from './types/curiosity-types';

const SOURCE_LANGUAGES = new Set([
  'TypeScript', 'JavaScript', 'Python', 'Java', 'C#', 'Go', 'Rust', 'Ruby', 'PHP',
  'Swift', 'Kotlin', 'Scala', 'C', 'C++', 'HTML', 'CSS', 'SQL', 'Shell',
  'PowerShell', 'Terraform', 'Bicep', 'R', 'Lua', 'Dart', 'Vue', 'Svelte',
]);

export function eventKey(request: SessionRequest, session: Session, index: number): string {
  const source = session.harness === 'GitHub Copilot App' || session.harness === 'GitHub Copilot CLI'
    ? 'copilot' : session.harness;
  // Wording is deliberately absent: real repeated questions must remain separate events.
  return request.userEventId
    ? JSON.stringify([source, request.userEventId, request.timestamp])
    : JSON.stringify([source, session.workspaceId, session.sessionId, index]);
}

export function sessionReference(session: Session, request: SessionRequest, context?: CuriositySession['context']): CuriositySession {
  const name = session.requests.find(request => request.curiosity?.kind !== 'excluded' && request.messageText)?.messageText
    .replaceAll(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled session';
  const promptText = request.messageText.replaceAll(/\s+/g, ' ').trim();
  const promptPreview = promptText.slice(0, 80);
  const promptTruncated = promptText.length > 80 || request.messageText.length < request.messageLength;
  const timestamp = request.timestamp!;
  return { sessionId: session.sessionId, requestId: request.requestId, workspaceId: session.workspaceId,
    name, promptPreview, promptTruncated, timestamp, date: toDateStr(timestamp),
    workspace: session.workspaceName, harness: session.harness, ...(context?.length ? { context } : {}) };
}

function repositoryArea(raw: string, root: string): string | undefined {
  if (/[*?\p{Cc}]/u.test(raw) || /^[a-z][a-z\d+.-]*:\/\//i.test(raw) && !raw.startsWith('file://')) return;
  if (raw.startsWith('file://') && !raw.startsWith('file:///')) return;
  const file = path.posix.normalize(fileUriToPath(raw).replaceAll('\\', '/'));
  if (/\p{Cc}/u.test(file)) return;
  const absolute = path.posix.isAbsolute(file) || /^[a-z]:\//i.test(file);
  const windows = /^[a-z]:\//i.test(root);
  const relative = absolute
    ? root ? path.posix.relative(windows ? root.toLowerCase() : root, windows ? file.toLowerCase() : file) : ''
    : file;
  if (!relative || relative === '..' || relative.startsWith('../')) return;
  const directory = path.posix.extname(relative) ? path.posix.dirname(relative) : relative;
  if (directory === '.' || !directory.includes('/') && !relative.includes('/')) return;
  return `${directory.split('/').slice(0, 2).join('/')}/`;
}

export function sessionContext(session: Session, requests: SessionRequest[]): NonNullable<CuriositySession['context']> {
  const tags = new Map<string, NonNullable<CuriositySession['context']>[number]>();
  const seen = new Set<string>();
  const root = session.workspaceRootPath
    ? path.posix.normalize(fileUriToPath(session.workspaceRootPath).replaceAll('\\', '/')) : '';
  for (const [index, request] of requests.entries()) {
    if (request.curiosity?.kind === 'excluded') continue;
    const id = eventKey(request, session, index);
    if (seen.has(id)) continue;
    seen.add(id);
    const capabilities = new Set(request.toolsUsed.map(toolCapability));
    const labels = new Map<string, NonNullable<CuriositySession['context']>[number]>();
    const add = (kind: 'web' | 'repository', label: string) => {
      if (label) labels.set(`${kind}:${label}`, { kind, label, turns: 1 });
    };
    if (capabilities.has('web')) for (const domain of request.webDomains ?? []) add('web', domain);
    if (capabilities.has('repository')) for (const raw of request.referencedFiles) {
      const area = repositoryArea(raw, root);
      if (area) add('repository', area);
    }
    for (const [key, tag] of labels) {
      const existing = tags.get(key);
      if (existing) existing.turns++;
      else tags.set(key, tag);
    }
  }
  return (['web', 'repository'] as const).flatMap(kind => [...tags.values()].filter(tag => tag.kind === kind)
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label)).slice(0, 2));
}

export function sessionLanguageFiles(requests: SessionRequest[], session: Session): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const root = session.workspaceRootPath
    ? path.posix.normalize(fileUriToPath(session.workspaceRootPath).replaceAll('\\', '/')).replace(/\/$/, '') : '';
  for (const request of requests) {
    if (request.curiosity?.kind === 'excluded') continue;
    for (const raw of [...request.editedFiles, ...request.referencedFiles]) {
      if (/[*?]/.test(raw)) continue;
      const file = path.posix.normalize(fileUriToPath(raw).replaceAll('\\', '/'));
      const absolute = file.startsWith('/') || /^[a-z]:\//i.test(file);
      const tech = techFromPath(file);
      const language = tech === 'React' ? 'JavaScript' : tech;
      if (!SOURCE_LANGUAGES.has(language)) continue;
      const files = result.get(language) ?? new Set<string>();
      const resolved = root && !absolute ? path.posix.join(root, file) : file;
      files.add(/^[a-z]:\//i.test(resolved) ? resolved.toLowerCase() : resolved);
      result.set(language, files);
    }
  }
  return result;
}

export function keepRecent<T>(items: T[], item: T, timestamp: (value: T) => number, limit: number): void {
  items.push(item);
  items.sort((a, b) => timestamp(b) - timestamp(a));
  if (items.length > limit) items.length = limit;
}

export function keepSession(items: CuriositySession[], item: CuriositySession): void {
  const existing = items.findIndex(value => value.sessionId === item.sessionId && value.harness === item.harness && value.workspace === item.workspace);
  if (existing >= 0) {
    if (items[existing].timestamp >= item.timestamp) return;
    items.splice(existing, 1);
  }
  keepRecent(items, item, value => value.timestamp, 8);
}
