---
title: "Timeline"
weight: 20
description: "When your agents worked, when they waited on you, and how your delegated work went"
---

# Timeline

The Timeline shows each day or week of AI coding as lanes, one per session: when the agent was working, when it was stopped for you, who sent every turn, and which sessions started which. A third view, **Families**, looks at each piece of delegated work as a whole: what it cost, where you stepped in, and how wide it fanned out. Every sentence on the page states what your logs show; it never guesses why.

![Timeline View](/screenshots/screen-timeline.png)

Pick **Day**, **Week** or **Families** at the top. Step between active days or weeks with **‹ ›**, or with the **←** and **→** keys while the Timeline has focus (not the sidebar, a button or a text field). Click a lane, then use **↑** and **↓** to move between lanes; in the Families list they move between families. Family headers, impact rows and the sessions of a family open with **Enter** or **Space**. The workspace and harness filters in the sidebar, and the date range, apply to every view.

## Definitions

| Term | Rule |
|---|---|
| Your input | A prompt you typed, or your answer to a question or a permission prompt, at the time you answered. A turn counts as typed by you when the harness marked it as neither automated nor sent by another session |
| Stopped for you | A turn waiting on a question or a permission prompt, answered or not. That time is never agent time |
| Agent time | Per session: the time from each prompt to the turn's last logged agent activity, merged where turns overlap, minus the time the session was stopped for you. A day or week counts the part inside it |
| Waiting on you | Per session: the gaps from the end of its work (or of a question still open after it) to your next typed prompt, from 2 to 120 minutes, plus every question and permission prompt you answered, counted once where they overlap. A wait is counted on the day it started; its time counts on the days it covers. Gaps longer than 2 hours are time away, not waiting |
| Longest unattended | Per family: from one of your inputs anywhere in the family, for as long as the family's agent work kept running (pauses up to 2 minutes don't end it), and never past your next input anywhere in the family. Every member counts, also those the filters hide or that have no turn in the range |
| Peak parallel sessions | The most sessions doing agent work at the same time, and when |

Questions are Copilot `ask_user` calls, questions a coordinator relayed to you from a child session, and Claude Code `AskUserQuestion` calls. An answer counts when the log shows one: a result from you, also when it was logged in the same millisecond as the question. An interrupted question stops the agent but isn't an answer; a question with no result logged stops it until the next line in the log. Permission prompts count as yours only when the log shows a person decided them: a decision a policy made (`host_policy`, `unattended_fallback`) isn't a request to you, and when an older Copilot build logs no decision source, the prompt stops the agent but isn't counted as an answer. A relayed question is counted once, in the child that asked it.

Every interval is built over the whole log first, then clipped: to the date range, then to the day or week. So a range gives the same per-day values as its days one at a time, the days of a week add up to the week, and the summary export of a day matches the Day view. Work and waits outside the range never count; the turns just outside it that a total needs (the last input before it, a turn running into it, the next prompt after it) are read, never counted as turns. Days are local calendar days, so a daylight-saving day has 23 or 25 hours.

## What happened, in three callouts

Each day or week starts with three findings:

- **Unattended work**: the family with the longest unattended stretch, and how long it was. It names the coordinator, or, when the coordinator isn't shown, the family it belongs to.
- **Where credits went**: the share of the shown credits used by child sessions, the child that used most, and the prompts you typed into it and the questions or permission prompts you answered in it, or that none was recorded.
- **Waiting on you**: how many waits started, for your next prompt and on a question or permission prompt you answered, their time in total, and how many lasted 30 minutes or more, with a suggestion only then. When no wait was recorded, it says so, and counts the longer gaps as time away.

## Day strip

The strip shows every active day in range, before the lane filters: days with a turn, agent work or waiting on you, stacked as prompts you typed and automated turns. Switch it to **Agent hours** to see agent working time per day. Click a day to open it in the current view. In the Week view, the selected week is highlighted.

## Lanes

Each lane is one session with activity in the day or week: a turn, agent work, waiting on you or an answer. It is labelled with the name you gave the session, its role (coordinator, child, grandchild, or descendant with its depth), its repository (never a path; Xcode logs none, since its workspace name is the conversation's title), and its harness and model. Unnamed sessions read *Untitled … session N* with their date.

- **Bars** show when the agent was working, clipped to the day or week. **Light hatching** shows a session waiting for your next prompt; **dense hatching** shows a turn stopped for your answer.
- **Markers** show who sent each turn: ● you, ◆ another agent or session, ○ autopilot, ■ compaction or the harness.
- A small badge counts the **sub-agent launches** a turn recorded: Copilot sub-agent runs, Claude Code `Agent` or `Task` calls, and Codex `spawn_agent` calls.
- In **Session tree** grouping, child sessions sit under the session that started them, with a dashed connector at the time the parent created them (or their first activity shown, when no creation time was logged). A child whose parent isn't drawn above it says why: *parent hidden by a filter*, *parent not active this day*, or *parent outside this range or the sidebar selection*; it adds *linked to its nearest shown ancestor* when the connector skips a hidden parent. Each family has a header with its typed and automated turns, agent time, credits and share; click it to collapse the family. **Flat** lists the lanes by start time.
- **Color** lanes by family or by harness.

Use the filters above the lanes to show one harness, search a repository or model, or keep only families, sessions you typed in, sessions that waited on you, sessions that used sub-agents, or sessions with more than one turn. The KPIs, callouts and the impact table then describe the shown sessions; the longest unattended stretch still follows the whole family. The selection stays on a lane you can see.

## Impact and session details

**Impact by session family** ranks the day's families by credits, with typed and automated turns, agent time and the longest unattended stretch; bars compare each family with the largest. Click a row to select the family's coordinator, or its top session shown when the coordinator isn't.

Click a lane to see its details: role and direct parent, branch, harness, model and time span, typed and automated turns, agent time and credits in the day or week, sub-agent launches, and every turn that started in it with its time, sender, its own agent time and the time it was stopped for you. No prompt text is shown. Links open the parent session, the fork source, the first child, the family in the Families view, and **Context Health › Prompt Cache** (and **Token Types** when token reporting is on).

## Families

A **family** is a coordinator session plus every session it started, directly or through its children, as linked in your logs. The Families view covers the whole range:

![Families view](/screenshots/screen-timeline-families.png)

- **What your families show**: the share of credits of the families where you stepped into a child against those with no input in their children, how many child sessions got a prompt or an answer from you, and how much the wide fan-outs used. These are observations, not causes.
- **KPIs**: families, child sessions, their share of credits and agent time, prompts you typed into children (and answers you gave in them), and the credits in the top three, or fewer when there are fewer families. Shares read — when no credits were logged.
- **Verdicts**: **No input in children** (no prompt or answer from you was recorded in any child in the range), **You stepped in** (you typed into a child, or answered its question or permission prompt), and **Wide fan-out** (8 or more child sessions at any depth, shown on top of the other verdict). Click a verdict to filter the list; the selection follows the filter.
- **The list** ranks families by credits, with their biggest children (✋ marks a child you typed into or answered in) and a running total of credits. Search by name or repository, sort, or set a minimum size.
- **The selected family** shows what the logs show about it in words, one habit to consider, its footprint, every session in tree order (members with no activity in the range are listed, dimmed), and **Open on the Timeline**, which opens the day with most of its turns on the coordinator, or on the member with most turns that day.

## How sessions are linked

A session's parent is found from what the harness logged, never from how a message reads:

1. **Copilot App and Copilot CLI**: the session whose `create_session`, `open_pr_session` or `open_issue_session` call (also behind an MCP server prefix) returned the child: the `session_id` field, or the labelled ID or session link in its text, never another ID such as the project's. A session that began more than a minute before the call was opened, not created, so it isn't linked.
2. **Codex and OpenCode**: the parent thread or session the harness recorded.
3. Otherwise, the session that relayed a session's **first** message. Coordinators also receive relayed reports from their children, so later relayed messages never count, and a link that would make a loop is dropped.

Claude Code sub-agents are part of their parent session's lane.

**Forks** are your own branches of a conversation, so they aren't part of a family. A forked session's lane says *fork of* its source:

- **Codex** writes the source thread (`forked_from_id`) in the fork, and the fork's first token count already includes the source's; only the fork's own tokens are counted.
- **Claude Code** (`--fork-session`) starts the fork with the source's messages, copied with their IDs and their original, older times. A message that another session also holds, or that is more than a second older than the fork's first line, is a copy: it is counted once, in the session that holds it as its own, on every tab and in the export. The fork's source is the session that holds the latest copied message. When no loaded session holds it, the lane says *fork of a session not in these logs*.
- **Copilot App and Copilot CLI** log only a fork count (`fork_count`), with no source session, so their forks aren't linked.

## Names, credits and privacy

- **Names and branches** come from Copilot App and Copilot CLI (`workspace.yaml`). Only names you gave are shown: an automatic title (`user_named: false`, or a title that repeats your first prompt or its start) often is your prompt, so it's replaced by *Untitled … session N*. Before a name, branch, repository or model is shown, links, email addresses, drive, network and absolute paths (also quoted or with spaces), your OS account name and your GitHub handle are removed. A branch also loses a first word that is your signed-in GitHub handle or your OS account name. Generic account names such as `vscode`, `node` or `root` are ordinary words and stay. A repository named only after you reads *personal repository*. This covers the patterns above; it isn't a guarantee that free text you typed into a name holds nothing personal.
- **Mask names** replaces session names with *Session N*, hides branches, replaces repositories with letters and clears both search boxes. It covers the Timeline page only: the sidebar still shows the workspace you picked.
- **Credits** are the AI credits Copilot App and Copilot CLI log for each model call, sub-agents included. Other harnesses show time and turns.
- The dashboard runs locally from your session logs, read-only. No prompt text is shown.

Ask `@aicoach` about autonomy and delegation: the `aiEngineerCoach_timeline` tool returns the same KPIs, callouts and family verdicts for the chat model to read, with session and repository names always masked and no branches; the Timeline page is where names appear. It checks that dates are real calendar dates and reports the range you asked for apart from the days it found. The summary export adds an **Autonomy and Delegation** section with counts only.
