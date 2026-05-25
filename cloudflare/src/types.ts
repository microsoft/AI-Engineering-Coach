export type TeamRole = 'admin' | 'member';
export type TeamDashboardCategory = 'prompt-quality' | 'session-hygiene' | 'code-review' | 'tool-mastery' | 'context-management';

export interface TeamDashboardFilters {
  developerId?: string;
  fromMs?: number;
  toMs?: number;
  category?: TeamDashboardCategory;
}

export interface TeamDashboardAccess {
  role: TeamRole;
  developerId: string;
  canExportPdf: boolean;
}

export interface TeamDashboardCategoryScores {
  promptQuality: number;
  sessionHygiene: number;
  codeReview: number;
  toolMastery: number;
  contextManagement: number;
}

export interface TeamDashboardViolation {
  key: string;
  label: string;
  count: number;
  severity: 'low' | 'medium' | 'high';
}

export interface TeamDashboardMemberRow {
  developerId: string;
  displayName: string;
  snapshotCount: number;
  categoryScores: TeamDashboardCategoryScores;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requests: number;
  };
  antiPatterns: {
    total: number;
    topViolations: TeamDashboardViolation[];
  };
  weeklyTrend: {
    weekStartsOn: string[];
    promptQuality: number[];
    sessionHygiene: number[];
    codeReview: number[];
    toolMastery: number[];
    contextManagement: number[];
  };
  weekOverWeek: TeamDashboardCategoryScores;
}

export interface TeamDashboardResponse {
  access: TeamDashboardAccess;
  filters: TeamDashboardFilters;
  selectedCategory: TeamDashboardCategory | 'all';
  totalDevelopers: number;
  developers: TeamDashboardMemberRow[];
}

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
