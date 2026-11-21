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
| Your input | A prompt you typed, or your answer to a question or a permission prompt, at the time you answered: when Copilot's own record of your answer (`human_response.recorded`) was logged, else when the question's result was. A turn counts as typed by you when the harness marked it as neither automated nor sent by another session |
| Stopped for you | A turn waiting on a question or a permission prompt, answered or not. That time is never that turn's agent time; another turn of the same session can keep working meanwhile |
| Agent time | Per session: the time from each prompt to the turn's last logged agent activity, less the time that turn was stopped for you, merged where turns overlap. A turn with no logged duration adds nothing (its work isn't measured). A day or week counts the part inside it |
| Waiting on you | Per session: the gaps from the end of its work (or of a question still open after it) to your next typed prompt, from 2 to 120 minutes (inferred waits: the log only shows the agent had stopped), plus every question and permission prompt you answered, from the request to its result (the tool's clock: the result can come a little after your answer), counted once where they overlap. Then summed over sessions: when a coordinator and its child both wait on one question, both count (session-minutes, not minutes of your attention). A question Copilot recorded your answer to before the question itself was logged has no measurable start: its answer counts, but no waiting time. A wait ending exactly at midnight belongs to the day before. A wait is counted on the day it started; its time counts on the days it covers. Gaps longer than 2 hours are time away, not waiting |
| Longest unattended | Per family: from one of your inputs anywhere in the family (each decision once: a relayed answer paired with the child's own record of it is one input, at the child's time), for as long as the family's measured agent work kept running (pauses of at most 2 minutes don't end it), until the work stopped or your next input anywhere in the family, whichever came first. Every member counts, also those the filters hide or that have no turn in the range |
| Peak parallel sessions | The most sessions doing agent work at the same time, and when |

Questions are Copilot `ask_user` calls, questions a coordinator relayed to you from a child session, and Claude Code `AskUserQuestion` calls. An answer counts when the log shows one: a result from you, also when it was logged in the same millisecond as the question. An interrupted question stops the agent but isn't an answer; a question or permission prompt with no result logged stops it, unanswered, until the next event the harness logged after it (any line, in Copilot events and Claude Code transcripts alike), unless a Copilot `human_response.recorded` record says you answered it: then it stops the agent until that record, and counts as answered then. That record dates your answer also when a result was logged: in real logs the result comes from a few milliseconds to minutes later, and the record can even come before the question's own entry, so the result's time would move your answer, and a family's verdict, to the wrong day. A day that lies wholly inside a stop you didn't answer isn't an active day for the session, even when the turn goes on after it. Permission prompts count as yours only when the log shows a person decided them: a decision a policy made (`host_policy`, `unattended_fallback`) isn't a request to you, and when an older Copilot build logs no decision source, the prompt stops the agent but isn't counted as an answer. A relayed question is counted once: in the child that asked it when a session the relaying one started (directly or through its children) logged its own answer to it, each relayed answer pairing with one such answer; otherwise in the session that relayed it. The pair is found by the request both logged (the relay's `request_id` and the child's record of your answer) first; without one, by the nearest answer to a question within 10 seconds that isn't known to be for another request. Pairs are found once over the whole log, so a range that leaves out the child's answer still knows the relay delivered it: a paired relay is no answer and no input of the relaying session on any day. The time it stopped that session's agent is still that session's waiting, and makes the session active in the days it covers, like any stop; a relay that took no time adds nothing. An answer in an unrelated session, or to a permission prompt, never stands in for a relayed one. An answer is a point in time: it counts on its day even at midnight, and even when nothing else happened that day, also when the turn it belongs to started on another day. When a day holds only answers and no waiting time, the callout says which took no measurable time (question, result and answer at the same moment), which ended a wait that began earlier, and which had no waiting time measured in the period (recorded before the question was logged, or after its result). A Copilot session whose only logged activity is your answer to a permission prompt has no turn; the Timeline shows it as a lane with that wait, and other tabs don't count it.

Every interval is built over the whole log first, then clipped: to the date range, then to the day or week. So a range gives the same per-day values as its days one at a time, and the summary export of a day matches the Day view. Times (agent time, waiting) and counts of things that start (turns, typed prompts, waits that started, answers) add up from days to the week; peaks, longest stretches, distinct sessions and percentages don't. Work and waits outside the range never count; the turns just outside it that a total needs (the last input before it, a turn running into it, the next prompt after it) are read, never counted as turns. Days are local calendar days, so a daylight-saving day has 23 or 25 hours.

## What happened, in three callouts

Each day or week starts with three findings:

- **Unattended work**: the family with the longest unattended stretch, and how long it was. It names the coordinator, or, when the coordinator isn't shown, the family it belongs to.
- **Where credits went**: the share of the shown credits used by child sessions, the child that used most, and the prompts you typed into it and the questions or permission prompts you answered in it, or that none was recorded.
- **Waiting on you**: how many waits started, for your next prompt and on a question or permission prompt you answered, their time in total, and how many lasted 30 minutes or more, with a suggestion only then. When no wait was recorded, it says so, and counts the longer gaps as time away.

## Day strip

The strip shows every active day in range, before the lane filters: days with a turn, agent work, waiting on you or an answer you gave, stacked as prompts you typed and automated turns. A day that holds only an answer (one logged at midnight, for example) is listed with an empty bar. Switch it to **Agent hours** to see agent working time per day. Click a day to open it in the current view. In the Week view, the selected week is highlighted.

## Lanes

Each lane is one session with activity in the day or week: a turn, agent work, waiting on you or an answer. It is labelled with the name you gave the session, its role (coordinator, child, grandchild, or descendant with its depth), its repository (never a path; Xcode logs none, since its workspace name is the conversation's title), and its harness and model. Unnamed sessions read *Untitled … session N* with their date.

- **Bars** show when the agent was working, clipped to the day or week. **Light hatching** shows a session waiting for your next prompt; **dense hatching** shows a turn stopped for your answer.
- **Markers** show who sent each turn: ● you, ◆ another agent or session, ○ autopilot, ■ compaction or the harness.
- A small badge counts the **sub-agent launches** a turn recorded: Copilot sub-agent runs, Claude Code `Agent` or `Task` calls, and Codex `spawn_agent` calls.
- In **Session tree** grouping, child sessions sit under the session that started them, with a dashed connector: from when the parent requested them, when its `create_session` call logged it (the child's own log begins a little later, by up to a minute), else from their first activity shown, and to their nearest shown ancestor when the parent is hidden. A child whose parent isn't drawn above it says why: *parent hidden by a filter*, *parent not active this day*, or *parent outside this range or the sidebar selection*; it adds *linked to its nearest shown ancestor* when the connector skips a hidden parent. Each family has a header with its typed and automated turns, agent time, credits and share; click it to collapse the family. **Flat** lists the lanes by start time.
- **Color** lanes by family or by harness.

Use the filters above the lanes to show one harness, search a repository or model, or keep only families, sessions you typed in, sessions that waited on you, sessions that used sub-agents, or sessions with more than one turn. The KPIs, callouts and the impact table then describe the shown sessions; the longest unattended stretch still follows the whole family. The selection stays on a lane you can see.

## Impact and session details

**Impact by session family** ranks the day's families by credits, with typed and automated turns, agent time and the longest unattended stretch; bars compare each family with the largest. Click a row to select the family's coordinator, or its top session shown when the coordinator isn't.

Click a lane to see its details: role and direct parent, branch, harness, model and time span, typed and automated turns, agent time and credits in the day or week, sub-agent launches, and every turn that started in it with its time, sender, its own agent time and the time it was stopped for you. Links open the parent session, the fork source, the first child, the family in the Families view, and **Context Health › Prompt Cache** (and **Token Types** when token reporting is on).

### Prompts and questions

**Show prompts and questions**, in the lane's details, shows the text behind the lane's day or week, in time order:

![A lane's prompts and questions](/screenshots/screen-timeline-text.png)

- **Each turn**: the message that started it (what you typed, or what a coordinator, relay or autopilot sent), and the end of the agent's reply in the turn. Compaction summaries and harness messages aren't shown.
- **Questions**: what the agent asked, with its choices and what it said just before, and your answer and how long you took. A relayed question shows the child's question and your reply.
- **Permission prompts**: what was requested (the command, path, URL, tool or extension), the kind of request, the agent's stated reason, and the decision. Decisions a policy made aren't requests to you, so they aren't listed.
- **Waits for your next prompt**: how long the agent waited, and the end of the reply it waited after.

Click a hatched wait on a lane, or focus it and press **Enter** or **Space**, to jump to it. Copilot App and Copilot CLI log all of these; Claude Code logs its `AskUserQuestion` questions and your answers; other harnesses show the turns' messages.

The text is read again from that session's log on this machine when you open the lane, and only for that lane: the Timeline's data, the `@aicoach` chat tool and the summary export never carry it. Links, email addresses, secret-like tokens (keys, `Bearer` tokens, `password=…` style pairs, also inside a longer name such as `DB_PASSWORD=…`, `--password …` style flags, `-u user:password` and `-u user -p password` on a command line, and long random strings), your home folder (as `~`) and your names (as `[name]`) are replaced, and long text is cut. A compaction shows no text: neither its summary nor the reply that holds it. This covers those patterns; it isn't a guarantee that text you or an agent wrote holds nothing private. **Mask names** hides the section. The setting is kept for the panel; turn it off to see only counts and timings.

## Families

A **family** is a coordinator session plus every session it started, directly or through its children, as linked in your logs. The Families view covers the whole range:

![Families view](/screenshots/screen-timeline-families.png)

- **What your families show**: the share of credits of the families where you stepped into a child against those with no input in their children, how many child sessions got a prompt or an answer from you, and how much the wide fan-outs used. These are observations, not causes.
- **KPIs**: families, child sessions, their share of credits and agent time, prompts you typed into children (and answers you gave in them), and the credits in the top three, or fewer when there are fewer families. Shares read — when no credits were logged.
- **Verdicts**: **No input in children** (no prompt or answer from you was recorded in any child in the range), **You stepped in** (you typed into a child, or answered its question or permission prompt), and **Wide fan-out** (8 or more child sessions at any depth, shown on top of the other verdict). Click a verdict to filter the list; the selection follows the filter.
- **The list** ranks families by credits, with the repository its members active in the range used (the coordinator's first when it is active; *+ N more* when there are others, the same in the detail and in the chat tool), their biggest children (✋ marks a child you typed into or answered in) and a running total of credits. Search by name or repository, sort, or set a minimum size (counting every member of the family, also those with no activity in the range).
- **The selected family** shows what the logs show about it in words, one habit to consider, its footprint, every session in tree order (members with no activity in the range or outside the sidebar selection are listed in italics, under a dashed rule with an inset mark, and aren't counted), and **Open on the Timeline**, which opens the day with most of its turns in the range, or, when no member started a turn in it, its first day with work, waiting or an answer there; it selects the coordinator when it has a lane that day, else the member with most turns that day.

## How sessions are linked

A session's parent is found from what the harness logged, never from how a message reads:

1. **Copilot App and Copilot CLI**: the session whose `create_session`, `open_pr_session` or `open_issue_session` call (also behind an MCP server prefix) returned the child: the `session_id` field, or the labelled ID or session link in its text, never another ID such as the project's. `create_session` always makes a new session. The parent logs the call twice, as the call itself (`tool.execution_start`) and as the app's request (`external_tool.requested`), in either order and sometimes only when it completes; the earlier of the two is when the parent requested the child, which is what the connector marks. The child's own log begins after that. `open_pr_session` and `open_issue_session` can open a session that already existed: a session that began more than 5 seconds before such a call isn't its child.
2. **Codex and OpenCode**: the parent thread or session the harness recorded.
3. Otherwise, the session that relayed a session's **first** message. Coordinators also receive relayed reports from their children, so later relayed messages never count, and a link that would make a loop is dropped.

Claude Code sub-agents are part of their parent session's lane.

**Forks** are your own branches of a conversation, so they aren't part of a family. A forked session's lane says *fork of* its source:

- **Codex** writes the source thread (`forked_from_id`) in the fork, and the fork's first token count already includes the source's; only the fork's own tokens are counted: the usage Codex logged for each of the fork's own responses (by thread and response ID), or, in builds that don't log it, its token counts less the part its first one inherited.
- **Claude Code** (`--fork-session`) starts the fork with the source's messages, copied with their IDs and their original, older times. A message that another session also holds, or that is more than a second older than the fork's first line, is a copy: it is counted once, in the session that holds it as its own, on every tab and in the export. The fork's source is the session that holds the latest copied message. When the fork's opening lines are missing, so its copies show no older time, a transcript that begins with the same prompts, in the same order, as another one copied them when the other logged those turns as they ran (Claude Code writes queue, API request and cost records beside a live turn; a fork copies only the conversation lines). When two sessions hold the same copied history equally, either could be the source, so the fork is linked to neither and its lane says the source can't be told from these logs; its copied prompts still count once, and its sub-agent turns stay with it, whatever order the logs are read in. Without that difference nothing says which side copied (which one went on, or is longer, is no proof: a source can go on after a fork that stopped), so neither is taken for a fork and both keep the shared turns; only the main conversation's prompts are compared, and a sub-agent's turns stay with the session that ran them (or count once when the fork holds the same ones). When no loaded session holds it, the lane says *fork of a session not in these logs*.
- **Copilot App and Copilot CLI** log only a fork count (`fork_count`), with no source session, so their forks aren't linked.

## Names, credits and privacy

- **Names and branches** come from Copilot App and Copilot CLI (`workspace.yaml`). Only names the file marks as given by you (`user_named: true`) are shown, and not even those when they repeat your first prompt or its first words, however few (a name that ends inside a word of the prompt doesn't repeat it): an automatic title often is your prompt, so it and any name of unknown origin read *Untitled … session N*. Before a name, branch, repository or model is shown, links, email addresses, drive, network and absolute paths (quoted ones whole; an unquoted one with spaces up to its first word with a file extension, else up to the next path or the end of the clause), your OS account name and your GitHub handle are removed. An OS account name shorter than three characters is left as it is, since it would match ordinary words; a signed-in GitHub handle of any length is still removed as a branch's first word. A branch loses a first word that is your signed-in GitHub handle; your OS account name in a branch reads `[name]` where it stands, so the branch never passes for its topic alone. Generic account names such as `vscode`, `node` or `root` are ordinary words and stay. A repository named only after you reads *personal repository*. This covers the patterns above; it isn't a guarantee that free text you typed into a name holds nothing personal.
- **Mask names** replaces session names with *Session N*, hides branches, replaces repositories and every model name with letters (*Repository A*, *Model A*; a model name can be a deployment you named, even behind a provider's prefix), hides the prompts and questions in the lane's details, and clears and turns off both search boxes while it is on. It covers the Timeline page only: the sidebar still shows the workspace you picked, and the summary export isn't masked.
- **Copilot CLI or Copilot App**: `workspace.yaml` `client_name` tells them apart. Without that file the log holds no client field, and such a session is labelled *Copilot App*.
- **Credits** are the AI credits Copilot App and Copilot CLI log for each model call, sub-agents included. Other harnesses show time and turns.
- The dashboard runs locally from your session logs, read-only. The lanes, cards, callouts and the Families view show no prompt text; only **Show prompts and questions** in a lane's details does, for that lane. Names that repeat a first prompt are withheld (above), but a name you gave holds whatever words you typed into it.

Ask `@aicoach` about autonomy and delegation: the `aiEngineerCoach_timeline` tool returns the same KPIs, callouts and family verdicts for the chat model to read, with session and repository names always masked and no branches; the Timeline page is where names appear. It checks that dates are real calendar dates and reports the range you asked for apart from the days it found. The summary export adds an **Autonomy and Delegation** section with counts only.
