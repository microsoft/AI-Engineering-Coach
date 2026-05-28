import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { exportTeamModeSnapshotFile, buildTeamDashboardResponse, importTeamModeSnapshotFiles, loadTeamModeImportedSnapshots } from './team-mode-local';
import { sanitizeTeamModeSnapshotFile } from './team-mode';
import { createEmptyTeamModeSnapshotFile } from './types/team-mode-types';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeStorageUri(): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-team-mode-'));
  tempDirs.push(dir);
  return { fsPath: dir } as unknown as vscode.Uri;
}

function makeSnapshot(dateIso: string, score: number) {
  const snapshot = createEmptyTeamModeSnapshotFile();
  const timestamp = Date.parse(`${dateIso}T12:00:00Z`);
  snapshot.capturedAtMs = timestamp;
  snapshot.windowStartMs = timestamp;
  snapshot.windowEndMs = timestamp;
  snapshot.categoryScores['prompt-quality'] = score;
  snapshot.categoryScores['session-hygiene'] = score - 1;
  snapshot.categoryScores['code-review'] = score - 2;
  snapshot.categoryScores['tool-mastery'] = score - 3;
  snapshot.categoryScores['context-management'] = score - 4;
  snapshot.categoryBreakdown['prompt-quality'] = {
    score,
    wowPct: score - 50,
    momPct: score - 40,
    patternCount: 1,
    topIssue: `Prompt issue ${score}`,
    improvements: [`Improve prompts ${score}`],
  };
  snapshot.categoryBreakdown['session-hygiene'] = {
    score: score - 1,
    wowPct: 1,
    momPct: 2,
    patternCount: 0,
    topIssue: null,
    improvements: [],
  };
  return snapshot;
}

async function importSnapshots(storageUri: vscode.Uri): Promise<void> {
  const snapshots = [
    ['alice-1.json', 'Alice', makeSnapshot('2026-05-05', 70)],
    ['alice-2.json', 'Alice', makeSnapshot('2026-05-06', 75)],
    ['alice-3.json', 'Alice', makeSnapshot('2026-05-12', 80)],
    ['alice-4.json', 'Alice', makeSnapshot('2026-06-02', 85)],
  ] as const;

  for (const [fileName, , snapshot] of snapshots) {
    fs.writeFileSync(path.join(storageUri.fsPath, fileName), JSON.stringify(snapshot, null, 2), 'utf8');
  }

  const requests = snapshots.map(([fileName, displayName]) => ({
    filePath: path.join(storageUri.fsPath, fileName),
    displayName,
  }));

  const result = await importTeamModeSnapshotFiles(storageUri, requests);
  expect(result.imported).toBe(4);
  expect(result.skipped).toBe(0);
  expect(result.rejected).toHaveLength(0);
}

describe('Team Mode local aggregation', () => {
  it('rolls up the same imported data into daily, weekly, and monthly bucket counts', async () => {
    const storageUri = makeStorageUri();
    await importSnapshots(storageUri);

    const daily = await buildTeamDashboardResponse(storageUri, {}, {
      enabled: true,
      aggregationGranularity: 'daily',
      detailLevel: 'expanded',
    });
    const weekly = await buildTeamDashboardResponse(storageUri, {}, {
      enabled: true,
      aggregationGranularity: 'weekly',
      detailLevel: 'expanded',
    });
    const monthly = await buildTeamDashboardResponse(storageUri, {}, {
      enabled: true,
      aggregationGranularity: 'monthly',
      detailLevel: 'category-only',
    });

    expect(daily.aggregation).toMatchObject({
      granularity: 'daily',
      detailLevel: 'expanded',
      label: 'Daily rollup',
      bucketCount: 4,
    });
    expect(weekly.aggregation).toMatchObject({
      granularity: 'weekly',
      detailLevel: 'expanded',
      label: 'Weekly rollup',
      bucketCount: 3,
    });
    expect(monthly.aggregation).toMatchObject({
      granularity: 'monthly',
      detailLevel: 'category-only',
      label: 'Monthly rollup',
      bucketCount: 2,
    });
    expect(daily.developers[0]).toMatchObject({
      snapshotCount: 4,
      bucketCount: 4,
      aggregationDetailLevel: 'expanded',
    });
    expect(weekly.developers[0]).toMatchObject({
      snapshotCount: 4,
      bucketCount: 3,
      aggregationGranularity: 'weekly',
    });
    expect(monthly.developers[0]).toMatchObject({
      snapshotCount: 4,
      bucketCount: 2,
      aggregationGranularity: 'monthly',
    });
  });

  it('keeps imported records intact while only changing the grouping view', async () => {
    const storageUri = makeStorageUri();
    await importSnapshots(storageUri);

    const before = await loadTeamModeImportedSnapshots(storageUri);
    const weekly = await buildTeamDashboardResponse(storageUri, {}, {
      enabled: true,
      aggregationGranularity: 'weekly',
      detailLevel: 'expanded',
    });
    const monthly = await buildTeamDashboardResponse(storageUri, {}, {
      enabled: true,
      aggregationGranularity: 'monthly',
      detailLevel: 'expanded',
    });
    const after = await loadTeamModeImportedSnapshots(storageUri);

    expect(before.map((record) => record.snapshot.capturedAtMs)).toEqual(after.map((record) => record.snapshot.capturedAtMs));
    expect(weekly.totalSnapshots).toBe(4);
    expect(monthly.totalSnapshots).toBe(4);
    expect(weekly.developers[0].snapshotCount).toBe(4);
    expect(monthly.developers[0].snapshotCount).toBe(4);
    expect(weekly.aggregation.bucketCount).toBe(3);
    expect(monthly.aggregation.bucketCount).toBe(2);
  });

  it('exports snapshot metadata that stays compatible on import', async () => {
    const storageUri = makeStorageUri();
    const snapshot = createEmptyTeamModeSnapshotFile();
    snapshot.capturedAtMs = Date.parse('2026-06-10T12:00:00Z');
    snapshot.windowStartMs = snapshot.capturedAtMs;
    snapshot.windowEndMs = snapshot.capturedAtMs;
    snapshot.aggregation = {
      granularity: 'monthly',
      detailLevel: 'expanded',
    };

    const result = await exportTeamModeSnapshotFile(storageUri, snapshot);
    const raw = JSON.parse(fs.readFileSync(result.filePath, 'utf8')) as unknown;
    const sanitized = sanitizeTeamModeSnapshotFile(raw);

    expect(raw).toMatchObject({
      schemaVersion: 2,
      aggregation: {
        granularity: 'monthly',
        detailLevel: 'expanded',
      },
    });
    expect(sanitized?.aggregation).toEqual({
      granularity: 'monthly',
      detailLevel: 'expanded',
    });
  });
});
