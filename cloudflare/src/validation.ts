import type { TeamSnapshotPayload } from './types';

const FORBIDDEN_RAW_KEYS = new Set([
  'promptText',
  'rawPromptText',
  'sessionText',
  'rawSessionText',
  'fileName',
  'filePath',
  'workspaceName',
  'sessionTranscript',
  'codeText',
  'sourceText',
]);

export function containsForbiddenRawFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenRawFields(item));

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RAW_KEYS.has(key)) return true;
    if (containsForbiddenRawFields(nested)) return true;
  }

  return false;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSeverity(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function isTeamSnapshotPayload(value: unknown): value is TeamSnapshotPayload {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  const categoryScores = snapshot.categoryScores as Record<string, unknown> | undefined;
  const tokenUsage = snapshot.tokenUsage as Record<string, unknown> | undefined;
  const antiPatterns = snapshot.antiPatterns as Record<string, unknown> | undefined;
  const bySeverity = antiPatterns?.bySeverity as Record<string, unknown> | undefined;
  const weeklyTrend = snapshot.weeklyTrend as Record<string, unknown> | undefined;

  return snapshot.schemaVersion === 1
    && typeof snapshot.developerId === 'string'
    && isFiniteNumber(snapshot.capturedAtMs)
    && isFiniteNumber(snapshot.windowStartMs)
    && isFiniteNumber(snapshot.windowEndMs)
    && !!categoryScores
    && isFiniteNumber(categoryScores.promptQuality)
    && isFiniteNumber(categoryScores.sessionHygiene)
    && isFiniteNumber(categoryScores.codeReview)
    && isFiniteNumber(categoryScores.toolMastery)
    && isFiniteNumber(categoryScores.contextManagement)
    && !!tokenUsage
    && isFiniteNumber(tokenUsage.inputTokens)
    && isFiniteNumber(tokenUsage.outputTokens)
    && isFiniteNumber(tokenUsage.totalTokens)
    && !!antiPatterns
    && isFiniteNumber(antiPatterns.total)
    && !!bySeverity
    && isFiniteNumber(bySeverity.low)
    && isFiniteNumber(bySeverity.medium)
    && isFiniteNumber(bySeverity.high)
    && weeklyTrend !== undefined
    && Array.isArray(weeklyTrend.weekStartsOn)
    && Array.isArray(weeklyTrend.promptQuality)
    && Array.isArray(weeklyTrend.sessionHygiene)
    && Array.isArray(weeklyTrend.codeReview)
    && Array.isArray(weeklyTrend.toolMastery)
    && Array.isArray(weeklyTrend.contextManagement);
}

export function validateTeamSnapshotPayload(value: unknown): { ok: true } | { ok: false; error: string } {
  if (!isTeamSnapshotPayload(value)) {
    return { ok: false, error: 'invalid ingest request' };
  }
  if (containsForbiddenRawFields(value)) {
    return { ok: false, error: 'raw session data is not allowed' };
  }
  return { ok: true };
}
