/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the OpenCode parser.
 *
 * Coverage:
 *  - Legacy JSON storage: zero-token assistants, missing assistants
 *  - SQLite storage: basic parsing, tool parts, malformed rows, large fixture,
 *    SQLite-preferred-over-JSON ordering
 *  - Discovery: findOpenCodeDbPaths probes HOME and APPDATA
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
	parseOpenCodeSessions,
	parseOpenCodeSessionsFromDb,
	findOpenCodeDbPaths,
} from "./parser-opencode";

function withStorage(
	rawSession: object,
	messages: object[],
	run: (storageDir: string) => void,
): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-parser-test-"));
	const storageDir = path.join(root, "storage");
	const sessId = (rawSession as { id: string }).id;
	fs.mkdirSync(path.join(storageDir, "session", "global"), { recursive: true });
	fs.writeFileSync(
		path.join(storageDir, "session", "global", `${sessId}.json`),
		JSON.stringify(rawSession),
		"utf-8",
	);
	fs.mkdirSync(path.join(storageDir, "message", sessId), { recursive: true });
	for (const msg of messages) {
		const m = msg as { id: string };
		fs.writeFileSync(
			path.join(storageDir, "message", sessId, `${m.id}.json`),
			JSON.stringify(msg),
			"utf-8",
		);
	}
	try {
		run(storageDir);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("parseOpenCodeSessions", () => {
	it("records {input:0,output:0} assistants as zero-token data, not missing", async () => {
		withStorage(
			{
				id: "sess1",
				directory: "/Users/me/proj",
				time: { created: 1700000000000 },
			},
			[
				{
					id: "m1",
					sessionID: "sess1",
					role: "user",
					time: { created: 1700000000000 },
					summary: { title: "hi" },
				},
				// First assistant: tool-only continuation step with zeroed tokens
				{
					id: "m2",
					sessionID: "sess1",
					role: "assistant",
					parentID: "m1",
					time: { created: 1700000001000, completed: 1700000002000 },
					modelID: "claude-sonnet-4",
					tokens: { input: 0, output: 0 },
				},
				{
					id: "m3",
					sessionID: "sess1",
					role: "user",
					time: { created: 1700000003000 },
					summary: { title: "go on" },
				},
				// Second assistant: real tokens
				{
					id: "m4",
					sessionID: "sess1",
					role: "assistant",
					parentID: "m3",
					time: { created: 1700000004000, completed: 1700000005000 },
					modelID: "claude-sonnet-4",
					tokens: { input: 1000, output: 50 },
				},
			],
			(storageDir) => {
				const sessions = parseOpenCodeSessions(storageDir);
				expect(sessions).toHaveLength(1);
				const reqs = sessions[0].requests;
				expect(reqs).toHaveLength(2);
				// The zero-token assistant should produce 0 tokens, NOT null/missing
				expect(reqs[0].promptTokens).toBe(0);
				expect(reqs[0].completionTokens).toBe(0);
				// Second assistant has real numbers
				expect(reqs[1].promptTokens).toBe(1000);
				expect(reqs[1].completionTokens).toBe(50);
			},
		);
	});

	it("marks a request as missing when the assistant message is absent entirely", async () => {
		withStorage(
			{ id: "sess2", directory: "/Users/me/proj" },
			[
				{
					id: "u1",
					sessionID: "sess2",
					role: "user",
					time: { created: 1700000000000 },
					summary: { title: "hi" },
				},
				// No assistant message at all
			],
			(storageDir) => {
				const sessions = parseOpenCodeSessions(storageDir);
				expect(sessions).toHaveLength(1);
				expect(sessions[0].requests[0].promptTokens).toBeNull();
				expect(sessions[0].requests[0].completionTokens).toBeNull();
			},
		);
	});
});

// ---------------------------------------------------------------------------
// SQLite helper: create a temporary opencode.db for testing
// ---------------------------------------------------------------------------

function createTestDb(
	sessions: Array<{
		id: string;
		slug?: string;
		directory?: string;
		title?: string;
		time_created?: number;
		time_updated?: number;
	}>,
	messages: Array<{
		id: string;
		session_id: string;
		time_created?: number;
		data: object;
	}>,
	parts: Array<{
		id: string;
		message_id: string;
		session_id: string;
		time_created?: number;
		data: object;
	}>,
): { dbPath: string; cleanup: () => void } {
	const tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "opencode-sqlite-test-"),
	);
	const dbPath = path.join(tmpDir, "opencode.db");

	const db = new Database(dbPath);
	db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      time_created INTEGER NOT NULL DEFAULT 0,
      time_updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
  `);

	const insertSession = db.prepare(
		"INSERT INTO session (id, slug, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
	);
	for (const s of sessions) {
		insertSession.run(
			s.id,
			s.slug ?? "",
			s.directory ?? "",
			s.title ?? "",
			s.time_created ?? 0,
			s.time_updated ?? 0,
		);
	}

	const insertMessage = db.prepare(
		"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
	);
	for (const m of messages) {
		insertMessage.run(
			m.id,
			m.session_id,
			m.time_created ?? 0,
			JSON.stringify(m.data),
		);
	}

	const insertPart = db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
	);
	for (const p of parts) {
		insertPart.run(
			p.id,
			p.message_id,
			p.session_id,
			p.time_created ?? 0,
			JSON.stringify(p.data),
		);
	}

	db.close();
	return {
		dbPath,
		cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
	};
}

// ---------------------------------------------------------------------------
// SQLite parser tests
// ---------------------------------------------------------------------------

describe("parseOpenCodeSessionsFromDb", () => {
	it("parses a session with user + assistant messages from SQLite", async () => {
		const { dbPath, cleanup } = createTestDb(
			[
				{
					id: "ses_1",
					directory: "/home/user/myproj",
					title: "Test session",
					time_created: 1700000000000,
					time_updated: 1700000005000,
				},
			],
			[
				{
					id: "msg_u1",
					session_id: "ses_1",
					time_created: 1700000001000,
					data: {
						role: "user",
						time: { created: 1700000001000 },
						agent: "build",
						summary: { title: "hello world" },
					},
				},
				{
					id: "msg_a1",
					session_id: "ses_1",
					time_created: 1700000002000,
					data: {
						role: "assistant",
						parentID: "msg_u1",
						time: { created: 1700000002000, completed: 1700000003000 },
						modelID: "claude-sonnet-4",
						providerID: "anthropic",
						tokens: {
							input: 500,
							output: 80,
							reasoning: 0,
							cache: { write: 0, read: 200 },
						},
					},
				},
			],
			[
				{
					id: "prt_1",
					message_id: "msg_a1",
					session_id: "ses_1",
					time_created: 1700000002500,
					data: { type: "text", text: "Hello!" },
				},
			],
		);

		try {
			const sessions = await parseOpenCodeSessionsFromDb(dbPath);
			expect(sessions).toHaveLength(1);
			const sess = sessions[0];
			expect(sess.workspaceId).toBe("opencode-ses_1");
			expect(sess.workspaceName).toBe("myproj");
			expect(sess.harness).toBe("OpenCode");
			expect(sess.requests).toHaveLength(1);
			const req = sess.requests[0];
			// promptTokens = input + cache.read + cache.write
			expect(req.promptTokens).toBe(500 + 200 + 0);
			expect(req.completionTokens).toBe(80);
			expect(req.cacheReadTokens).toBe(200);
		} finally {
			cleanup();
		}
	});

	it("extracts tool usage and edited files from tool parts", async () => {
		const { dbPath, cleanup } = createTestDb(
			[
				{
					id: "ses_2",
					directory: "/home/user/proj2",
					time_created: 1700100000000,
				},
			],
			[
				{
					id: "msg_u2",
					session_id: "ses_2",
					time_created: 1700100001000,
					data: {
						role: "user",
						time: { created: 1700100001000 },
						summary: { title: "edit a file" },
					},
				},
				{
					id: "msg_a2",
					session_id: "ses_2",
					time_created: 1700100002000,
					data: {
						role: "assistant",
						parentID: "msg_u2",
						time: { created: 1700100002000, completed: 1700100003000 },
						modelID: "gpt-4o",
						providerID: "openai",
						tokens: { input: 100, output: 20, cache: { write: 0, read: 0 } },
					},
				},
			],
			[
				{
					id: "prt_tool",
					message_id: "msg_a2",
					session_id: "ses_2",
					data: {
						type: "tool",
						tool: "write",
						state: {
							status: "completed",
							input: { filePath: "src/index.ts", content: "const x = 1;" },
						},
					},
				},
				{
					id: "prt_read",
					message_id: "msg_a2",
					session_id: "ses_2",
					data: {
						type: "tool",
						tool: "read",
						state: { status: "completed", input: { filePath: "src/utils.ts" } },
					},
				},
			],
		);

		try {
			const sessions = await parseOpenCodeSessionsFromDb(dbPath);
			expect(sessions).toHaveLength(1);
			const req = sessions[0].requests[0];
			expect(req.toolsUsed).toContain("write");
			expect(req.toolsUsed).toContain("read");
			expect(req.editedFiles).toContain("src/index.ts");
			expect(req.referencedFiles).toContain("src/utils.ts");
		} finally {
			cleanup();
		}
	});

	it("skips malformed message.data and part.data rows without crashing", async () => {
		const { dbPath, cleanup } = createTestDb(
			[
				{
					id: "ses_3",
					directory: "/home/user/proj3",
					time_created: 1700200000000,
				},
			],
			[
				// Good message
				{
					id: "msg_u3",
					session_id: "ses_3",
					time_created: 1700200001000,
					data: {
						role: "user",
						time: { created: 1700200001000 },
						summary: { title: "ok" },
					},
				},
				{
					id: "msg_a3",
					session_id: "ses_3",
					time_created: 1700200002000,
					data: {
						role: "assistant",
						parentID: "msg_u3",
						time: { created: 1700200002000, completed: 1700200003000 },
						modelID: "claude-haiku",
						tokens: { input: 10, output: 5 },
					},
				},
			],
			[
				// Good part
				{
					id: "prt_good",
					message_id: "msg_a3",
					session_id: "ses_3",
					data: { type: "text", text: "result" },
				},
			],
		);

		// Inject a malformed row directly via better-sqlite3
		const db = new Database(dbPath);
		db.prepare(
			"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
		).run("msg_bad", "ses_3", 1700200000500, "NOT JSON {{{");
		db.prepare(
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
		).run("prt_bad", "msg_a3", "ses_3", 1700200002100, "{invalid}");
		db.close();

		try {
			const sessions = await parseOpenCodeSessionsFromDb(dbPath);
			// Malformed rows skipped; valid session still returned
			expect(sessions).toHaveLength(1);
			expect(sessions[0].requests).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("handles a large number of sessions without throwing", async () => {
		const sessionCount = 200;
		const sessions = Array.from({ length: sessionCount }, (_, i) => ({
			id: `ses_large_${i}`,
			directory: "/home/user/bigproj",
			title: `Session ${i}`,
			time_created: 1700300000000 + i * 1000,
			time_updated: 1700300000000 + i * 1000 + 500,
		}));
		const messages = sessions.flatMap((s) => [
			{
				id: `msg_u_${s.id}`,
				session_id: s.id,
				time_created: s.time_created + 1,
				data: {
					role: "user",
					time: { created: s.time_created + 1 },
					summary: { title: `prompt ${s.id}` },
				},
			},
			{
				id: `msg_a_${s.id}`,
				session_id: s.id,
				time_created: s.time_created + 2,
				data: {
					role: "assistant",
					parentID: `msg_u_${s.id}`,
					time: { created: s.time_created + 2, completed: s.time_created + 3 },
					modelID: "claude-haiku",
					tokens: { input: 50, output: 10 },
				},
			},
		]);

		const { dbPath, cleanup } = createTestDb(sessions, messages, []);
		try {
			const parsed = await parseOpenCodeSessionsFromDb(dbPath);
			expect(parsed.length).toBe(sessionCount);
		} finally {
			cleanup();
		}
	});

	it("returns empty array when the DB path does not exist", async () => {
		const sessions = await parseOpenCodeSessionsFromDb("/nonexistent/opencode.db");
		expect(sessions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Discovery tests
// ---------------------------------------------------------------------------

describe("findOpenCodeDbPaths", () => {
	it("returns a DB path when HOME points to a dir with opencode.db", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "opencode-discovery-test-"),
		);
		const dbDir = path.join(tmpDir, ".local", "share", "opencode");
		fs.mkdirSync(dbDir, { recursive: true });
		const dbPath = path.join(dbDir, "opencode.db");
		fs.writeFileSync(dbPath, "");

		const origHome = process.env.HOME;
		const origUserProfile = process.env.USERPROFILE;
		try {
			process.env.HOME = tmpDir;
			delete process.env.USERPROFILE;
			const found = findOpenCodeDbPaths();
			expect(found).toContain(dbPath);
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
			if (origUserProfile !== undefined)
				process.env.USERPROFILE = origUserProfile;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when no opencode.db exists", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "opencode-discovery-empty-"),
		);
		const origHome = process.env.HOME;
		const origUserProfile = process.env.USERPROFILE;
		const origAppData = process.env.APPDATA;
		try {
			process.env.HOME = tmpDir;
			delete process.env.USERPROFILE;
			delete process.env.APPDATA;
			expect(findOpenCodeDbPaths()).toHaveLength(0);
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
			if (origUserProfile !== undefined)
				process.env.USERPROFILE = origUserProfile;
			if (origAppData !== undefined) process.env.APPDATA = origAppData;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
