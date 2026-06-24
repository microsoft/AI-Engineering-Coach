import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Session, Message } from "./session.js";
import { assertTrustedPath } from "./parser-shared.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Cursor stores ALL chat data in a single global SQLite database.
 * Per-workspace `state.vscdb` files only contain UI state, not conversations.
 */
function getCursorGlobalDb(): string | null {
  let base: string;

  if (process.platform === "win32") {
    base = process.env.APPDATA ?? "";
    if (!base) return null;
    return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
  } else if (process.platform === "darwin") {
    base = process.env.HOME ?? "";
    if (!base) return null;
    return path.join(base, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  } else {
    // Linux / WSL
    base = process.env.HOME ?? "";
    const linuxPath = base ? path.join(base, ".config", "Cursor", "User", "globalStorage", "state.vscdb") : null;
    if (linuxPath && fs.existsSync(linuxPath)) return linuxPath;
    // WSL: try Windows path
    const wslUser = process.env.USER ?? "";
    if (wslUser) {
      const wslPath = `/mnt/c/Users/${wslUser}/AppData/Roaming/Cursor/User/globalStorage/state.vscdb`;
      if (fs.existsSync(wslPath)) return wslPath;
    }
    return linuxPath;
  }
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function runSqlite(dbPath: string, sql: string): string {
  try {
    return execSync(`sqlite3 "${dbPath}" ${JSON.stringify(sql)}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 30_000,
    }).trim();
  } catch {
    return "";
  }
}

function queryRows(dbPath: string, sql: string): string[] {
  const raw = runSqlite(dbPath, sql);
  return raw ? raw.split("\n").filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface ComposerMeta {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  model?: string;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  subtitle?: string;
}

interface LexicalNode {
  text?: string;
  children?: LexicalNode[];
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseComposerMeta(value: string): ComposerMeta | null {
  try {
    const d = JSON.parse(value);
    if (!d.composerId) return null;
    return {
      composerId: d.composerId,
      name: d.name || undefined,
      createdAt: d.createdAt || undefined,
      lastUpdatedAt: d.lastUpdatedAt || undefined,
      model: d.modelConfig?.model || d.model || undefined,
      totalLinesAdded: d.totalLinesAdded || 0,
      totalLinesRemoved: d.totalLinesRemoved || 0,
      subtitle: d.subtitle || undefined,
    };
  } catch {
    return null;
  }
}

/** Extract plain text from a Lexical editor JSON tree */
function extractLexicalText(nodeJson: string | undefined): string {
  if (!nodeJson) return "";
  try {
    const root: LexicalNode = JSON.parse(nodeJson);
    const collect = (node: LexicalNode): string => {
      let t = node.text ?? "";
      for (const child of node.children ?? []) t += collect(child);
      return t;
    };
    return collect((root as { root?: LexicalNode }).root ?? root).trim();
  } catch {
    return "";
  }
}

interface ParsedBubble {
  type: 1 | 2;
  text: string;
  createdAt?: string;
  linesAdded: number;
}

function parseBubble(value: string): ParsedBubble | null {
  try {
    const d = JSON.parse(value);
    const type: 1 | 2 = d.type === 1 ? 1 : 2;

    let text = "";
    if (type === 1) {
      // User bubble: extract from Lexical richText
      text = extractLexicalText(d.richText) || d.text || "";
    } else {
      // Assistant bubble: full response text is not persisted; use thinking as proxy
      text = d.thinking?.text || d.text || "";
    }

    // Count lines added from suggested diffs
    let linesAdded = 0;
    for (const diff of d.assistantSuggestedDiffs ?? []) {
      const content: string = diff.newFileContent ?? diff.content ?? "";
      if (content) linesAdded += content.split("\n").length;
    }
    for (const block of d.suggestedCodeBlocks ?? []) {
      const content: string = block.content ?? "";
      if (content) linesAdded += content.split("\n").length;
    }

    return { type, text, createdAt: d.createdAt, linesAdded };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export async function parseCursorSessions(): Promise<Session[]> {
  const dbPath = getCursorGlobalDb();
  if (!dbPath || !fs.existsSync(dbPath)) return [];

  assertTrustedPath(dbPath);

  // 1. Load all composer metadata in one query
  const metaRows = queryRows(
    dbPath,
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
  );

  const sessions: Session[] = [];

  for (const row of metaRows) {
    // SQLite default column separator is |
    const pipeIdx = row.indexOf("|");
    if (pipeIdx === -1) continue;
    const key = row.slice(0, pipeIdx);
    const value = row.slice(pipeIdx + 1);

    const meta = parseComposerMeta(value);
    if (!meta) continue;

    // 2. Load all bubbles for this composer
    const bubbleRows = queryRows(
      dbPath,
      `SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${meta.composerId}:%'`
    );

    if (bubbleRows.length === 0) continue;

    const bubbles: ParsedBubble[] = [];
    for (const bRow of bubbleRows) {
      const b = parseBubble(bRow);
      if (b) bubbles.push(b);
    }

    // 3. Pair user→assistant turns
    const messages: Message[] = [];
    let linesOfCode = 0;
    let i = 0;
    while (i < bubbles.length) {
      const cur = bubbles[i];
      if (cur.type === 1) {
        const next = i + 1 < bubbles.length && bubbles[i + 1].type === 2 ? bubbles[i + 1] : null;
        messages.push({
          prompt: cur.text,
          response: next?.text ?? "",
          model: meta.model,
        });
        linesOfCode += next?.linesAdded ?? 0;
        i += next ? 2 : 1;
      } else {
        i++;
      }
    }

    if (messages.length === 0) continue;

    // Prefer session-level line counts if available
    const totalLoc = (meta.totalLinesAdded ?? 0) > 0
      ? meta.totalLinesAdded!
      : linesOfCode;

    sessions.push({
      id: meta.composerId,
      title: meta.name || meta.subtitle || meta.composerId,
      source: "cursor",
      model: meta.model ?? "unknown",
      startedAt: meta.createdAt ? new Date(meta.createdAt) : undefined,
      endedAt: meta.lastUpdatedAt ? new Date(meta.lastUpdatedAt) : undefined,
      messages,
      linesOfCode: totalLoc,
      filePath: dbPath,
    });
  }

  return sessions;
}