import { randomUUID, createHash } from 'node:crypto';
import type {
  TeamBootstrapRequest,
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

      return errorResponse('not found', 404);
    },
  };
}

export function createTeamModeApp(options: TeamModeAppOptions): TeamModeApp {
  return createApp(options.env);
}
