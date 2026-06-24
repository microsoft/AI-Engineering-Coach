import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Session, Message } from "./session.js";
import { assertTrustedPath } from "./parser-shared.js";

/** Roots where Cursor stores workspace SQLite databases */
function getCursorStorageRoots(): string[] {
  const roots: string[] = [];
  const platform = process.platform;

  if (platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) roots.push(path.join(appData, "Cursor", "User", "workspaceStorage"));
  } else if (platform === "darwin") {
    const home = process.env.HOME ?? "";
    roots.push(path.join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage"));
  } else {
    // Linux + WSL
    const home = process.env.HOME ?? "";
    roots.push(path.join(home, ".config", "Cursor", "User", "workspaceStorage"));
    // WSL path to Windows Cursor data
    const wslUser = process.env.USER ?? "";
    roots.push(`/mnt/c/Users/${wslUser}/AppData/Roaming/Cursor/User/workspaceStorage`);
  }

  return roots.filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch { return false; }
  });
}

/** Find all Cursor workspace SQLite databases */
function findCursorDatabases(): string[] {
  const dbs: string[] = [];
  for (const root of getCursorStorageRoots()) {
    try {
      const entries = fs.readdirSync(root);
      for (const hash of entries) {
        const dbPath = path.join(root, hash, "state.vscdb");
        if (fs.existsSync(dbPath)) dbs.push(dbPath);
      }
    } catch { /* skip unreadable dirs */ }
  }
  return dbs;
}

/** Run a sqlite3 query and return rows split by unit-separator \x1f */
function querySqlite(dbPath: string, sql: string): string[] {
  try {
    const raw = execSync(`sqlite3 -separator $'\\x1f' "${dbPath}" "${sql}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return raw.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

interface ComposerMeta {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  model?: string;
}

interface Bubble {
  bubbleId: string;
  type: "user" | "assistant" | string;
  text?: string;
  codeBlocks?: { content: string; language?: string }[];
  timingMs?: number;
}

function parseComposerData(raw: string): ComposerMeta | null {
  try {
    const data = JSON.parse(raw);
    return {
      composerId: data.composerId ?? "",
      name: data.name,
      createdAt: data.createdAt,
      lastUpdatedAt: data.lastUpdatedAt,
      model: data.selectedModel ?? data.model,
    };
  } catch { return null; }
}

function parseBubble(raw: string): Bubble | null {
  try {
    const data = JSON.parse(raw);
    const codeBlocks = (data.codeBlocks ?? []).map((b: { content?: string; language?: string }) => ({
      content: b.content ?? "",
      language: b.language,
    }));
    return {
      bubbleId: data.bubbleId ?? "",
      type: data.type === 1 ? "user" : "assistant",
      text: data.text ?? data.rawText ?? "",
      codeBlocks,
      timingMs: data.timingMs,
    };
  } catch { return null; }
}

function countLinesOfCode(bubbles: Bubble[]): number {
  let loc = 0;
  for (const b of bubbles) {
    if (b.type === "assistant") {
      for (const block of b.codeBlocks ?? []) {
        loc += block.content.split("\n").length;
      }
    }
  }
  return loc;
}

/** Parse a single Cursor workspace database into Sessions */
function parseCursorDb(dbPath: string): Session[] {
  assertTrustedPath(dbPath);

  // Get all composer sessions
  const composerRows = querySqlite(
    dbPath,
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
  );

  const sessions: Session[] = [];

  for (const row of composerRows) {
    const sep = row.indexOf("\x1f");
    if (sep === -1) continue;
    const value = row.slice(sep + 1);
    const meta = parseComposerData(value);
    if (!meta?.composerId) continue;

    // Get all bubbles for this composer
    const bubbleRows = querySqlite(
      dbPath,
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${meta.composerId}:%'`
    );

    const bubbles: Bubble[] = [];
    for (const bRow of bubbleRows) {
      const bSep = bRow.indexOf("\x1f");
      if (bSep === -1) continue;
      const bValue = bRow.slice(bSep + 1);
      const bubble = parseBubble(bValue);
      if (bubble) bubbles.push(bubble);
    }

    if (bubbles.length === 0) continue;

    // Build message pairs
    const messages: Message[] = [];
    let i = 0;
    while (i < bubbles.length) {
      const current = bubbles[i];
      if (current.type === "user") {
        const next = bubbles[i + 1];
        messages.push({
          prompt: current.text ?? "",
          response: next?.type === "assistant" ? (next.text ?? "") : "",
          durationMs: next?.timingMs,
          model: meta.model,
        });
        i += next?.type === "assistant" ? 2 : 1;
      } else {
        i++;
      }
    }

    if (messages.length === 0) continue;

    const linesOfCode = countLinesOfCode(bubbles);
    const startedAt = meta.createdAt ? new Date(meta.createdAt) : undefined;
    const endedAt = meta.lastUpdatedAt ? new Date(meta.lastUpdatedAt) : undefined;

    sessions.push({
      id: meta.composerId,
      title: meta.name ?? meta.composerId,
      source: "cursor",
      model: meta.model ?? "unknown",
      startedAt,
      endedAt,
      messages,
      linesOfCode,
      filePath: dbPath,
    });
  }

  return sessions;
}

/** Entry point called by the harness registry */
export async function parseCursorSessions(): Promise<Session[]> {
  const dbs = findCursorDatabases();
  const allSessions: Session[] = [];

  for (const db of dbs) {
    try {
      const sessions = parseCursorDb(db);
      allSessions.push(...sessions);
    } catch (err) {
      // skip unreadable databases
      if (process.env.DEBUG) console.error(`Cursor: skipping ${db}:`, err);
    }
  }

  return allSessions;
}