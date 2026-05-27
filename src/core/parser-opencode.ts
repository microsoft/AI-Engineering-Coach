/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode session parser
 *
 * Supports two storage layouts:
 *
 * 1. SQLite (current — opencode ≥ 0.1.x):
 *      ~/.local/share/opencode/opencode.db
 *      Windows: %USERPROFILE%\.local\share\opencode\opencode.db
 *                %APPDATA%\opencode\opencode.db  (legacy Windows fallback)
 *
 *    Tables: session, message (data JSON blob), part (data JSON blob)
 *
 * 2. Legacy JSON files (opencode < 0.1.x):
 *   ~/.local/share/opencode/storage/session/global/<session-id>.json
 *   ~/.local/share/opencode/storage/message/<session-id>/<msg-id>.json
 *   ~/.local/share/opencode/storage/part/<msg-id>/<part-id>.json
 *
 * Discovery order: SQLite DB preferred; JSON storage used as fallback.
 *
 * Sessions have: id, slug, version, projectID, directory, title, time.created/updated
 * Messages have: id, sessionID, role (user|assistant), time, agent, model {providerID, modelID}, tokens, cost
 * Parts have: id, sessionID, messageID, type (text|tool|step-start|step-finish), text, tool, callID, state, tokens, cost
 */

import * as fs from "fs";
import * as path from "path";
import { Session, SessionRequest } from "./types";
import {
	assertTrustedPath,
	createRequest,
	createSession,
	detectDevcontainerFromRequests,
} from "./parser-shared";
import {
	canonicalizeReasoningEffort,
	extractReasoningEffortFromModelId,
} from "./helpers";

interface OcSession {
	id: string;
	slug?: string;
	version?: string;
	projectID?: string;
	directory?: string;
	title?: string;
	time?: { created?: number; updated?: number };
}

interface OcMessage {
	id: string;
	sessionID: string;
	role: string;
	time?: { created?: number; completed?: number };
	parentID?: string;
	modelID?: string;
	providerID?: string;
	mode?: string;
	agent?: string;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: { read?: number; write?: number };
	};
	finish?: string;
	summary?: { title?: string; diffs?: unknown[] };
	variant?: string;
	model?: { providerID?: string; modelID?: string };
}

interface OcPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	text?: string;
	tool?: string;
	callID?: string;
	state?: { status?: string; input?: Record<string, unknown>; output?: string };
	tokens?: { input?: number; output?: number; reasoning?: number };
	cost?: number;
	reason?: string;
}

interface OpenCodeAssistantData {
	responseText: string;
	toolsUsed: string[];
	editedFiles: string[];
	referencedFiles: string[];
	modelId: string;
	totalElapsed: number | null;
	lastTs: number | null;
	tokenSource: OcMessage["tokens"] | null;
}

const WRITE_TOOLS = new Set(["write", "edit", "create", "patch"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "find"]);

export function findOpenCodeDirs(): string[] {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const dirs: string[] = [];

	// macOS / Linux / Windows (%USERPROFILE%\.local\share\opencode\storage)
	const linuxPath = path.join(home, ".local", "share", "opencode", "storage");
	if (fs.existsSync(linuxPath)) dirs.push(linuxPath);

	return dirs;
}

/**
 * Returns paths to opencode.db SQLite files found on the current machine.
 * macOS/Linux: ~/.local/share/opencode/opencode.db
 * Windows:     %USERPROFILE%\.local\share\opencode\opencode.db
 *              %APPDATA%\opencode\opencode.db  (legacy Windows fallback)
 */
export function findOpenCodeDbPaths(): string[] {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const found: string[] = [];

	if (home) {
		const dbPath = path.join(
			home,
			".local",
			"share",
			"opencode",
			"opencode.db",
		);
		if (fs.existsSync(dbPath)) found.push(dbPath);
	}

	// Windows fallback: older OpenCode docs referenced %APPDATA%\opencode
	const appData = process.env.APPDATA || "";
	if (appData) {
		const dbPath = path.join(appData, "opencode", "opencode.db");
		if (fs.existsSync(dbPath) && !found.includes(dbPath)) found.push(dbPath);
	}

	return found;
}

// ---------------------------------------------------------------------------
// SQLite access — async interface
//
// Priority order:
//  1. node:sqlite     — built-in since Node 22.5 / stable in Node 23+.
//                       No packaging, no ABI concerns. Works wherever Node
//                       24+ runs (system Node and VS Code’s Electron from
//                       1.121+ which ships Electron 37+ / Node 24).
//  2. @vscode/sqlite3 — compiled for VS Code’s Electron; async callback API.
//                       Fallback for VS Code versions with older Electron.
//  3. better-sqlite3  — compiled for system Node; works in Vitest/dev but
//                       NOT in VS Code’s Electron child process.
// ---------------------------------------------------------------------------

/** Minimal async handle returned by tryOpenSqliteDbAsync. */
interface AsyncSqliteHandle {
	all(sql: string, params: unknown[]): Promise<unknown[]>;
	close(): void | Promise<void>;
}

async function tryOpenSqliteDbAsync(
	dbPath: string,
): Promise<AsyncSqliteHandle | null> {
	try {
		assertTrustedPath(dbPath);
	} catch {
		return null;
	}

	// ── 1. node:sqlite (built-in, no ABI concerns) ──────────────────────────
	try {
		type NodeSqliteModule = {
			DatabaseSync: new (path: string) => {
				prepare(sql: string): { all(...params: unknown[]): unknown[] };
				close(): void;
			};
		};
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { DatabaseSync } = require('node:sqlite') as NodeSqliteModule;
		const db = new DatabaseSync(dbPath);
		return {
			all(sql: string, params: unknown[]) {
				return Promise.resolve(db.prepare(sql).all(...params));
			},
			close() { db.close(); },
		};
	} catch { /* fall through */ }

	// ── 2. @vscode/sqlite3 (VS Code’s Electron, async callback) ──────────────
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
		const mod = require('@vscode/sqlite3');
		return await new Promise<AsyncSqliteHandle | null>((resolve) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			const raw = new mod.Database(
				dbPath,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				mod.OPEN_READONLY as number,
				(err: Error | null) => {
					if (err) { resolve(null); return; }
					resolve({
						all(sql: string, params: unknown[]) {
							return new Promise<unknown[]>((res, rej) => {
								// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
								raw.all(sql, params, (e: Error | null, rows: unknown[]) => {
									if (e) rej(e); else res(rows ?? []);
								});
							});
						},
						close() {
							return new Promise<void>((res) => {
								// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
								raw.close(() => res());
							});
						},
					});
				},
			);
		});
	} catch { /* fall through */ }

	// ── 2. better-sqlite3 fallback (system Node / Vitest) ────────────────────
	try {
		type B3Ctor = new (
			p: string,
			o: { readonly: boolean; fileMustExist: boolean },
		) => {
			prepare(s: string): { all(...a: unknown[]): unknown[] };
			close(): void;
		};
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const Database = require("better-sqlite3") as B3Ctor;
		const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
		return {
			all(sql: string, params: unknown[]) {
				return Promise.resolve(raw.prepare(sql).all(...params));
			},
			close() {
				raw.close();
			},
		};
	} catch {
		return null;
	}
}

interface SqliteSessionRow {
	id: string;
	slug: string;
	directory: string;
	title: string;
	time_created: number;
	time_updated: number;
}

interface SqliteMessageRow {
	id: string;
	session_id: string;
	data: string;
}

interface SqlitePartRow {
	id: string;
	message_id: string;
	data: string;
}

function parseJsonBlob<T>(blob: string): T | null {
	try {
		return JSON.parse(blob) as T;
	} catch {
		return null;
	}
}

/**
 * Parse all OpenCode sessions from an opencode.db SQLite file.
 * Uses @vscode/sqlite3 first (VS Code's Electron-compatible build), with
 * better-sqlite3 as fallback for system Node / test environments.
 * Returns an empty array if the DB cannot be opened or contains no data.
 */
export async function parseOpenCodeSessionsFromDb(
	dbPath: string,
): Promise<Session[]> {
	const db = await tryOpenSqliteDbAsync(dbPath);
	if (!db) return [];

	try {
		const sessions = (await db.all(
			"SELECT id, slug, directory, title, time_created, time_updated FROM session",
			[],
		)) as SqliteSessionRow[];

		const results: Session[] = [];
		for (const rawSession of sessions) {
			const rawMessages = (await db.all(
				"SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
				[rawSession.id],
			)) as SqliteMessageRow[];
			if (rawMessages.length === 0) continue;

			const rawParts = (await db.all(
				"SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC",
				[rawSession.id],
			)) as SqlitePartRow[];

			const session = parseSessionFromSqliteRows(
				rawSession,
				rawMessages,
				rawParts,
			);
			if (session) results.push(session);
		}
		return results;
	} catch {
		return [];
	} finally {
		await db.close();
	}
}

function parseSessionFromSqliteRows(
	rawSession: SqliteSessionRow,
	rawMessageRows: SqliteMessageRow[],
	rawPartRows: SqlitePartRow[],
): Session | null {
	// Parse message JSON blobs; skip malformed rows
	const messages: OcMessage[] = [];
	for (const row of rawMessageRows) {
		const data = parseJsonBlob<OcMessage>(row.data);
		if (!data) continue;
		data.id = row.id;
		data.sessionID = row.session_id;
		messages.push(data);
	}
	if (messages.length === 0) return null;

	// Build parts map by message ID; skip malformed rows
	const partsByMsg = new Map<string, OcPart[]>();
	for (const row of rawPartRows) {
		const data = parseJsonBlob<OcPart>(row.data);
		if (!data) continue;
		data.id = row.id;
		data.messageID = row.message_id;
		const existing = partsByMsg.get(row.message_id);
		if (existing) existing.push(data);
		else partsByMsg.set(row.message_id, [data]);
	}

	const ocSession: OcSession = {
		id: rawSession.id,
		slug: rawSession.slug,
		directory: rawSession.directory,
		title: rawSession.title,
		time: {
			created: rawSession.time_created,
			updated: rawSession.time_updated,
		},
	};

	return buildSessionFromMessages(ocSession, messages, partsByMsg);
}

function readJsonSafe<T>(filePath: string): T | null {
	try {
		assertTrustedPath(filePath);
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

function readAllJsonInDir<T>(dir: string): T[] {
	const results: T[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isFile() || !e.name.endsWith(".json")) continue;
			const data = readJsonSafe<T>(path.join(dir, e.name));
			if (data) results.push(data);
		}
	} catch {
		/* skip unreadable dirs */
	}
	return results;
}

function projectNameFromDir(directory: string): string {
	return (
		directory.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() ||
		"unknown"
	);
}

function getOpenCodeUserText(
	msg: OcMessage,
	partsByMsg: Map<string, OcPart[]>,
): string {
	const userParts = partsByMsg.get(msg.id) || [];
	const userTextFromParts = userParts
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text!)
		.join("\n");
	return userTextFromParts || msg.summary?.title || "";
}

function findAssistantMessage(
	messages: OcMessage[],
	startIndex: number,
	parentId: string,
): OcMessage | null {
	for (let i = startIndex; i < messages.length; i++) {
		const candidate = messages[i];
		if (candidate.role === "assistant" && candidate.parentID === parentId)
			return candidate;
	}

	const next = messages[startIndex];
	return next?.role === "assistant" ? next : null;
}

function applyOpenCodePart(
	part: OcPart,
	data: Pick<
		OpenCodeAssistantData,
		"toolsUsed" | "editedFiles" | "referencedFiles"
	>,
	textParts: string[],
): void {
	if (part.type === "text" && part.text) {
		textParts.push(part.text);
		return;
	}

	if (part.type !== "tool" || !part.tool) return;

	data.toolsUsed.push(part.tool);
	const input = part.state?.input || {};
	const filePath =
		typeof input.filePath === "string"
			? input.filePath
			: typeof input.file_path === "string"
				? input.file_path
				: typeof input.path === "string"
					? input.path
					: null;
	if (!filePath) return;

	const toolLower = part.tool.toLowerCase();
	if (WRITE_TOOLS.has(toolLower)) {
		data.editedFiles.push(filePath);
		// Include generated code content so extractCodeBlocks() can detect AI-produced code.
		// Write tools store the code in various input fields; also check state.output.
		const content =
			typeof input.content === "string"
				? input.content
				: typeof input.code === "string"
					? input.code
					: typeof input.new_string === "string"
						? input.new_string
						: typeof part.state?.output === "string"
							? part.state.output
							: null;
		if (content) {
			const ext = filePath.split(".").pop() || "unknown";
			textParts.push(`\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
		}
	} else if (READ_TOOLS.has(toolLower)) {
		data.referencedFiles.push(filePath);
	}
}

function collectAssistantData(
	assistantMsg: OcMessage | null,
	partsByMsg: Map<string, OcPart[]>,
	userTs: number | null,
	lastTs: number | null,
): OpenCodeAssistantData {
	const data: OpenCodeAssistantData = {
		responseText: "",
		toolsUsed: [],
		editedFiles: [],
		referencedFiles: [],
		modelId: "",
		totalElapsed: null,
		lastTs,
		tokenSource: null,
	};
	if (!assistantMsg) return data;

	const assistantTs =
		assistantMsg.time?.completed || assistantMsg.time?.created || null;
	if (assistantTs && (!data.lastTs || assistantTs > data.lastTs))
		data.lastTs = assistantTs;
	if (userTs && assistantTs) data.totalElapsed = assistantTs - userTs;

	data.modelId = assistantMsg.modelID || "";
	data.tokenSource = assistantMsg.tokens ?? null;

	const textParts: string[] = [];
	const parts = partsByMsg.get(assistantMsg.id) || [];
	for (const part of parts) {
		applyOpenCodePart(part, data, textParts);
	}
	data.responseText = textParts.join("\n");

	return data;
}

function indexPartsByMessage(
	rawMessages: OcMessage[],
	storageDir: string,
): Map<string, OcPart[]> {
	const partsByMsg = new Map<string, OcPart[]>();
	for (const msg of rawMessages) {
		const partDir = path.join(storageDir, "part", msg.id);
		const parts = readAllJsonInDir<OcPart>(partDir);
		if (parts.length > 0) partsByMsg.set(msg.id, parts);
	}
	return partsByMsg;
}

function getOpenCodeWorkspace(rawSession: OcSession): {
	wsId: string;
	wsName: string;
} {
	return {
		wsId: `opencode-${rawSession.id}`,
		wsName: rawSession.directory
			? projectNameFromDir(rawSession.directory)
			: rawSession.title || rawSession.slug || "unknown",
	};
}

function buildOpenCodeRequest(
	msg: OcMessage,
	partsByMsg: Map<string, OcPart[]>,
	assistantData: OpenCodeAssistantData,
	userTs: number | null,
): SessionRequest {
	const cacheRead = assistantData.tokenSource?.cache?.read ?? 0;
	const cacheWrite = assistantData.tokenSource?.cache?.write ?? 0;
	const hasTokenData = assistantData.tokenSource != null;
	return createRequest({
		requestId: msg.id,
		timestamp: userTs,
		messageText: getOpenCodeUserText(msg, partsByMsg),
		responseText: assistantData.responseText,
		agentName: msg.agent || "OpenCode",
		agentMode: msg.agent || "build",
		modelId: assistantData.modelId,
		toolsUsed: assistantData.toolsUsed,
		editedFiles: [...new Set(assistantData.editedFiles)],
		referencedFiles: [...new Set(assistantData.referencedFiles)],
		totalElapsed: assistantData.totalElapsed,
		// promptTokens = total input context (uncached input + cache read + cache write)
		// so that context-window analysis sees the full context. Cached portions
		// are tracked separately for billing.
		promptTokens: hasTokenData
			? (assistantData.tokenSource?.input ?? 0) + cacheRead + cacheWrite
			: null,
		completionTokens: hasTokenData
			? (assistantData.tokenSource?.output ?? 0)
			: null,
		cacheReadTokens: cacheRead > 0 ? cacheRead : null,
		cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
		// OpenCode stores reasoning effort as "variant" on user messages
		reasoningEffort:
			canonicalizeReasoningEffort(msg.variant) ??
			extractReasoningEffortFromModelId(assistantData.modelId),
	});
}

/**
 * Shared session-building logic used by both the legacy JSON parser and the
 * SQLite parser. Takes a normalized OcSession + sorted OcMessage array + parts
 * map and produces a Session (or null when there are no requests).
 */
function buildSessionFromMessages(
	rawSession: OcSession,
	messages: OcMessage[],
	partsByMsg: Map<string, OcPart[]>,
): Session | null {
	const { wsId, wsName } = getOpenCodeWorkspace(rawSession);
	const requests: SessionRequest[] = [];
	let firstTs: number | null = null;
	let lastTs: number | null = null;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user") continue;

		const userTs = msg.time?.created || null;
		if (userTs && (!firstTs || userTs < firstTs)) firstTs = userTs;

		const assistantMsg = findAssistantMessage(messages, i + 1, msg.id);
		const assistantData = collectAssistantData(
			assistantMsg,
			partsByMsg,
			userTs,
			lastTs,
		);
		lastTs = assistantData.lastTs;
		requests.push(buildOpenCodeRequest(msg, partsByMsg, assistantData, userTs));
	}

	if (requests.length === 0) return null;

	return createSession({
		sessionId: rawSession.id,
		workspaceId: wsId,
		workspaceName: wsName,
		location: "terminal",
		harness: "OpenCode",
		creationDate: firstTs || rawSession.time?.created || null,
		lastMessageDate: lastTs || rawSession.time?.updated || null,
		requests,
		hasDevcontainer: detectDevcontainerFromRequests(
			requests,
			rawSession.directory,
		),
	});
}

function parseOpenCodeSession(
	rawSession: OcSession,
	storageDir: string,
): Session | null {
	if (!rawSession.id) return null;

	const msgDir = path.join(storageDir, "message", rawSession.id);
	const rawMessages = readAllJsonInDir<OcMessage>(msgDir);
	rawMessages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
	if (rawMessages.length === 0) return null;

	const partsByMsg = indexPartsByMessage(rawMessages, storageDir);
	return buildSessionFromMessages(rawSession, rawMessages, partsByMsg);
}

export function parseOpenCodeSessions(storageDir: string): Session[] {
	const sessions: Session[] = [];
	const sessionDir = path.join(storageDir, "session", "global");
	const rawSessions = readAllJsonInDir<OcSession>(sessionDir);

	for (const rawSession of rawSessions) {
		const session = parseOpenCodeSession(rawSession, storageDir);
		if (session) sessions.push(session);
	}

	return sessions;
}
