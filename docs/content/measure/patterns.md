---
title: "Activity Patterns"
weight: 30
description: "Work hours, calendar heatmaps, and per-project breakdowns"
---

# Activity Patterns

The Patterns page reveals when, where, and how you work with AI coding assistants.

## Which turns count

Activity Patterns measures your own working time, so it counts only the prompts you typed. Harnesses also log
"user" turns that you didn't type: messages from another agent or session, autopilot continuations, prompts a
parent agent gave a sub-agent, skill instructions, compaction summaries, command output and context the harness
added. Those turns show when your agents ran, not when you worked, so the page leaves them out. A note at the top
of each tab says how many prompts it counts and how many turns it left out; hover the ⓘ to see them by kind.

A turn counts as typed unless the harness recorded that something else sent it. A message that is only code, a
URL, a quote or an attachment, or a slash command you ran, still counts. The Dashboard, Timeline and Output pages
count every turn.

## Work Hours

![Work Hours Heatmap](/screenshots/screen-patterns-workhours.png)

The Work Hours tab shows a heatmap of your coding activity across the week. Each cell represents an hour-long slot on a specific day of the week, and the color intensity indicates how many focused prompts you typed during that time.

Below the heatmap, two charts compare weekday vs. weekend activity:

- **Hourly distribution** -- When during the day you are most active, split by weekday and weekend
- **Weekly volume** -- The prompts you typed per week, split by weekday and weekend

These patterns help you identify your peak focus hours and understand your work-life balance with AI tools.

## Calendar

The Calendar tab presents a GitHub-style contribution grid. Each day is a cell colored by the prompts you typed that day, so a day when only your agents ran stays empty. This gives you a long-range view of consistency and streaks.

## Projects

![Projects View](/screenshots/screen-patterns-projects.png)

The Projects tab breaks down activity by workspace. For each project, you see:

- **Estimated hours** of AI-assisted development, from the prompts you typed
- **Prompts** you typed
- **Estimated lines of code** generated, by every turn
- **Work pattern** (e.g., "mostly weekdays", "mostly weekends"), from the prompts you typed
- **Tech stack** tags detected from the files you worked on, in every turn
- **Hot files** -- The files most frequently edited in AI conversations, in every turn
- **Activity summary** table with key metrics

A project where you typed no prompts in the selected range isn't listed.

This view is valuable for understanding which projects consume the most AI resources and how your usage patterns differ across codebases.
