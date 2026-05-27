---
title: "Supported Tools"
weight: 20
description: "AI coding tools that AI Engineer Coach can analyze"
---

# Supported Tools

AI Engineer Coach reads local log files from the following AI coding assistants. No network requests are made; all data stays on your machine.

## Local Agent (VS Code and VS Code Insiders)

The primary harness. AI Engineer Coach parses the chat panel logs that GitHub Copilot writes to the VS Code extension host log directory. This captures every request, response, model used, token counts, tool calls, file references, and terminal commands.

**What is tracked:**

- Requests and responses with timestamps
- Model selection (e.g., `claude-opus-4.6`, `gpt-5.4`, `auto`)
- Tool calls and slash commands used
- File context references (`#file`, open editor tabs)
- Terminal command execution
- Turn-by-turn conversation structure

## Claude

Parses session files from Anthropic's Claude CLI tool. Each session is read as a structured conversation with tool use, file edits, and terminal commands.

## Codex

Reads session history from OpenAI's Codex terminal agent. Captures prompts, completions, and tool interactions.

## OpenCode

Parses session logs from the open-source OpenCode terminal tool that supports multiple LLM backends.

OpenCode data is read from either of two storage layouts depending on the installed version:

| Layout               | Path                                  | OpenCode version |
| -------------------- | ------------------------------------- | ---------------- |
| **SQLite** (current) | `~/.local/share/opencode/opencode.db` | ≥ 0.1.x          |
| **Legacy JSON**      | `~/.local/share/opencode/storage/`    | < 0.1.x          |

On Windows both paths use `%USERPROFILE%\.local\share\opencode\`.
SQLite is preferred when both layouts are present.

**Troubleshooting — OpenCode sessions not appearing:**

1. Confirm the file exists: `ls ~/.local/share/opencode/opencode.db`
2. If the file is missing, check whether the legacy JSON storage directory exists:
   `ls ~/.local/share/opencode/storage/session/global/`
3. On Windows use `%USERPROFILE%\.local\share\opencode\` for the same paths.

## GitHub Copilot for Xcode

Reads Copilot Chat conversation logs from Apple's Xcode IDE. Sessions are parsed from SQLite databases stored in the GitHub Copilot configuration directory.

## GitHub Copilot CLI

Parses session state and history files from the GitHub Copilot CLI terminal agent. Captures prompts, completions, model usage, and per-model token metrics reported at session shutdown.

## Workspace Filtering

You can filter analytics to a single workspace or view aggregated data across all workspaces. The bottom-left panel in the UI provides workspace and harness selectors.
