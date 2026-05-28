---
title: "Dashboard"
weight: 10
description: "Your AI-assisted development overview at a glance"
---

# Dashboard

The Dashboard is the landing page of AI Engineer Coach. It brings together the most important metrics and recommendations into a single view.

![AI Engineer Coach Dashboard](/screenshots/screen-dashboard.png)

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

If you use Team Mode, the local Team Dashboard can group those same coaching signals by day, week, or month and can switch between category-only and expanded practice-group detail without rerunning analysis.

## Skill Finder

The dashboard includes an inline preview of the Skill Finder. It scans your prompt history for repeated patterns and surfaces two types of findings:

- **Custom Opportunities** -- Repeated prompts that could be turned into reusable skills or instructions
- **Community Matches** -- Matching picks from the community-maintained skill catalog

## Daily Activity

A bar chart shows requests, sessions, lines of code, and active workspaces over the selected time range. Tabs let you switch between these metrics. Below the chart, donut charts break down activity by workspace and by harness (VS Code, Claude, etc.).
