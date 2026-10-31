---
title: "Context Health"
weight: 30
description: "Evaluate context quality, window management, and prompt caching"
---

# Context Health

The Context Health page has three tabs: **Context Quality**, **Context Management**, and **Prompt Cache**. Together, they evaluate how well your workspaces are configured for AI-assisted development, how efficiently your coding sessions use the context window, and how much of that context the model reuses from its cache.

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

- **Key figures** -- Shown separately for VS Code and for Copilot CLI and the Copilot App: the share of prompt tokens spent on tool definitions, the share of VS Code requests whose prompt is at least half tool definitions, the average tool-definition tokens per Copilot CLI model call, and coverage (how many requests in the range carry composition data).
- **A 100% stacked bar per harness** -- Hover a segment to see its share and estimated tokens. Shares are weighted by prompt tokens, so larger prompts count more. A Copilot CLI turn counts each of its model calls, and its averages are per call. Requests that didn't record a prompt size are left out of token-weighted figures, and the tooltips say how many. A bar whose requests recorded no prompt size counts every request equally and is marked **equal weight**.
- **Tool-definition share by week** -- One line per harness, so you can check whether trimming tools is working.
- **By workspace** -- The workspaces with the most composition data. A workspace you use from both VS Code and Copilot CLI gets one row for each. Select **Sessions** to see each session's composition, including Copilot CLI workspaces, which the per-workspace utilization table doesn't list because they lack per-request token counts. The list includes every session with a request in the range, even one that continues past it.
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

- VS Code records composition only for the last model call of each request, while Copilot CLI records every main-agent call. Pooled together, Copilot CLI would dominate every figure, so the two are never combined: key figures and workspace rows are shown for each separately.
- Composition counts the requests sent in the selected range, while context utilization counts sessions by their last activity. A session that continues past the end of the range adds composition but no utilization. If no session's last activity falls in the range, the tab shows only Context Composition.
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

## Prompt Cache

![Prompt Cache](/screenshots/screen-prompt-cache.png)

Agents resend the same context on every model call: the system prompt, tool definitions, and the conversation so far. The prompt cache lets the model reuse the part it has already seen, billed at a fraction of the input price, until the cache expires or the start of the prompt changes. The Prompt Cache tab shows how much of each prompt was reused, what that saved, and why the cache broke.

Each harness is shown separately, never pooled, because harnesses log the cache differently.

### Key figures

- **Cache hit ratio** -- For each harness, the share of prompt tokens read from the cache, across all model calls, including subagents and compaction summaries. Larger prompts count more.
- **Input cost saved** and **Cost on cache misses** -- How much caching cut the input cost, and the share of the input cost spent on tokens that weren't read from the cache. They're computed from the per-call prices that Copilot App and Copilot CLI log, and shown only as percentages, never as amounts.
- **Breaks per 100 calls** -- How often a main-agent call couldn't reuse the previous call's cached prompt (Copilot App and Copilot CLI).
- **Coverage** -- How many requests in the range logged cache tokens.

Below the key figures, a bar for each harness splits its prompt tokens into **read from cache**, **written to cache**, and **uncached**. Harnesses that don't log the cache show "Not reported by this harness".

### Why the cache broke

A cache break is a main-agent call that couldn't reuse most of the previous call's cached prompt: at least 30% of it, and at least 10K tokens, when the previous prompt had 20K tokens or more. **Rebuilt tokens** are the part of the previous prompt that had to be sent again. Open a row to see what the cause means, what you can do, and which other causes were logged on the same breaks.

| Cause | How it's detected | Who can change it |
|---|---|---|
| **Came back after the cache expired** | You started the call after the previous call's cache had expired | You |
| **Cache expired while the agent waited** | The same, but the agent continued on its own after a long-running tool or background agent | Partly |
| **Resumed an earlier session** | The session was resumed | You |
| **Switched model** | The call used a different model. A model can't reuse another model's cache | You |
| **Automatic model selection switched model** | The same, when automatic model selection picked the new model | Harness |
| **Changed reasoning effort** | The call used a different reasoning effort | You |
| **Switched mode** | The session switched mode, for example to plan or autopilot | You |
| **Tool set changed** | The number or size of the tool definitions changed, for example when MCP servers were turned on or off, or a checkpoint shows changed tool schemas | Partly |
| **Instructions or memory changed** | A checkpoint shows that your instruction files or memories changed in the system prompt | You |
| **System prompt updated by the harness** | A checkpoint shows that parts the harness maintains changed, such as workspace or environment context | Harness |
| **Compaction** | The conversation was compacted, so the cache was rebuilt from the summary | Harness |
| **No logged cause** | Nothing logged explains the break | Unknown |

Causes often occur together. Resuming an old session, for example, usually also means that the cache expired. Each break is counted once, under its first logged cause in this order: compaction, model switch, cache expiry, reasoning effort, tool set, mode switch, and resume. A break with no logged cause is counted under a system-prompt or tool-schema change seen between checkpoints, if there was one.

Most causes are logged on the call itself or in an event since the previous call. System-prompt and tool-schema changes are visible only between two usage checkpoints, which are written periodically rather than on every call. Breaks explained only by such a change are marked as attributed from a **checkpoint window**: the change happened somewhere in that window.

Each session lists its first 100 breaks. Later breaks still count toward rebuilt tokens and break rates, but their causes aren't listed, so their rebuilt tokens count as unknown in who can change the cause.

Two cards break the misses down further:

- **Where cache misses come from** -- Prompt tokens not read from the cache, by origin: new context such as your prompts and tool results (expected), context rebuilt after a break, subagents (which build their own context), compaction summaries, and the first call of each session. In parentheses, the share of the input cost.
- **Cache lifetime and expiry** -- The cache lifetime your logs show for each model, how often you came back after the cache had expired, and, for each expiry break, the time since the cache was last refreshed in multiples of the lifetime, split into you away and the agent waiting. A call refreshes the cache when it starts, so this time runs from the previous call's start to the next call's start, and the cache had expired exactly when it's longer than the lifetime. The logged lifetimes, for example 5 or 30 minutes, can differ from general documentation.

Below them, **Cache hit ratio by week** shows a line per harness, and **By model** lists each model's hit ratio, write share, breaks per 100 calls, and cache lifetime. **Sessions that rebuilt the most** and **By workspace** lead to individual sessions.

### Session timeline

![Prompt Cache session timeline](/screenshots/screen-prompt-cache-session.png)

Open a session to load its timeline. Each bar is one main-agent model call, split into read, written, and uncached tokens, so its height is the prompt size. In long sessions, a bar averages a group of consecutive calls. Cache breaks are marked with their cause; use the **Cache tokens** and **Cache breaks** buttons to show or hide each layer. The table below the chart lists each break with its time, the time since the cache was last refreshed against the cache lifetime, rebuilt tokens, and confidence. For keyboard and screen-reader use, **Show the chart as a table** lists every bar with its time span, its values, and the full text of its markers.

Claude Code and OpenCode sessions show one bar per request and no breaks. Codex sessions show only their totals.

#### Where the data comes from

| Harness | Source | What you get |
|---|---|---|
| GitHub Copilot App and Copilot CLI | `session.usage_record` and `session.usage_checkpoint`, plus compaction, mode-change, and resume events, in `events.jsonl` | Cache tokens, cache lifetime and expiry, and the logged prices for every model call of the main agent, subagents, and compaction summaries, plus cache breaks and their causes. Older builds that don't log per-call usage show no cache data |
| Claude Code | `usage` on each API response | Cache read and write tokens for every response. Claude Code repeats a response's usage on each of its content blocks, so each response is counted once |
| OpenCode | Token counts of each assistant message | Cache read and write tokens of every assistant message |
| Codex | Session token totals | The hit ratio, from cached input tokens. OpenAI's cache has no separate cache writes |
| VS Code, Xcode | Not logged | Shown as "Not reported by this harness". Nothing is estimated |

Prompt-cache data holds only token counts, timestamps, cache lifetimes, model names, cause types, and system-prompt segment names. Fingerprints of system-prompt segments and tool schemas are compared in memory to spot changes and are never stored, and neither are tool names or schemas.

#### How to act on it

GitHub's [Preserve the cache](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage#4-preserve-the-cache) guidance maps to the causes you can change:

- **Came back after the cache expired** -- After a break, start a new session or run `/compact` before you continue, so a short summary is rebuilt instead of the whole conversation.
- **Resumed an earlier session** -- When you don't need the earlier conversation, start a new session instead of resuming an old one.
- **Switched model** -- Pick a model, or automatic model selection, when you start and keep it for the session. Run work that needs another model in a subagent.
- **Changed reasoning effort**, **Switched mode**, or **Tool set changed** -- Set the reasoning effort, mode, tools, and MCP servers you need before you start, and leave them unchanged for the session.
- **Instructions or memory changed** -- Edit instruction files between sessions when you can.

Insights at the top of the tab apply these tips to your own numbers and quote the cache lifetimes your logs show. Causes the harness controls, and expiries while the agent waited on a long-running task, are explained but not coached.

#### Caveats

- Breaks are detected for the main agent only. Subagents build their own context and appear under **Where cache misses come from**.
- Copilot App and Copilot CLI log each call when it finishes, but its cache lifetime counts from when it started. Expiry is therefore checked from each call's start, using the call duration in the log.
- Totals count the requests sent in the selected range, like Context Composition, and a break counts when its request is in the range. The session lists include every session with a request in the range, and their numbers cover the whole session.
- Cost percentages use the prices logged with each call. Costs are added up in the logged price unit before the percentage is taken, so calls to pricier models weigh more. They describe the relative effect of caching, not what you're billed.
- Claude Code, OpenCode, and Codex don't log what invalidated the cache, so they show efficiency only.
- These figures are for your own coaching, not for evaluating anyone's performance.
