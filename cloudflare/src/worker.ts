import { randomUUID, createHash } from 'node:crypto';
import type {
  TeamBootstrapRequest,
  TeamDashboardAccess,
  TeamDashboardCategory,
  TeamDashboardFilters,
  TeamDashboardMemberRow,
  TeamDashboardResponse,
  TeamIngestRequest,
  TeamInviteRequest,
  TeamJoinRequest,
  TeamModeApp,
  TeamModeEnv,
  TeamRole,
  TeamIngestResult,
} from './types';
import { createTeamSnapshotRow, persistTeamSnapshot, type TeamSnapshotRow, type TeamModeDatabase } from './store';
import { validateTeamSnapshotPayload } from './validation';

interface TeamServerRecord {
  serverId: string;
  serverName: string;
  createdAtMs: number;
  bootstrapSecretHash: string;
  bootstrapCompletedAtMs?: number;
}

interface TeamMemberRecord {
  memberId: string;
  serverId: string;
  developerId: string;
  displayName: string;
  role: TeamRole;
  createdAtMs: number;
}

interface TeamTokenRecord {
  token: string;
  tokenHash: string;
  serverId: string;
  memberId: string;
  issuedAtMs: number;
}

interface TeamInviteRecord {
  inviteCode: string;
  serverId: string;
  createdByMemberId: string;
  label: string;
  status: 'active' | 'redeemed' | 'revoked' | 'expired';
  issuedAtMs: number;
  expiresAtMs: number;
  redeemedAtMs?: number;
  redeemedByMemberId?: string;
}

interface TeamModeState {
  server?: TeamServerRecord;
  members: TeamMemberRecord[];
  tokens: TeamTokenRecord[];
  invites: TeamInviteRecord[];
  snapshots: TeamSnapshotRow[];
}

interface TeamModeAppOptions {
  env: TeamModeEnv;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, { status });
}

function readJsonBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createBootstrapToken(serverId: string, memberId: string): string {
  return `team_${serverId}_${memberId}_${randomUUID()}`;
}

function isBootstrapRequest(value: unknown): value is TeamBootstrapRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.serverName === 'string' && typeof candidate.adminLabel === 'string';
}

function createTeamState(): TeamModeState {
  return {
    members: [],
    tokens: [],
    invites: [],
    snapshots: [],
  };
}

function parseAuthorizationToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token.trim();
}

function findTokenRecord(state: TeamModeState, token: string): TeamTokenRecord | undefined {
  const tokenHash = hashValue(token);
  return state.tokens.find((candidate) => candidate.tokenHash === tokenHash);
}

function findMemberById(state: TeamModeState, memberId: string): TeamMemberRecord | undefined {
  return state.members.find((candidate) => candidate.memberId === memberId);
}

function isInviteRequest(value: unknown): value is TeamInviteRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.label === 'string' && typeof candidate.expiresInHours === 'number';
}

function isJoinRequest(value: unknown): value is TeamJoinRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.inviteCode === 'string' && typeof candidate.developerId === 'string';
}

function isIngestRequest(value: unknown): value is TeamIngestRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.snapshot === 'object' && candidate.snapshot !== null;
}

function getAdminContext(state: TeamModeState, request: Request): { member: TeamMemberRecord; token: TeamTokenRecord } | Response {
  const token = parseAuthorizationToken(request);
  if (!token) return errorResponse('missing authorization', 401);

  const tokenRecord = findTokenRecord(state, token);
  if (!tokenRecord) return errorResponse('invalid token', 401);

  const member = findMemberById(state, tokenRecord.memberId);
  if (!member || member.role !== 'admin') return errorResponse('admin access required', 403);

  return { member, token: tokenRecord };
}

function getMemberContext(state: TeamModeState, request: Request): { member: TeamMemberRecord; token: TeamTokenRecord } | Response {
  const token = parseAuthorizationToken(request);
  if (!token) return errorResponse('missing authorization', 401);

  const tokenRecord = findTokenRecord(state, token);
  if (!tokenRecord) return errorResponse('invalid token', 401);

  const member = findMemberById(state, tokenRecord.memberId);
  if (!member) return errorResponse('invalid member', 401);

  return { member, token: tokenRecord };
}

function createPayloadHash(snapshot: TeamIngestRequest['snapshot']): string {
  return hashValue(JSON.stringify(snapshot));
}

function parseDashboardFilters(url: URL): TeamDashboardFilters {
  const developerId = url.searchParams.get('developerId')?.trim();
  const category = url.searchParams.get('category')?.trim() as TeamDashboardCategory | '' | null;
  const fromMsRaw = url.searchParams.get('from');
  const toMsRaw = url.searchParams.get('to');

  return {
    developerId: developerId || undefined,
    category: category && category !== 'all' ? category : undefined,
    fromMs: fromMsRaw ? Number(fromMsRaw) : undefined,
    toMs: toMsRaw ? Number(toMsRaw) : undefined,
  };
}

function parseWeeklyTrendJson(value: string): TeamSnapshotRow['weeklyTrendJson'] extends string ? Record<string, number[]> : never {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed as Record<string, number[]>;
  } catch {
    return {} as Record<string, number[]>;
  }
}

function parseViolationsJson(value: string): Array<{ key: string; label: string; count: number; severity: 'low' | 'medium' | 'high' }> {
  try {
    const parsed = JSON.parse(value) as Array<{ key?: unknown; label?: unknown; count?: unknown; severity?: unknown }>;
    return parsed
      .filter((item) => typeof item.key === 'string' && typeof item.label === 'string' && typeof item.count === 'number' && (item.severity === 'low' || item.severity === 'medium' || item.severity === 'high'))
      .map((item) => ({
        key: item.key as string,
        label: item.label as string,
        count: item.count as number,
        severity: item.severity as 'low' | 'medium' | 'high',
      }));
  } catch {
    return [];
  }
}

function emptyCategoryScores(): TeamDashboardMemberRow['categoryScores'] {
  return {
    promptQuality: 0,
    sessionHygiene: 0,
    codeReview: 0,
    toolMastery: 0,
    contextManagement: 0,
  };
}

function emptyWeeklyTrend(): TeamDashboardMemberRow['weeklyTrend'] {
  return {
    weekStartsOn: [],
    promptQuality: [],
    sessionHygiene: [],
    codeReview: [],
    toolMastery: [],
    contextManagement: [],
  };
}

function aggregateDeveloperRows(state: TeamModeState, filters: TeamDashboardFilters, member: TeamMemberRecord): TeamDashboardMemberRow[] {
  const fromMs = typeof filters.fromMs === 'number' && Number.isFinite(filters.fromMs) ? filters.fromMs : undefined;
  const toMs = typeof filters.toMs === 'number' && Number.isFinite(filters.toMs) ? filters.toMs : undefined;
  const activeDeveloperId = filters.developerId || member.developerId;

  const snapshots = state.snapshots.filter((snapshot) => {
    if (snapshot.serverId !== state.server?.serverId) return false;
    if (member.role !== 'admin' && snapshot.developerId !== member.developerId) return false;
    if (filters.developerId && snapshot.developerId !== filters.developerId) return false;
    if (fromMs !== undefined && snapshot.capturedAtMs < fromMs) return false;
    if (toMs !== undefined && snapshot.capturedAtMs > toMs) return false;
    return true;
  });

  const grouped = new Map<string, TeamSnapshotRow[]>();
  for (const snapshot of snapshots) {
    const rows = grouped.get(snapshot.developerId) ?? [];
    rows.push(snapshot);
    grouped.set(snapshot.developerId, rows);
  }

  const rows: TeamDashboardMemberRow[] = [];
  for (const [developerId, entries] of grouped.entries()) {
    const memberRow = state.members.find((candidate) => candidate.developerId === developerId);
    const latest = [...entries].sort((a, b) => b.capturedAtMs - a.capturedAtMs)[0];
    const categoryScores = entries.reduce((acc, entry) => {
      acc.promptQuality += entry.promptQualityScore;
      acc.sessionHygiene += entry.sessionHygieneScore;
      acc.codeReview += entry.codeReviewScore;
      acc.toolMastery += entry.toolMasteryScore;
      acc.contextManagement += entry.contextManagementScore;
      return acc;
    }, emptyCategoryScores());
    const divisor = entries.length || 1;
    const latestTrend = parseWeeklyTrendJson(latest.weeklyTrendJson);
    const topViolationCounts = new Map<string, { key: string; label: string; count: number; severity: 'low' | 'medium' | 'high' }>();
    let totalViolations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let requests = 0;

    for (const entry of entries) {
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
      totalTokens += entry.totalTokens;
      requests += 1;
      totalViolations += entry.antiPatternTotal;
      for (const violation of parseViolationsJson(entry.topViolationsJson)) {
        const existing = topViolationCounts.get(violation.key);
        if (existing) {
          existing.count += violation.count;
        } else {
          topViolationCounts.set(violation.key, { ...violation });
        }
      }
    }

    rows.push({
      developerId,
      displayName: memberRow?.displayName || developerId,
      snapshotCount: entries.length,
      categoryScores: {
        promptQuality: Math.round(categoryScores.promptQuality / divisor),
        sessionHygiene: Math.round(categoryScores.sessionHygiene / divisor),
        codeReview: Math.round(categoryScores.codeReview / divisor),
        toolMastery: Math.round(categoryScores.toolMastery / divisor),
        contextManagement: Math.round(categoryScores.contextManagement / divisor),
      },
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens,
        requests,
      },
      antiPatterns: {
        total: totalViolations,
        topViolations: Array.from(topViolationCounts.values()).sort((a, b) => b.count - a.count),
      },
      weeklyTrend: {
        weekStartsOn: Array.isArray(latestTrend.weekStartsOn) ? latestTrend.weekStartsOn.map((week) => String(week)) : [],
        promptQuality: Array.isArray(latestTrend.promptQuality) ? latestTrend.promptQuality.map(Number) : [],
        sessionHygiene: Array.isArray(latestTrend.sessionHygiene) ? latestTrend.sessionHygiene.map(Number) : [],
        codeReview: Array.isArray(latestTrend.codeReview) ? latestTrend.codeReview.map(Number) : [],
        toolMastery: Array.isArray(latestTrend.toolMastery) ? latestTrend.toolMastery.map(Number) : [],
        contextManagement: Array.isArray(latestTrend.contextManagement) ? latestTrend.contextManagement.map(Number) : [],
      },
      weekOverWeek: {
        promptQuality: computeWeekOverWeek(latestTrend.promptQuality),
        sessionHygiene: computeWeekOverWeek(latestTrend.sessionHygiene),
        codeReview: computeWeekOverWeek(latestTrend.codeReview),
        toolMastery: computeWeekOverWeek(latestTrend.toolMastery),
        contextManagement: computeWeekOverWeek(latestTrend.contextManagement),
      },
    });
  }

  if (member.role !== 'admin') {
    return rows.filter((row) => row.developerId === activeDeveloperId || row.developerId === member.developerId);
  }

  if (filters.developerId) {
    return rows.filter((row) => row.developerId === filters.developerId);
  }

  return rows.sort((a, b) => a.developerId.localeCompare(b.developerId));
}

function computeWeekOverWeek(values: unknown): number {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const last = Number(values[values.length - 1]);
  const prev = Number(values[values.length - 2]);
  if (!Number.isFinite(last) || !Number.isFinite(prev)) return 0;
  return Math.round(last - prev);
}

function buildDashboardResponse(state: TeamModeState, member: TeamMemberRecord, filters: TeamDashboardFilters): TeamDashboardResponse {
  const access = {
    role: member.role,
    developerId: member.developerId,
    canExportPdf: member.role === 'admin',
  } satisfies TeamDashboardAccess;

  return {
    access,
    filters,
    selectedCategory: filters.category || 'all',
    totalDevelopers: new Set(state.snapshots.map((snapshot) => snapshot.developerId)).size,
    developers: aggregateDeveloperRows(state, filters, member),
  };
}

function bootstrapServer(state: TeamModeState, env: TeamModeEnv, body: TeamBootstrapRequest): Response {
  if (!env.TEAM_MODE_BOOTSTRAP_SECRET) {
    return errorResponse('missing bootstrap secret', 500);
  }

  if (state.server) {
    return jsonResponse({
      serverId: state.server.serverId,
      role: 'admin',
      token: state.tokens[0]?.token ?? '',
    });
  }

  const now = Date.now();
  const serverId = randomUUID();
  const memberId = randomUUID();
  const token = createBootstrapToken(serverId, memberId);
  const tokenHash = hashValue(token);

  state.server = {
    serverId,
    serverName: body.serverName.trim(),
    createdAtMs: now,
    bootstrapSecretHash: hashValue(env.TEAM_MODE_BOOTSTRAP_SECRET),
    bootstrapCompletedAtMs: now,
  };

  state.members.push({
    memberId,
    serverId,
    developerId: 'admin',
    displayName: body.adminLabel.trim(),
    role: 'admin',
    createdAtMs: now,
  });

  state.tokens.push({
    token,
    tokenHash,
    serverId,
    memberId,
    issuedAtMs: now,
  });

  return jsonResponse({
    serverId,
    role: 'admin',
    token,
  });
}

function createInvite(state: TeamModeState, request: Request): Response {
  const context = getAdminContext(state, request);
  if (context instanceof Response) return context;

  const body = awaitJsonBody<TeamInviteRequest>(request);
  return body.then((parsed) => {
    if (!isInviteRequest(parsed)) {
      return errorResponse('invalid invite request');
    }

    if (!state.server) {
      return errorResponse('team not initialized', 400);
    }

    const now = Date.now();
    const expiresAtMs = now + Math.max(1, parsed.expiresInHours) * 60 * 60 * 1000;
    const inviteCode = `invite_${randomUUID().replaceAll('-', '')}`;

    state.invites.push({
      inviteCode,
      serverId: state.server.serverId,
      createdByMemberId: context.member.memberId,
      label: parsed.label.trim(),
      status: 'active',
      issuedAtMs: now,
      expiresAtMs,
    });

    return jsonResponse({
      inviteCode,
      expiresAtMs,
    });
  });
}

async function awaitJsonBody<T>(request: Request): Promise<T> {
  return readJsonBody<T>(request);
}

async function joinWithInvite(state: TeamModeState, request: Request): Promise<Response> {
  const body = await readJsonBody<unknown>(request);
  if (!isJoinRequest(body)) {
    return errorResponse('invalid join request');
  }

  if (!state.server) {
    return errorResponse('team not initialized', 400);
  }

  const invite = state.invites.find((candidate) => candidate.inviteCode === body.inviteCode);
  if (!invite) return errorResponse('invalid invite code', 400);
  if (invite.status !== 'active') return errorResponse('invite unavailable', 400);
  if (invite.expiresAtMs <= Date.now()) {
    invite.status = 'expired';
    return errorResponse('invite expired', 400);
  }

  if (state.members.some((candidate) => candidate.developerId === body.developerId)) {
    return errorResponse('developer already joined', 409);
  }

  const now = Date.now();
  const memberId = randomUUID();
  const token = `team_${state.server.serverId}_${memberId}_${randomUUID()}`;
  const tokenHash = hashValue(token);

  const member: TeamMemberRecord = {
    memberId,
    serverId: state.server.serverId,
    developerId: body.developerId.trim(),
    displayName: body.developerId.trim(),
    role: 'member',
    createdAtMs: now,
  };

  state.members.push(member);
  state.tokens.push({
    token,
    tokenHash,
    serverId: state.server.serverId,
    memberId,
    issuedAtMs: now,
  });

  invite.status = 'redeemed';
  invite.redeemedAtMs = now;
  invite.redeemedByMemberId = memberId;

  return jsonResponse({
    developerId: member.developerId,
    role: member.role,
    token,
  });
}

async function ingestSnapshot(state: TeamModeState, env: TeamModeEnv, request: Request, member: TeamMemberRecord): Promise<Response> {
  const body = await readJsonBody<unknown>(request);
  if (!isIngestRequest(body)) {
    return errorResponse('invalid ingest request');
  }

  const validation = validateTeamSnapshotPayload(body.snapshot);
  if (!validation.ok) {
    return errorResponse(validation.error, 400);
  }

  if (body.snapshot.developerId !== member.developerId) {
    return errorResponse('snapshot developer does not match token', 403);
  }

  const payloadHash = createPayloadHash(body.snapshot);
  const existing = state.snapshots.find((snapshot) => snapshot.serverId === state.server!.serverId
    && snapshot.developerId === body.snapshot.developerId
    && snapshot.capturedAtMs === body.snapshot.capturedAtMs
    && snapshot.payloadHash === payloadHash);

  if (existing) {
    return jsonResponse({ ok: true, inserted: false } satisfies TeamIngestResult);
  }

  const row = createTeamSnapshotRow(
    body.snapshot,
    state.server!.serverId,
    member.memberId,
    randomUUID(),
    payloadHash,
    Date.now(),
  );

  state.snapshots.push(row);
  await persistTeamSnapshot(env.DB as TeamModeDatabase | undefined, row);

  return jsonResponse({ ok: true, inserted: true } satisfies TeamIngestResult);
}

function createApp(env: TeamModeEnv): TeamModeApp {
  const state = createTeamState();

  return {
    async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
      const request = typeof input === 'string' ? new Request(input, init) : input;
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/bootstrap') {
        const parsed = await readJsonBody<unknown>(request);
        if (!isBootstrapRequest(parsed)) {
          return errorResponse('invalid bootstrap request');
        }
        return bootstrapServer(state, env, parsed);
      }

      if (request.method === 'POST' && url.pathname === '/invite') {
        return createInvite(state, request);
      }

      if (request.method === 'POST' && url.pathname === '/join') {
        return joinWithInvite(state, request);
      }

      if (request.method === 'POST' && url.pathname === '/ingest') {
        const context = getMemberContext(state, request);
        if (context instanceof Response) return context;
        return ingestSnapshot(state, env, request, context.member);
      }

      if (request.method === 'GET' && url.pathname === '/dashboard') {
        const context = getMemberContext(state, request);
        if (context instanceof Response) return context;
        if (!state.server) return errorResponse('team not initialized', 400);
        const filters = parseDashboardFilters(url);
        if (context.member.role !== 'admin' && filters.developerId && filters.developerId !== context.member.developerId) {
          return errorResponse('member dashboard access is self-scoped', 403);
        }
        const response = buildDashboardResponse(state, context.member, filters);
        return jsonResponse(response);
      }

      return errorResponse('not found', 404);
    },
  };
}

export function createTeamModeApp(options: TeamModeAppOptions): TeamModeApp {
  return createApp(options.env);
}
