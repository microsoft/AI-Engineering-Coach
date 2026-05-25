export const TEAM_SCHEMA_VERSION = 1;

export function buildTeamSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS team_servers (
      server_id TEXT PRIMARY KEY NOT NULL,
      server_name TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      bootstrap_secret_hash TEXT,
      bootstrap_completed_at_ms INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS team_members (
      member_id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      developer_id TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      created_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      UNIQUE(server_id, developer_id)
    )`,
    `CREATE TABLE IF NOT EXISTS team_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      last_seen_at_ms INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS team_invitations (
      invite_code TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      created_by_member_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'redeemed', 'revoked', 'expired')),
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      redeemed_at_ms INTEGER,
      redeemed_by_member_id TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS team_snapshots (
      snapshot_id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      developer_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      captured_at_ms INTEGER NOT NULL,
      window_start_ms INTEGER NOT NULL,
      window_end_ms INTEGER NOT NULL,
      prompt_quality_score INTEGER NOT NULL,
      session_hygiene_score INTEGER NOT NULL,
      code_review_score INTEGER NOT NULL,
      tool_mastery_score INTEGER NOT NULL,
      context_management_score INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      anti_pattern_total INTEGER NOT NULL,
      anti_pattern_low INTEGER NOT NULL,
      anti_pattern_medium INTEGER NOT NULL,
      anti_pattern_high INTEGER NOT NULL,
      weekly_trend_json TEXT NOT NULL,
      top_violations_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      UNIQUE(server_id, developer_id, captured_at_ms, payload_hash)
    )`,
  ];
}

