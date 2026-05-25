import { loadTeamModeAuthState, type TeamModeAuthState } from './cache';
import type { TeamDashboardFilters, TeamDashboardResponse } from './types/team-mode-types';

export interface TeamDashboardClientOptions {
  fetchImpl?: typeof fetch;
  getAuthState?: () => TeamModeAuthState | null;
}

function normalizeFilters(filters?: TeamDashboardFilters): TeamDashboardFilters {
  return {
    developerId: filters?.developerId?.trim() || undefined,
    fromMs: typeof filters?.fromMs === 'number' && Number.isFinite(filters.fromMs) ? filters.fromMs : undefined,
    toMs: typeof filters?.toMs === 'number' && Number.isFinite(filters.toMs) ? filters.toMs : undefined,
    category: filters?.category,
  };
}

export class TeamDashboardClient {
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthState: () => TeamModeAuthState | null;

  constructor(options: TeamDashboardClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.getAuthState = options.getAuthState ?? loadTeamModeAuthState;
  }

  async fetchDashboard(filters?: TeamDashboardFilters): Promise<TeamDashboardResponse> {
    const authState = this.getAuthState();
    if (!authState) {
      throw new Error('Team Mode auth is not configured');
    }

    const normalized = normalizeFilters(filters);
    const url = new URL('/dashboard', authState.serverUrl);
    if (normalized.developerId) url.searchParams.set('developerId', normalized.developerId);
    if (typeof normalized.fromMs === 'number') url.searchParams.set('from', String(normalized.fromMs));
    if (typeof normalized.toMs === 'number') url.searchParams.set('to', String(normalized.toMs));
    if (normalized.category) url.searchParams.set('category', normalized.category);

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${authState.accessToken}`,
        'content-type': 'application/json',
      },
    });

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
    }

    return response.json() as Promise<TeamDashboardResponse>;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

