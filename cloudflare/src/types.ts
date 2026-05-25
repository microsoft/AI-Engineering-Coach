export type TeamRole = 'admin' | 'member';

export interface TeamModeEnv {
  TEAM_MODE_BOOTSTRAP_SECRET?: string;
  DB?: {
    prepare(sql: string): {
      bind(...values: unknown[]): {
        run(): Promise<unknown>;
      };
    };
  };
}

export interface TeamModeApp {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface TeamBootstrapRequest {
  serverName: string;
  adminLabel: string;
}

export interface TeamInviteRequest {
  label: string;
  expiresInHours: number;
}

export interface TeamJoinRequest {
  inviteCode: string;
  developerId: string;
}

export interface TeamSnapshotPayload {
  schemaVersion: 1;
  developerId: string;
  capturedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  categoryScores: {
    promptQuality: number;
    sessionHygiene: number;
    codeReview: number;
    toolMastery: number;
    contextManagement: number;
  };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  antiPatterns: {
    total: number;
    bySeverity: {
      low: number;
      medium: number;
      high: number;
    };
    byGroup: Record<string, number>;
    topViolations: Array<{
      key: string;
      label: string;
      count: number;
      severity: 'low' | 'medium' | 'high';
    }>;
  };
  weeklyTrend: {
    weekStartsOn: string[];
    promptQuality: number[];
    sessionHygiene: number[];
    codeReview: number[];
    toolMastery: number[];
    contextManagement: number[];
  };
}

export interface TeamIngestRequest {
  snapshot: TeamSnapshotPayload;
}

export interface TeamIngestResult {
  ok: true;
  inserted: boolean;
}

