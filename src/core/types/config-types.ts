/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AntiPattern } from './analytics-types';
import type { AgenticReadinessScore } from './context-types';

/* ---- Context Health ---- */

export interface ConfigFileInfo {
  relativePath: string;
  kind: 'instruction' | 'prompt' | 'agent' | 'skill' | 'hook-config' | 'claude-md' | 'other';
  lines: number;
  chars: number;
  isMarkdown: boolean;
  markdownIssues: string[];
  sizeVerdict: 'compact' | 'moderate' | 'oversized';
  /** Epoch ms of file's last modification time */
  lastModified: number | null;
}

export interface HookCoverageInfo {
  hasPreToolUse: boolean;
  hasPostToolUse: boolean;
  hasSessionStart: boolean;
  hasPermissionRequest: boolean;
  totalHooks: number;
  hookEvents: string[];
}

export interface WorkspaceConfigHealth {
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  harness: string;
  configFiles: ConfigFileInfo[];
  hasInstructions: boolean;
  hasPrompts: boolean;
  hasAgents: boolean;
  hasSkills: boolean;
  hasHooks: boolean;
  progressiveDisclosureScore: number;
  instructionQualityScore: number;
  hookCoverage: HookCoverageInfo | null;
  suggestions: string[];
  /** Activity metrics for this workspace within the date range */
  sessionCount: number;
  requestCount: number;
  lastActivity: number | null;
  /** True if context files haven't been updated since last workspace activity */
  staleContext: boolean;
  staleDays: number | null;
}

export interface ContextProvisionScore {
  harness: string;
  totalRequests: number;
  withFileRefs: number;
  withCustomInstructions: number;
  withSkills: number;
  withTools: number;
  avgContextItems: number;
  score: number;
  /** Extended detail fields for the expanded view */
  totalSessions: number;
  avgRequestsPerSession: number;
  topModels: { model: string; count: number }[];
  topTools: { tool: string; count: number }[];
  topReferencedFiles: { file: string; count: number }[];
  avgPromptLength: number;
  cancelRate: number;
  agentModeRate: number;
  modeDistribution: { mode: string; count: number }[];
  avgResponseLength: number;
}

export interface ConfigHealthData {
  workspaces: WorkspaceConfigHealth[];
  overallScore: number;
  agenticReadiness: AgenticReadinessScore;
  contextProvisionByHarness: Record<string, ContextProvisionScore>;
  suggestions: string[];
  contextAntiPatterns: AntiPattern[];
}

export interface TeamModeSettings {
  enabled: boolean;
}
