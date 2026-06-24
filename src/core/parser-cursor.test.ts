import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as cp from "child_process";

vi.mock("fs");
vi.mock("child_process");

// Must mock before importing the module under test
const mockExecSync = vi.mocked(cp.execSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);

describe("parseCursorSessions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Simulate a valid storage root
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    mockReaddirSync.mockReturnValue(["abc123"] as unknown as fs.Dirent[]);
    mockExistsSync.mockReturnValue(true);
  });

  it("parses a session with user+assistant bubbles", async () => {
    const composerMeta = JSON.stringify({
      composerId: "comp-1",
      name: "My Session",
      createdAt: 1700000000000,
      lastUpdatedAt: 1700001000000,
      selectedModel: "claude-3-5-sonnet",
    });
    const userBubble = JSON.stringify({ bubbleId: "b1", type: 1, text: "Hello?" });
    const aiBubble = JSON.stringify({ bubbleId: "b2", type: 2, text: "Hi there!", timingMs: 800, codeBlocks: [] });

    mockExecSync
      .mockReturnValueOnce(`composerData:comp-1\x1f${composerMeta}\n` as unknown as Buffer)
      .mockReturnValueOnce(`bubbleId:comp-1:b1\x1f${userBubble}\nbubbleId:comp-1:b2\x1f${aiBubble}\n` as unknown as Buffer);

    const { parseCursorSessions } = await import("./parser-cursor.js");
    const sessions = await parseCursorSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("cursor");
    expect(sessions[0].model).toBe("claude-3-5-sonnet");
    expect(sessions[0].messages).toHaveLength(1);
    expect(sessions[0].messages[0].prompt).toBe("Hello?");
    expect(sessions[0].messages[0].response).toBe("Hi there!");
    expect(sessions[0].messages[0].durationMs).toBe(800);
  });

  it("returns empty array when no databases found", async () => {
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const { parseCursorSessions } = await import("./parser-cursor.js");
    const sessions = await parseCursorSessions();
    expect(sessions).toHaveLength(0);
  });

  it("skips composers with no bubbles", async () => {
    const composerMeta = JSON.stringify({ composerId: "comp-empty", name: "Empty" });
    mockExecSync
      .mockReturnValueOnce(`composerData:comp-empty\x1f${composerMeta}\n` as unknown as Buffer)
      .mockReturnValueOnce("" as unknown as Buffer);

    const { parseCursorSessions } = await import("./parser-cursor.js");
    const sessions = await parseCursorSessions();
    expect(sessions).toHaveLength(0);
  });

  it("returns empty array when sqlite3 is not available", async () => {
    const composerMeta = JSON.stringify({ composerId: "comp-1", name: "Test" });
    mockExecSync
      .mockReturnValueOnce(`composerData:comp-1\x1f${composerMeta}\n` as unknown as Buffer)
      .mockImplementationOnce(() => { throw new Error("sqlite3: command not found"); });

    const { parseCursorSessions } = await import("./parser-cursor.js");
    const sessions = await parseCursorSessions();
    expect(sessions).toHaveLength(0);
  });
});