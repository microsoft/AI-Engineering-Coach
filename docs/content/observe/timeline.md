---
title: "Timeline"
weight: 20
description: "When your agents worked, when they waited on you, and how your delegated work went"
---

# Timeline

The Timeline shows each day or week of AI coding as lanes, one per session: when the agent was working, when it was waiting on you, who sent every turn, and which sessions started which. A third view, **Families**, judges each piece of delegated work as a whole: what it cost, whether the agents finished on their own, and whether splitting the work was worth it.

![Timeline View](/screenshots/screen-timeline.png)

Pick **Day**, **Week** or **Families** at the top. Step between active days or weeks with **‹ ›** or the **←** and **→** keys, and between lanes with **↑** and **↓**. The workspace, harness and date filters in the sidebar apply to every view.

## What happened, in three callouts

Each day or week starts with three findings, each with one thing to try:

- **Unattended work**: the family whose agents kept working longest after a single prompt from you, with no further prompt into the sessions doing that work. Reuse the brief that made it work.
- **Where credits went**: the share of credits used by child sessions, and the child that used most. When you typed into that child yourself, open it to see why it needed you.
- **Waiting on you**: how often agents finished and waited for your next prompt, for how long, and how many waits were longer than 30 minutes.

## Autonomy KPIs

| KPI | What it measures |
|---|---|
| Agent time | Sum of each turn's agent time: from the prompt to the turn's last assistant message |
| Turns you typed | Prompts you typed, out of every turn. The rest were sent by agents, other sessions, autopilot, compaction or the harness |
| Agent time per prompt | Agent time divided by the prompts you typed |
| Longest unattended | The longest stretch from one of your prompts to the end of the agent work a family started before your next prompt. Work that runs past your next prompt counts to its end: a turn ends when you prompt its own session, so that work was in a session you didn't prompt |
| Waiting on you | Gaps from the end of a session's agent work to your next typed prompt in it, from 2 to 120 minutes. After a turn whose harness logged no duration, the end of the work is unknown, so no wait is counted |
| Peak parallel agents | The most turns whose agent time overlapped, and when |

Agent time includes any time a turn waited on a question you hadn't answered yet.

## Day strip

The strip shows every active day in range, stacked as prompts you typed and automated turns. Switch it to **Agent hours** to see agent working time per day. Click a day to open it. In the Week view, the selected week is highlighted.

## Lanes

Each lane is one session, labelled with the name your harness logged for it, its role (coordinator, child or grandchild), its repository (never a path), and its harness and model. Unnamed sessions read *Untitled … session* with their date.

- **Bars** show when the agent was working; **hatching** shows when it was waiting on you.
- **Markers** show who sent each turn: ● you typed it, ◆ another agent or session sent it, ○ autopilot continued, ■ compaction or the harness.
- A small badge counts the **sub-agent runs** a turn launched.
- In **Session tree** grouping, child sessions sit under the session that started them, with a dashed connector at the time they started. Each family has a header with its typed and automated turns, agent time, credits and share; click it to collapse the family. **Flat** lists the lanes by start time.
- **Color** lanes by family or by harness.

Use the filters above the lanes to show one harness, search a repository or model, or keep only families, sessions you typed in, sessions that waited on you, sessions that used sub-agents, or sessions with more than one turn. The KPIs, callouts and the impact table then describe the shown sessions only.

## Impact and session details

**Impact by session family** ranks the day's families by credits, with typed and automated turns, agent time and the longest unattended stretch. Click a row to select the family's coordinator.

Click a lane to see its details: role and branch, harness, model and time span, typed and automated turns, agent time, credits and their share, sub-agent runs, and every turn with its time, sender and agent time. No prompt text is shown. Links open the parent session, the first child, the family in the Families view, and **Context Health › Prompt Cache** or **Token Types**.

## Families

A **family** is a coordinator session you talked to plus every session it started, directly or through its children. The Families view covers the whole range:

![Families view](/screenshots/screen-timeline-families.png)

- **What your families tell you**: the share of credits used by families that needed you against those that worked alone, how many child sessions needed a prompt from you, and how much the wide fan-outs used.
- **KPIs**: families, child sessions, their share of credits and agent time, prompts you typed into children, and the credits in the top three.
- **Verdicts**: **Worked alone** (no prompt from you in any child), **Needed you** (you typed into at least one child), and **Wide fan-out** (8 or more children). Click a verdict to filter the list.
- **The list** ranks families by credits, with their biggest children (✋ marks a child you typed into) and a running total of credits. Search by name or repository, sort, or set a minimum size.
- **The selected family** shows its verdict in words, one habit to try next time, its footprint, every session in tree order, and **Open on the Timeline**, which opens its busiest day.

## How sessions are linked

A session's parent is found from what the harness logged, never from how a message reads:

1. **Copilot App and Copilot CLI**: the session whose `create_session`, `open_pr_session` or `open_issue_session` call returned the child's ID.
2. **Codex and OpenCode**: the parent thread or session the harness recorded.
3. Otherwise, the session that relayed a session's **first** message. Coordinators also receive relayed reports from their children, so later relayed messages never count, and a link that would make a loop is dropped.

Claude Code sub-agents are part of their parent session's lane. No harness logs which session a fork came from yet, so forks aren't drawn.

## Names, credits and privacy

- **Names and branches** come from Copilot App and Copilot CLI (`workspace.yaml`). Before they're shown, links, email addresses, drive and home paths, your account name and your GitHub handle are removed; branches lose the handle prefix.
- **Mask names** replaces session names with *Session N*, hides branches and replaces repositories with letters, so a screenshot shows no names.
- **Credits** are the AI credits Copilot App and Copilot CLI log for each model call, sub-agents included. Other harnesses show time and turns.
- Everything runs locally from your session logs, read-only. No prompt text is shown and nothing is sent anywhere.

Ask `@aicoach` about autonomy and delegation: the `aiEngineerCoach_timeline` tool returns the same KPIs, callouts and family verdicts. The summary export adds an **Autonomy and Delegation** section.
