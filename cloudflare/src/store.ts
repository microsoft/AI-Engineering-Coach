import type { TeamSnapshotPayload } from './types';

export interface TeamModeSqlStatement {
  bind(...values: unknown[]): TeamModeSqlStatement;
  run(): Promise<unknown>;
}

export interface TeamModeDatabase {
  prepare(sql: string): TeamModeSqlStatement;
}

export interface TeamSnapshotRow {
  snapshotId: string;
  serverId: string;
  memberId: string;
  developerId: string;
  schemaVersion: number;
  capturedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  promptQualityScore: number;
  sessionHygieneScore: number;
  codeReviewScore: number;
  toolMasteryScore: number;
  contextManagementScore: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  antiPatternTotal: number;
  antiPatternLow: number;
  antiPatternMedium: number;
  antiPatternHigh: number;
  weeklyTrendJson: string;
  topViolationsJson: string;
  payloadHash: string;
  createdAtMs: number;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value);
}

export function createTeamSnapshotRow(
  snapshot: TeamSnapshotPayload,
  serverId: string,
  memberId: string,
  snapshotId: string,
  payloadHash: string,
  createdAtMs: number,
): TeamSnapshotRow {
  return {
    snapshotId,
    serverId,
    memberId,
    developerId: snapshot.developerId,
    schemaVersion: snapshot.schemaVersion,
    capturedAtMs: snapshot.capturedAtMs,
    windowStartMs: snapshot.windowStartMs,
    windowEndMs: snapshot.windowEndMs,
    promptQualityScore: snapshot.categoryScores.promptQuality,
    sessionHygieneScore: snapshot.categoryScores.sessionHygiene,
    codeReviewScore: snapshot.categoryScores.codeReview,
    toolMasteryScore: snapshot.categoryScores.toolMastery,
    contextManagementScore: snapshot.categoryScores.contextManagement,
    inputTokens: snapshot.tokenUsage.inputTokens,
    outputTokens: snapshot.tokenUsage.outputTokens,
    totalTokens: snapshot.tokenUsage.totalTokens,
    antiPatternTotal: snapshot.antiPatterns.total,
    antiPatternLow: snapshot.antiPatterns.bySeverity.low,
    antiPatternMedium: snapshot.antiPatterns.bySeverity.medium,
    antiPatternHigh: snapshot.antiPatterns.bySeverity.high,
    weeklyTrendJson: sortedJson(snapshot.weeklyTrend),
    topViolationsJson: sortedJson(snapshot.antiPatterns.topViolations),
    payloadHash,
    createdAtMs,
  };
}

export function buildSnapshotPayloadHash(row: TeamSnapshotRow): string {
  return row.payloadHash;
}

export async function persistTeamSnapshot(db: TeamModeDatabase | undefined, row: TeamSnapshotRow): Promise<void> {
  if (!db) return;
  await db.prepare(
    `INSERT INTO team_snapshots (
      snapshot_id,
      server_id,
      member_id,
      developer_id,
      schema_version,
      captured_at_ms,
      window_start_ms,
      window_end_ms,
      prompt_quality_score,
      session_hygiene_score,
      code_review_score,
      tool_mastery_score,
      context_management_score,
      input_tokens,
      output_tokens,
      total_tokens,
      anti_pattern_total,
      anti_pattern_low,
      anti_pattern_medium,
      anti_pattern_high,
      weekly_trend_json,
      top_violations_json,
      payload_hash,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.snapshotId,
    row.serverId,
    row.memberId,
    row.developerId,
    row.schemaVersion,
    row.capturedAtMs,
    row.windowStartMs,
    row.windowEndMs,
    row.promptQualityScore,
    row.sessionHygieneScore,
    row.codeReviewScore,
    row.toolMasteryScore,
    row.contextManagementScore,
    row.inputTokens,
    row.outputTokens,
    row.totalTokens,
    row.antiPatternTotal,
    row.antiPatternLow,
    row.antiPatternMedium,
    row.antiPatternHigh,
    row.weeklyTrendJson,
    row.topViolationsJson,
    row.payloadHash,
    row.createdAtMs,
  ).run();
}

