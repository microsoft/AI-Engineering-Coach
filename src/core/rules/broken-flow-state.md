---
id: broken-flow-state
name: Broken Flow State
group: session-hygiene
severity: medium
scope: sessions
version: 2
tags: [session, flow, focus, interruptions]
thresholds:
  rapidFollowupSec: 30
  sessionMinReqs: 3
  shallowScore: 25
  lowScoreRate: 0.6
  minDays: 5
---

# Description
Detects fragmented coding flow with long pauses between prompts, indicating frequent context switches, interruptions, or multitasking. Only prompts you typed count. A pause runs from the end of the assistant's work, including turns that an agent, autopilot or a still-running sub-agent sent, to your next prompt.

# When Triggered
{{count}}/{{extra.totalDays}} days ({{pct}}) show fragmented flow -- long pauses between prompts, short scattered work blocks.
Average flow score: {{extra.avgScore}}/100.
This anti-pattern indicates frequent context switches, interruptions, or multitasking that prevent deep coding flow.

# How to Improve
Block 2+ hour uninterrupted time slots for AI-assisted coding.
Close Slack / email / notifications during coding sessions.
Pre-plan your next prompt while the agent works on the current one.
Batch meetings to protect contiguous coding blocks.
Use the Flow State page to find your most productive hours.

# Examples
{{extra.date}}: avg flow score {{extra.flowScore}}/100

# Detection Logic
```detect
scan: sessions
match: requestCount >= thresholds.sessionMinReqs
aggregate: count
flow: flowScoreStats(allSessions, thresholds.sessionMinReqs, thresholds.rapidFollowupSec * 1000)
emitCount: flow.fragmentedDays
emitTotal: flow.totalDays
totalDays: flow.totalDays
avgScore: flow.avgScore
check: flow.lowScoreRate > thresholds.lowScoreRate AND flow.totalDays >= thresholds.minDays
severity: flow.lowScoreRate > 0.8
examples: {{workspaceName}}: flow disruption detected
```
