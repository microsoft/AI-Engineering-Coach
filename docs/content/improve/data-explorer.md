---
title: "Data Explorer"
weight: 40
description: "Browse request and session fields with distributions"
---

# Data Explorer

The Data Explorer lets you inspect the raw data your rules run against. It is the fastest way to answer questions like "what values does this field actually take?" or "how many sessions had more than X requests?"

## Layout

The page shows two columns of fields -- one for `SessionRequest` and one for `Session`. Each field row reports:

- The field name and type
- A distribution summary (top values, min/max, or counts where appropriate)
- The sample size (how many rows contain a non-empty value)

All distributions respect the active date and workspace filters, so you can compare datasets across different slices without leaving the page.

Request fields show the rows rules evaluate, so they include the fields derived for rules. `humanTurn` shows how many turns you typed (`true`) and how many the harness logged as sent by another agent, autopilot, a parent agent or the harness itself (`false`).

## Use it when you are

- **Designing a rule** -- Check that the field you want to key off is actually populated for your harness
- **Debugging a false positive** -- See the real distribution of a threshold before deciding where to set it
- **Exploring harness differences** -- Flip between workspaces or harnesses to see which features show up where
