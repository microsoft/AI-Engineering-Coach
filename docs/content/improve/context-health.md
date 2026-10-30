---
title: "Context Health"
weight: 30
description: "Evaluate context quality and window management"
---

# Context Health

The Context Health page has two tabs: **Context Quality** and **Context Management**. Together, they evaluate how well your workspaces are configured for AI-assisted development and how efficiently your coding sessions use the context window.

## Context Quality

![Context Quality](/screenshots/screen-context-quality.png)

The Context Quality tab assesses your workspace readiness for AI agents. It scores your setup across several dimensions:

### Agentic Readiness

Eight signals are checked to determine whether your projects are prepared for agentic AI workflows:

| Signal | What it checks |
|---|---|
| **Context Files** | Whether workspaces have `.github/copilot-instructions.md` or similar instruction files |
| **Custom Skills** | Whether any custom skill definitions exist |
| **Custom Agents** | Whether custom agent definitions are configured |
| **Prompt Templates** | Whether `.prompt.md` files are present |
| **Hooks (Pre/Post)** | Whether hook scripts are configured for automated workflows |
| **Dev Container** | Whether a `.devcontainer/devcontainer.json` exists for sandboxed execution |
| **MCP Servers** | Whether MCP server configurations are present |
| **Context Freshness** | Whether context files are up to date |

Each signal contributes points to the overall score.

### Context Provision by Harness

A table shows how context is provided across each harness (VS Code, Claude, etc.), including:

- Request count
- File reference percentage
- Instruction attachment rate
- Skills and tools usage percentage
- Average context per request

### Workspace Context Map

A treemap visualization where tile size represents request volume and tile color represents the instruction quality score. This lets you spot which workspaces get the most AI usage and which ones lack proper context configuration.

## Context Management

![Context Management](/screenshots/screen-context-management.png)

The Context Management tab analyzes how efficiently your coding sessions use the available context window.

### Key Metrics

- **Context Score** -- Overall efficiency rating (0-100)
- **Compactions** -- Number of times the context window was auto-compacted because it ran out of space

### Context Composition

![Context Composition](/screenshots/screen-context-composition.png)

Context Composition shows what fills your prompts, by category, for each harness that reports it. Use it to see whether tool definitions, instructions, or the conversation crowd your context window.

| Category | What it contains |
|---|---|
| **System instructions** | The built-in system prompt plus always-on instructions such as `copilot-instructions.md`, `AGENTS.md`, and memory |
| **Tool definitions** | The schema of every tool offered to the model, including MCP server tools. They're sent with every model call |
| **Messages** | Your prompts and the assistant's replies (VS Code) |
| **Tool results** | Output from tool calls, such as file reads, searches, and terminal output (VS Code) |
| **Files** | Attached files and editor context (VS Code) |
| **Conversation** | Messages, tool results, and files together. Copilot CLI doesn't split them |
| **Other / unattributed** | Categories a harness adds that aren't recognized yet, or tokens the harness didn't attribute |

The section shows:

- **Key figures** -- The share of prompt tokens spent on tool definitions, the share of requests whose prompt is at least half tool definitions, the average tool-definition tokens per Copilot CLI model call, and coverage (how many requests in the range carry composition data).
- **A 100% stacked bar per harness** -- Hover a segment to see its share and estimated tokens. Shares are weighted by prompt size, so larger prompts count more. If prompt sizes weren't recorded, every request counts equally and the section says so.
- **Tool-definition share by week** -- One line per harness, so you can check whether trimming tools is working.
- **By workspace** -- The workspaces with the most composition data. Select **Sessions** to see each session's composition, including Copilot CLI workspaces, which the per-workspace utilization table doesn't list because they lack per-request token counts.
- **Copilot CLI system prompt** -- Each system-prompt segment, such as `custom_instructions`, `memory`, and `tool_instructions`, with its size and how many sessions include it. Segments that add the most tokens overall come first.

Click a session in the per-workspace table to see its composition. For VS Code sessions, a per-request chart lines up with the token curve. For Copilot CLI sessions, the panel also lists the system-prompt segments from the latest checkpoint and the context when each compaction started, including tokens the CLI didn't attribute.

#### Where the data comes from

| Harness | Source | What you get |
|---|---|---|
| VS Code (Local Agent) | `promptTokenDetails` in chat session files | The share of each category for the last model call of every request. Token estimates use that call's prompt size. Older Copilot Chat builds don't record it |
| GitHub Copilot CLI and Copilot App | `session.usage_record`, `session.usage_checkpoint`, and `session.compaction_start` in `events.jsonl` | Tool-definition tokens for every main-agent model call, the system-prompt size from checkpoints, and the rest of the prompt as conversation. Sub-agent calls are left out. Older CLI builds don't record per-call usage |
| Claude Code, Codex, OpenCode, Xcode | Not reported | Shown as "Not reported by this harness". Nothing is estimated |

Only category names, segment names, and token counts are read. Prompt text, summaries, hashes, and tool schemas are never stored.

#### How to act on it

- **Tool definitions dominate** -- Turn off MCP servers and tools you don't use, or pick a smaller tool set, before you start a session. Every model call carries every tool definition, and changing tools mid-session breaks the prompt cache.
- **System instructions are large** -- Trim always-on instruction files and move task-specific guidance into prompt files or skills that load only when needed.
- **Tool results dominate** -- Ask for targeted reads (a file or line range instead of whole folders) and send broad searches to a subagent so only its summary comes back.
- **Conversation dominates** -- Start a new session between unrelated tasks, run `/compact` in Copilot CLI to continue a long one, and use subagents for exploration.

GitHub's [Optimizing your AI usage](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage) guide covers these practices under "Keep your context lean".

#### Caveats

- VS Code rounds each category to a whole percent, so shares can add up to 98-101%. Small rounding differences are rescaled; a larger shortfall shows as Other / unattributed.
- Copilot CLI's system-prompt size comes from the latest checkpoint and is applied to every call in a turn, so the split between system instructions and conversation is an estimate. Tool-definition tokens are counted per call.
- The tool-definition total in Copilot CLI's `session.shutdown` event isn't used, because it disagrees with the per-call counts.
- Shares describe what fills the prompt, not what you're billed. Cached tokens still take up room in the context window.

### Context Utilization Trend

A weekly chart showing average context utilization percentage and compaction events over time. High utilization with frequent compactions suggests you need shorter, more focused sessions.

### Per-Workspace Context Session Health

A detailed table with per-session breakdowns for each workspace:

| Column | Meaning |
|---|---|
| Score | Overall session health score |
| Verdict | Optimal, Degraded, or Critical |
| Avg Tokens | Average context window token count |
| Avg Util | Average context utilization percentage |
| Saturation | How close the window gets to its limit |
| Cost Eff. | Ratio of output to context consumed |
| Compactions | Number of auto-compaction events |

Click a workspace row to expand inline session-level details with per-session verdicts, token curves, prompt composition, and event counts.

### Insights

AI Engineer Coach generates context-specific recommendations when it detects issues. These appear in an Insights box above the charts. Examples:

- "Context is running high in some workspaces. Start new sessions before auto-compaction kicks in."
- "58 compaction events detected. Manually compact at natural breakpoints."
- "Tool definitions take 36% of your VS Code prompts and at least half of the prompt in 24% of requests. Turn off MCP servers and tools you don't need..."
