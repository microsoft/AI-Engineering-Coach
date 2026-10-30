/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AntiPatternData, ConfigHealthData, Session, Workspace } from './types';
import type { EditLocIndex } from './edit-loc-diff';

export interface WarmUpWorkerRequest {
  sessions: Session[];
  editLocIndex?: EditLocIndex;
  workspaces?: Map<string, Workspace>;
}

export interface WarmUpWorkerResult {
  antiPatterns: AntiPatternData | null;
  configHealth: ConfigHealthData | null;
}

export type WarmUpWorkerResponse =
  | ({ type: 'result' } & WarmUpWorkerResult)
  | { type: 'error'; message: string };

export function isWarmUpWorkerRequest(value: unknown): value is WarmUpWorkerRequest {
  return typeof value === 'object' && value !== null
    && 'sessions' in value && Array.isArray(value.sessions)
    && (!('editLocIndex' in value) || value.editLocIndex === undefined || value.editLocIndex instanceof Map)
    && (!('workspaces' in value) || value.workspaces === undefined || value.workspaces instanceof Map);
}
