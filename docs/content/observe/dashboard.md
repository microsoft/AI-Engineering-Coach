---
title: "Dashboard"
weight: 10
description: "Your AI-assisted development overview at a glance"
---

# Dashboard

The Dashboard is the landing page of AI Engineer Coach. It brings together the most important metrics and recommendations into a single view.

![AI Engineer Coach Dashboard](/screenshots/screen-dashboard.png)

During **Sync Sessions**, one animated progress screen stays visible until parsing and initial
analysis finish. The dashboard then shows activity data and practice scores together.
Sync also starts a fresh scan when the dashboard was closed.

### While it loads

Each tile in the background is one session log; tiles fill in as they are read. The card in the
middle shows:

- **The current step** and a percentage that only moves forward, with a six-step bar whose active
  step fills as it progresses.
- **What is being read**: "Workspace N of T" with the folder name only, never the full path.
- **Time**: elapsed time, and "about N s left" once a few seconds of progress exist. The estimate
  comes from the recent pace, so treat it as approximate.
- **Found so far**: sessions, prompts, tool calls, lines written by AI and files touched.
- **Health**: parse worker heap use against its limit (amber from 65%, red from 85%) and files that
  could not be read.

On later opens, cached sessions load first. Copilot CLI and App sessions are never cached, so they
are read again on every open; the card names this step and counts the sessions.

**Show details** adds step timings, heap and throughput over time, worker CPU and memory, and a
table of the most recent 200 folders read, with **Slow** (over 2 seconds) and **Skipped** filters.
Paths there start with `~` instead of your home folder; files that could not be read are listed with
their full path in the "AI Engineer Coach" output channel. **Copy diagnostics** copies counts, timings and these
shortened paths, never session content. The panel remembers whether details were open.

When a load takes longer than 0.4 seconds, a short summary appears before the dashboard
opens. With reduced motion turned on in your system settings, the screen does not animate.

## Practice Scores

Five score cards are displayed at the top of the dashboard, each computed from the anti-pattern detection system:

| Score | What it measures |
|---|---|
| **Prompt Quality** | How well you provide context to the AI (file references, open editors, specificity) |
| **Session Hygiene** | Whether you start fresh sessions, avoid overly long conversations, and use devcontainers |
| **Code Review** | How carefully you review, validate, and sandbox AI-generated output |
| **Tool Mastery** | How broadly you use available AI features (slash commands, plan mode, model selection) |
| **Context Management** | How efficiently your sessions use the available context window |

Each score ranges from 0 to 100 and includes week-over-week and month-over-month trend indicators. Clicking a card navigates to the detailed Anti-Patterns view for that category.

## Skill Finder

The dashboard includes an inline preview of the Skill Finder. It scans your prompt history for repeated patterns and surfaces two types of findings:

- **Custom Opportunities** -- Repeated prompts that could be turned into reusable skills or instructions
- **Community Matches** -- Matching picks from the community-maintained skill catalog

## Daily Activity

A bar chart shows requests, sessions, lines of code, and active workspaces over the selected time range. Tabs let you switch between these metrics. Below the chart, donut charts break down activity by workspace and by harness (VS Code, Claude, etc.).
