/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import { sanitizeTeamModeSnapshotFile } from './team-mode';
import {
  TEAM_MODE_CATEGORIES,
  createEmptyTeamDashboardCategoryScores,
  createEmptyTeamModeTokenUsageSummary,
} from './types/team-mode-types';
import type {
  TeamDashboardCategoryScores,
  TeamDashboardDeveloperRow,
  TeamDashboardFilters,
  TeamDashboardResponse,
  TeamModeImportedSnapshotRecord,
  TeamModeSnapshotFile,
  TeamModeTokenUsageSummary,
  TeamModeAntiPatternSummary,
  TeamModeSeverity,
} from './types/team-mode-types';

const TEAM_MODE_STORAGE_DIR = 'team-mode';
const TEAM_MODE_EXPORTS_DIR = 'exports';
const TEAM_MODE_IMPORTS_FILE = 'imports.json';

interface PersistedTeamModeImportStore {
  schemaVersion: 1;
  importedSnapshots: TeamModeImportedSnapshotRecord[];
}

export interface TeamModeSnapshotImportRequest {
  filePath: string;
  displayName: string;
}

export interface TeamModeSnapshotImportResult {
  imported: number;
  skipped: number;
  rejected: Array<{ filePath: string; reason: string }>;
  records: TeamModeImportedSnapshotRecord[];
}

export interface TeamModeSnapshotExportResult {
  filePath: string;
  fileName: string;
  capturedAtMs: number;
}

function storageRoot(storageUri: vscode.Uri): string {
  return path.join(storageUri.fsPath, TEAM_MODE_STORAGE_DIR);
}

function importsFilePath(storageUri: vscode.Uri): string {
  return path.join(storageRoot(storageUri), TEAM_MODE_IMPORTS_FILE);
}

function exportsDir(storageUri: vscode.Uri): string {
  return path.join(storageRoot(storageUri), TEAM_MODE_EXPORTS_DIR);
}

function normalizeDeveloperId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDisplayName(value: string, fallbackFileName: string): string {
  const trimmed = value.trim();
  if (trimmed) return trimmed;
  return path.parse(fallbackFileName).name || fallbackFileName || 'Developer';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}


function normalizeSnapshot(raw: unknown): TeamModeSnapshotFile | null {
  return sanitizeTeamModeSnapshotFile(raw);
}

async function ensureStorageDirs(storageUri: vscode.Uri): Promise<void> {
  await fs.promises.mkdir(storageRoot(storageUri), { recursive: true });
  await fs.promises.mkdir(exportsDir(storageUri), { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  return fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readPersistedStore(raw: unknown): PersistedTeamModeImportStore | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.importedSnapshots)) return null;

  const importedSnapshots: TeamModeImportedSnapshotRecord[] = [];
  for (const item of raw.importedSnapshots) {
    if (!isRecord(item)) continue;
    const filePath = typeof item.filePath === 'string' ? item.filePath : '';
    const fileName = typeof item.fileName === 'string' ? item.fileName : '';
    const displayName = typeof item.displayName === 'string' ? item.displayName : '';
    const importedAtMs = toFiniteNumber(item.importedAtMs);
    const snapshot = normalizeSnapshot(item.snapshot);
    const importId = typeof item.importId === 'string' ? item.importId : randomUUID();
    if (!filePath || !fileName || !displayName || importedAtMs == null || !snapshot) continue;
    importedSnapshots.push({
      importId,
      filePath,
      fileName,
      displayName,
      importedAtMs: Math.round(importedAtMs),
      snapshot,
    });
  }

  return { schemaVersion: 1, importedSnapshots };
}

function createImportRecord(filePath: string, displayName: string, snapshot: TeamModeSnapshotFile): TeamModeImportedSnapshotRecord {
  return {
    importId: randomUUID(),
    filePath,
    fileName: path.basename(filePath),
    displayName,
    importedAtMs: Date.now(),
    snapshot,
  };
}

function snapshotMatchesFilters(record: TeamModeImportedSnapshotRecord, filters: TeamDashboardFilters): boolean {
  if (filters.developerId && normalizeDeveloperId(record.displayName) !== normalizeDeveloperId(filters.developerId)) return false;
  if (typeof filters.fromMs === 'number' && record.snapshot.capturedAtMs < filters.fromMs) return false;
  if (typeof filters.toMs === 'number' && record.snapshot.capturedAtMs > filters.toMs) return false;
  return true;
}

function normalizeDashboardFilters(filters?: TeamDashboardFilters): TeamDashboardFilters {
  return {
    developerId: filters?.developerId?.trim() || undefined,
    fromMs: typeof filters?.fromMs === 'number' && Number.isFinite(filters.fromMs) ? filters.fromMs : undefined,
    toMs: typeof filters?.toMs === 'number' && Number.isFinite(filters.toMs) ? filters.toMs : undefined,
    category: filters?.category || undefined,
  };
}

function averageScores(records: TeamModeImportedSnapshotRecord[]): TeamDashboardCategoryScores {
  const totals = createEmptyTeamDashboardCategoryScores();
  if (records.length === 0) return totals;
  for (const record of records) {
    for (const category of TEAM_MODE_CATEGORIES) {
      totals[category] += record.snapshot.categoryScores[category];
    }
  }
  for (const category of TEAM_MODE_CATEGORIES) {
    totals[category] = Math.round(totals[category] / records.length);
  }
  return totals;
}

function averageDeltas(records: TeamModeImportedSnapshotRecord[]): TeamDashboardCategoryScores {
  const totals = createEmptyTeamDashboardCategoryScores();
  if (records.length === 0) return totals;
  for (const record of records) {
    for (const category of TEAM_MODE_CATEGORIES) {
      totals[category] += record.snapshot.weeklyDeltas[category];
    }
  }
  for (const category of TEAM_MODE_CATEGORIES) {
    totals[category] = Math.round(totals[category] / records.length);
  }
  return totals;
}

function sumTokenUsage(records: TeamModeImportedSnapshotRecord[]): TeamModeTokenUsageSummary {
  const totals = createEmptyTeamModeTokenUsageSummary();
  let missingTokenCount = 0;
  let finalizableRequests = 0;

  for (const record of records) {
    const usage = record.snapshot.tokenUsage;
    totals.requests += usage.requests;
    totals.countedRequests += usage.countedRequests;
    totals.partialRequests += usage.partialRequests;
    totals.pendingRequests += usage.pendingRequests;
    totals.noDataRequests += usage.noDataRequests;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.totalTokens += usage.totalTokens;

    const finalizable = Math.max(0, usage.requests - usage.pendingRequests - usage.noDataRequests);
    finalizableRequests += finalizable;
    missingTokenCount += Math.round((usage.missingPct / 100) * finalizable);
  }

  totals.missingPct = finalizableRequests > 0 ? Math.round((missingTokenCount / finalizableRequests) * 10) / 10 : 0;
  return totals;
}

function mergeAntiPatterns(records: TeamModeImportedSnapshotRecord[]): { totalOccurrences: number; bySeverity: Record<TeamModeSeverity, number>; topViolations: TeamModeAntiPatternSummary[] } {
  const bySeverity: Record<TeamModeSeverity, number> = { low: 0, medium: 0, high: 0 };
  const byRule = new Map<string, TeamModeAntiPatternSummary>();
  let totalOccurrences = 0;

  for (const record of records) {
    totalOccurrences += record.snapshot.antiPatterns.totalOccurrences;
    for (const severity of ['low', 'medium', 'high'] as const) {
      bySeverity[severity] += record.snapshot.antiPatterns.bySeverity[severity];
    }
    for (const violation of record.snapshot.antiPatterns.topViolations) {
      const key = `${violation.severity}:${violation.ruleId}`;
      const existing = byRule.get(key);
      if (existing) {
        existing.count += violation.count;
      } else {
        byRule.set(key, { ...violation });
      }
    }
  }

  const topViolations = [...byRule.values()]
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
    .slice(0, 10);

  return { totalOccurrences, bySeverity, topViolations };
}

function buildDeveloperRow(displayName: string, records: TeamModeImportedSnapshotRecord[]): TeamDashboardDeveloperRow {
  const sorted = [...records].sort((a, b) => a.snapshot.capturedAtMs - b.snapshot.capturedAtMs);
  return {
    developerId: normalizeDeveloperId(displayName),
    displayName,
    snapshotCount: records.length,
    latestCapturedAtMs: sorted[sorted.length - 1]?.snapshot.capturedAtMs ?? 0,
    categoryScores: averageScores(records),
    tokenUsage: sumTokenUsage(records),
    antiPatterns: mergeAntiPatterns(records),
    weekOverWeek: averageDeltas(records),
    importedSnapshots: sorted.map((record) => ({
      snapshotId: record.importId,
      fileName: record.fileName,
      capturedAtMs: record.snapshot.capturedAtMs,
      importedAtMs: record.importedAtMs,
    })),
  };
}

export async function loadTeamModeImportedSnapshots(storageUri: vscode.Uri): Promise<TeamModeImportedSnapshotRecord[]> {
  try {
    const raw = await readJsonFile<PersistedTeamModeImportStore>(importsFilePath(storageUri));
    const store = raw ? readPersistedStore(raw) : null;
    return store?.importedSnapshots ?? [];
  } catch {
    return [];
  }
}

export async function saveTeamModeImportedSnapshots(storageUri: vscode.Uri, importedSnapshots: TeamModeImportedSnapshotRecord[]): Promise<void> {
  await ensureStorageDirs(storageUri);
  const store: PersistedTeamModeImportStore = {
    schemaVersion: 1,
    importedSnapshots,
  };
  await writeJsonFile(importsFilePath(storageUri), store);
}

export async function exportTeamModeSnapshotFile(storageUri: vscode.Uri, snapshot: TeamModeSnapshotFile): Promise<TeamModeSnapshotExportResult> {
  await ensureStorageDirs(storageUri);
  const exportedAt = new Date(snapshot.capturedAtMs || Date.now());
  const stamp = exportedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const fileName = `team-mode-snapshot-${stamp}.json`;
  const filePath = path.join(exportsDir(storageUri), fileName);
  await writeJsonFile(filePath, snapshot);
  return {
    filePath,
    fileName,
    capturedAtMs: snapshot.capturedAtMs,
  };
}

export async function importTeamModeSnapshotFiles(
  storageUri: vscode.Uri,
  imports: TeamModeSnapshotImportRequest[],
): Promise<TeamModeSnapshotImportResult> {
  const existing = await loadTeamModeImportedSnapshots(storageUri);
  const byPath = new Map(existing.map((record) => [record.filePath, record]));
  const rejected: TeamModeSnapshotImportResult['rejected'] = [];
  let imported = 0;
  let skipped = 0;

  for (const item of imports) {
    const raw = await readJsonFile<unknown>(item.filePath);
    const snapshot = normalizeSnapshot(raw);
    if (!snapshot) {
      rejected.push({ filePath: item.filePath, reason: 'Snapshot file is invalid or incomplete' });
      continue;
    }

    const fileName = path.basename(item.filePath);
    const displayName = normalizeDisplayName(item.displayName, fileName);
    const record = createImportRecord(item.filePath, displayName, snapshot);
    if (byPath.has(item.filePath)) {
      byPath.set(item.filePath, record);
      skipped += 1;
    } else {
      byPath.set(item.filePath, record);
      imported += 1;
    }
  }

  const nextRecords = [...byPath.values()];
  await saveTeamModeImportedSnapshots(storageUri, nextRecords);
  return {
    imported,
    skipped,
    rejected,
    records: nextRecords,
  };
}

export async function buildTeamDashboardResponse(storageUri: vscode.Uri, filters?: TeamDashboardFilters): Promise<TeamDashboardResponse> {
  const importedSnapshots = await loadTeamModeImportedSnapshots(storageUri);
  const normalizedFilters = normalizeDashboardFilters(filters);
  const activeSnapshots = importedSnapshots.filter((record) => snapshotMatchesFilters(record, normalizedFilters));
  const grouped = new Map<string, TeamModeImportedSnapshotRecord[]>();
  const availableDevelopers = new Map<string, string>();

  for (const record of importedSnapshots) {
    const developerId = normalizeDeveloperId(record.displayName);
    availableDevelopers.set(developerId, record.displayName);
    const rows = grouped.get(developerId) ?? [];
    rows.push(record);
    grouped.set(developerId, rows);
  }

  const developers = [...grouped.entries()]
    .map(([developerId, records]) => buildDeveloperRow(availableDevelopers.get(developerId) ?? developerId, records.filter((record) => snapshotMatchesFilters(record, normalizedFilters))))
    .filter((developer) => developer.snapshotCount > 0)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const totalSnapshots = activeSnapshots.length;
  const totalDevelopers = new Set(activeSnapshots.map((record) => normalizeDeveloperId(record.displayName))).size;
  const lastImportedAtMs = importedSnapshots.reduce((max, record) => Math.max(max, record.importedAtMs), 0) || null;

  return {
    filters: normalizedFilters,
    selectedCategory: normalizedFilters.category ?? 'all',
    totalDevelopers,
    totalSnapshots,
    importedSnapshots: importedSnapshots.length,
    availableDevelopers: [...availableDevelopers.entries()]
      .map(([developerId, displayName]) => ({ developerId, displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    developers,
    hasSnapshots: importedSnapshots.length > 0,
    lastImportedAtMs,
  };
}
