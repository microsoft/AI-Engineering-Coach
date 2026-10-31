---
title: "Rule Editor"
weight: 20
description: "Create, edit, and live-test detection rules as markdown"
---

# Rule Editor

The Rule Editor turns anti-pattern detection into an open, editable system. Every rule is a markdown file with YAML frontmatter and a `Detection Logic` block in a small DSL. You can ship new rules without recompiling the extension, tune thresholds for your team, and draft rules in natural language.

## Layout

The page lists every rule grouped by practice category. Each row shows the rule name, group, severity, scope (requests or sessions), and a layer badge indicating whether the rule is built-in, a user override, or a fresh user-authored rule stored under `.ai-engineer-coach/rules/` in your home directory or workspace root.

Use the filter bar to search by tag or group, and click any rule to open its detail view.

## Editing a Rule

Click **Edit** on any rule to open the modal editor. The editor has two tabs:

| Tab | Purpose |
|---|---|
| **Form** | Fill in structured fields -- id, name, group, severity, scope, tags, thresholds, description, examples, and detection logic |
| **Source** | View or edit the full markdown file directly. Useful for advanced edits or for pasting in rules from elsewhere |

Switching tabs syncs both directions, so you can round-trip between the form and the raw source.

## Live Testing

Click **Test Rule** to run the current draft against your real session data using the active date and workspace filters. The result panel shows:

- Whether the rule triggered
- The occurrence count, sample size, and triggered percentage
- The generated description, suggestion, and up to a handful of real examples

Threshold sliders appear above the result so you can sweep a value without retyping the markdown. Changes are applied to the draft in memory; nothing is persisted until you hit **Save**.

## AI Builder

Use the **Generate** button to describe the rule you want in natural language. The AI builder drafts a complete markdown rule -- frontmatter, detection logic, examples -- and loads it into the editor. The generator retries automatically if it produces invalid DSL. You can always review the output before saving.

## Rule Coverage

Back on the Anti-Patterns page, the coverage heatmap shows which rules triggered in which workspaces. Darker cells mean more occurrences. The header row, rule column, and total column stay pinned as you scroll through wide result sets.

## DSL Cheatsheet

A rule's `Detection Logic` block uses a small pipeline DSL:

```
scan: requests
match: messageLength < thresholds.minChars AND messageLength > 0
aggregate: ratio
check: ratio > thresholds.maxRatio AND count > thresholds.minSample
examples: "{{messageText | truncate:80}}" ({{messageLength}} chars)
```

The full function catalog, field schema, and metric list are browsable inside the [Rule Playground](/improve/rule-playground/) or via the **DSL Reference** modal (accessible from both Rule Editor and Rule Playground). The DSL Reference includes four tabs: Fields, Functions, Metrics, and Parser Coverage (showing which fields each harness parser can populate).

Request rows also carry their session's `harness`, so a rule can count only requests from the harnesses that log the field it reads. For example, only VS Code logs custom instructions:

```
match: startsWith(harness, "Local Agent") AND customInstructions.length == 0
```
