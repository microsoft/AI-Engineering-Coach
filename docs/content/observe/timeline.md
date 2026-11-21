---
title: "Timeline"
weight: 20
description: "When your agents worked, when they waited on you, and how your delegated work went"
---

# Timeline

The Timeline shows each day or week of AI coding as lanes, one per session: when the agent was working, when it was waiting on you, who sent every turn, and which sessions started which. A third view, **Families**, judges each piece of delegated work as a whole: what it cost, whether the agents finished on their own, and whether splitting the work was worth it.

![Timeline View](/screenshots/screen-timeline.png)

Pick **Day**, **Week** or **Families** at the top. Step between active days or weeks with **‹ ›** or the **←** and **→** keys. Click a lane, then use **↑** and **↓** to move between lanes; elsewhere on the page they scroll as usual. The workspace, harness and date filters in the sidebar apply to every view.

## What happened, in three callouts

Each day or week starts with three findings, each with one thing to try:

- **Unattended work**: the family whose agents kept working longest after one prompt or answer from you, with no further input into the session doing that work. It names the coordinator, or, when the coordinator isn't shown, the child and the coordinator that started it. Reuse the brief that made it work.
- **Where credits went**: the share of the shown credits used by child sessions, and the child that used most. When you typed into that child or answered its question, open it to see why it needed you.
- **Waiting on you**: how often agents waited for your next prompt after finishing a turn and how often they stopped for a question or a permission prompt, for how long in total, and how many waits were longer than 30 minutes. Gaps longer than 2 hours are time away, not waiting, and the callout says so when they're all there was.

## Autonomy KPIs

| KPI | What it measures |
|---|---|
| Agent time | Sum of each turn's agent time: from the prompt to the turn's last assistant message, minus the time the turn waited for your answer to a question or a permission prompt |
| Turns you typed | Prompts you typed, out of every turn. The rest were sent by agents, other sessions, autopilot, compaction or the harness |
| Agent time per prompt | Agent time divided by the prompts you typed |
| Longest unattended | The longest stretch a family's agents kept working after one of your inputs (a prompt you typed or an answer you gave): agent work the family started before your next input, for as long as some of it was running. A pause of more than 2 minutes with no agent working ends the stretch |
| Waiting on you | Gaps from the end of a session's turn to your next typed prompt in it, from 2 to 120 minutes, plus every question and permission prompt you answered inside a turn. After a turn whose harness logged no duration, the end of the work is unknown, so no gap is counted |
| Peak parallel agents | The most turns doing agent work at the same time, and when. A turn waiting on your answer doesn't count |

Questions are Copilot `ask_user` calls, questions a child session relayed to you, and Claude Code `AskUserQuestion` calls, counted when the log shows you answered. Permission prompts count only when you decided them: a decision a policy made in milliseconds isn't a wait on you, and older Copilot builds that don't log who decided aren't counted either.

A day or week counts the part of each wait, each stretch and each turn's agent time inside it, so the days of a week add up to the week. Turns, typed prompts and waits are counted on the day they started. A turn that started the day before and ran past midnight is drawn on both days and counted on the first. Days are local calendar days, so a daylight-saving day has 23 or 25 hours.

## Day strip

The strip shows every active day in range, stacked as prompts you typed and automated turns. Switch it to **Agent hours** to see agent working time per day. Click a day to open it. In the Week view, the selected week is highlighted.

## Lanes

Each lane is one session, labelled with the name your harness logged for it, its role (coordinator, child or grandchild), its repository (never a path), and its harness and model. Unnamed sessions read *Untitled … session* with their date.

- **Bars** show when the agent was working. **Light hatching** shows a finished turn waiting for your next prompt; **dense hatching** shows a turn stopped for your answer to a question or a permission prompt.
- **Markers** show who sent each turn: ● you typed it, ◆ another agent or session sent it, ○ autopilot continued, ■ compaction or the harness.
- A small badge counts the **sub-agent runs** a turn launched (Copilot sub-agents, and Claude Code `Agent` or `Task` calls).
- In **Session tree** grouping, child sessions sit under the session that started them, with a dashed connector at the time they started. A child whose parent isn't shown says why: *parent hidden by a filter*, or *parent not active this day*. Each family has a header with its typed and automated turns, agent time, credits and share; click it to collapse the family. **Flat** lists the lanes by start time.
- **Color** lanes by family or by harness.

Use the filters above the lanes to show one harness, search a repository or model, or keep only families, sessions you typed in, sessions that waited on you, sessions that used sub-agents, or sessions with more than one turn. The KPIs, callouts and the impact table then describe the shown sessions only.

## Impact and session details

**Impact by session family** ranks the day's families by credits, with typed and automated turns, agent time and the longest unattended stretch. Click a row to select the family's coordinator.

Click a lane to see its details: role and branch, harness, model and time span, typed and automated turns, agent time, credits and their share, sub-agent runs, and every turn with its time, sender, agent time and time waiting on you. No prompt text is shown. Links open the parent session, the fork source, the first child, the family in the Families view, and **Context Health › Prompt Cache** (and **Token Types** when token reporting is on).

## Families

A **family** is a coordinator session you talked to plus every session it started, directly or through its children. The Families view covers the whole range:

![Families view](/screenshots/screen-timeline-families.png)

- **What your families tell you**: the share of credits used by families that needed you against those that worked alone (it calls clearer briefs the biggest lever only when the families that needed you used more), how many child sessions needed you, and how much the wide fan-outs used.
- **KPIs**: families, child sessions, their share of credits and agent time, prompts you typed into children, and the credits in the top three.
- **Verdicts**: **Worked alone** (no prompt or answer from you in any child), **Needed you** (you typed into at least one child, or answered its question or permission prompt), and **Wide fan-out** (8 or more children). Click a verdict to filter the list. The verdict text and the KPIs count typed prompts and answers separately.
- **The list** ranks families by credits, with their biggest children (✋ marks a child you typed into or answered) and a running total of credits. Search by name or repository, sort, or set a minimum size.
- **The selected family** shows its verdict in words, one habit to try next time, its footprint, every session in tree order, and **Open on the Timeline**, which opens its busiest day.

## How sessions are linked

A session's parent is found from what the harness logged, never from how a message reads:

1. **Copilot App and Copilot CLI**: the session whose `create_session`, `open_pr_session` or `open_issue_session` call (also behind an MCP server prefix) returned the child: its labelled ID or session link, not any other ID in the result.
2. **Codex and OpenCode**: the parent thread or session the harness recorded.
3. Otherwise, the session that relayed a session's **first** message. Coordinators also receive relayed reports from their children, so later relayed messages never count, and a link that would make a loop is dropped.

Claude Code sub-agents are part of their parent session's lane.

**Forks** are your own branches of a conversation, so they aren't part of a family. A forked session's lane says *fork of* its source where the log records it:

- **Codex** writes the source thread (`forked_from_id`) in the fork.
- **Claude Code** (`--fork-session`) starts the fork with the source's messages, copied with their IDs and times. Those copied turns are counted once, in the source.
- **Copilot App and Copilot CLI** only count forks (`fork_count`) without naming the source, so their forks aren't linked.

## Names, credits and privacy

- **Names and branches** come from Copilot App and Copilot CLI (`workspace.yaml`). Before they're shown, links, email addresses, drive and home paths, your account name and your GitHub handle are removed; a branch loses its prefix only when it is your signed-in GitHub handle. Generic account names such as `vscode`, `node` or `root` are ordinary words and stay. A repository named only after you reads *personal repository*.
- **Mask names** replaces session names with *Session N*, hides branches and replaces repositories with letters, so a screenshot shows no names.
- **Credits** are the AI credits Copilot App and Copilot CLI log for each model call, sub-agents included. Other harnesses show time and turns.
- Everything runs locally from your session logs, read-only. No prompt text is shown and nothing is sent anywhere.

Ask `@aicoach` about autonomy and delegation: the `aiEngineerCoach_timeline` tool returns the same KPIs, callouts and family verdicts, with session and repository names masked unless you ask for them. It never sends branches. The summary export adds an **Autonomy and Delegation** section.
