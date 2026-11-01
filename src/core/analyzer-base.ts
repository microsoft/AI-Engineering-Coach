/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Base class for analyzer modules -- provides shared filtering logic */

import { Session, SessionRequest, DateFilter } from './types';
import { EditLocIndex } from './edit-loc-diff';
import { toDateStr } from './helpers';

/** Total LoC for a request: exact edit lines when available, otherwise code-block lines. */
export function getRequestLoc(request: SessionRequest, editLocIndex: EditLocIndex): number {
  const fileEdits = editLocIndex.get(request.requestId);
  if (!fileEdits) return request.aiCode.reduce((sum, block) => sum + block.loc, 0);
  let editLoc = 0;
  for (const value of fileEdits.values()) editLoc += value.added;
  return editLoc;
}

export class AnalyzerBase {
  protected readonly sessions: Session[];
  protected readonly editLocIndex: EditLocIndex;
  protected readonly requestSessionMap: Map<SessionRequest, Session>;

  constructor(sessions: Session[], editLocIndex: EditLocIndex, sharedMap?: Map<SessionRequest, Session>) {
    this.sessions = sessions;
    this.editLocIndex = editLocIndex;
    if (sharedMap) {
      this.requestSessionMap = sharedMap;
    } else {
      this.requestSessionMap = AnalyzerBase.buildRequestSessionMap(sessions);
    }
  }

  static buildRequestSessionMap(sessions: Session[]): Map<SessionRequest, Session> {
    const map = new Map<SessionRequest, Session>();
    for (const s of sessions) {
      for (const r of s.requests) {
        map.set(r, s);
      }
    }
    return map;
  }

  protected matchesWorkspaceFilter(session: Session, workspaceId?: string): boolean {
    if (!workspaceId) return true;
    return session.workspaceId === workspaceId || session.workspaceName === workspaceId;
  }

  /** True when the request has a timestamp inside the filter's date range. */
  protected requestInRange(r: SessionRequest, f?: DateFilter): boolean {
    if (r.timestamp == null || r.timestamp <= 0) return false;
    if (f?.fromDate && toDateStr(r.timestamp) < f.fromDate) return false;
    if (f?.toDate && toDateStr(r.timestamp) > f.toDate) return false;
    return true;
  }

  protected filter(f?: DateFilter): SessionRequest[] {
    const reqs: SessionRequest[] = [];
    for (const s of this.sessions) {
      if (!this.matchesWorkspaceFilter(s, f?.workspaceId)) continue;
      if (f?.harness && s.harness !== f.harness) continue;
      for (const r of s.requests) {
        if (this.requestInRange(r, f)) reqs.push(r);
      }
    }
    return reqs;
  }

  protected requestLoc(r: SessionRequest): number {
    return getRequestLoc(r, this.editLocIndex);
  }

  protected filteredSessions(f?: DateFilter): Session[] {
    return this.sessions.filter(s => {
      if (!this.matchesWorkspaceFilter(s, f?.workspaceId)) return false;
      if (f?.harness && s.harness !== f.harness) return false;
      const ts = s.lastMessageDate || s.creationDate;
      if (ts == null || ts <= 0) return false;
      const d = toDateStr(ts);
      if (f?.fromDate && d < f.fromDate) return false;
      if (f?.toDate && d > f.toDate) return false;
      return true;
    });
  }

  /** Sessions with at least one request in the date range, matching `filter`. Unlike `filteredSessions`
   *  (keyed on last activity), this keeps sessions that span the range boundary. */
  protected sessionsWithRequestsInRange(f?: DateFilter): Session[] {
    return this.sessions.filter(s =>
      this.matchesWorkspaceFilter(s, f?.workspaceId)
      && (!f?.harness || s.harness === f.harness)
      && s.requests.some(r => this.requestInRange(r, f)));
  }

  /** Ensure the day-key array includes fromDate so fillDayRange starts
   *  from the filter boundary, keeping all charts aligned on the same x-axis. */
  protected anchorFromDate(keys: string[], f?: DateFilter): string[] {
    if (!f?.fromDate || f.fromDate <= '0001-01-01') return keys;
    const sorted = keys.length > 0 ? [...keys].sort() : [];
    if (sorted.length === 0 || f.fromDate < sorted[0]) {
      return [f.fromDate, ...keys];
    }
    return keys;
  }
}
