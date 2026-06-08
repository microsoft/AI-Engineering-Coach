---
title: "Share"
weight: 40
description: "Generate shareable stat cards"
---

# Share

The Share page lets you generate a visual stat card summarizing your AI coding activity. You can share it with your team or save it as a personal record.

![Share Stats](/screenshots/screen-share.png)

## Stat Card Contents

The generated card includes:

- **AI Lines of Code** -- Total estimated LoC
- **Current Streak** -- Consecutive active days
- **Flow Score** -- How well you maintain focused coding sessions
- **Sessions** -- Total session count
- **Best Streak** -- Your all-time longest streak
- **Requests** -- Total requests sent
- **Top Languages** -- Your most-used programming languages, shown as colored tags
- **Active workspace** and **date** at the bottom

## Export Options

Four actions are available:

- **Download PNG** -- Save the card as an image file
- **Copy to Clipboard** -- Copy the card image to your clipboard for pasting
- **Export Summary** -- Save a Markdown report and matching JSON data file for archiving or sharing
- **Refresh** -- Regenerate the card with current data

The command palette also includes **AI Engineer Coach: Export Full Context Pack**. This writes a deeper Markdown/JSON context pack for ChatGPT or a VS Code coding agent:

- **Safe Context Pack** -- Includes all analytical findings, anti-pattern details, context health, repeated workflow opportunities, and session metadata without raw prompt/response turns.
- **Full Raw Context Pack** -- Includes the Safe data plus bounded raw prompt/response excerpts from recent sessions.
