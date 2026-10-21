---
title: "Anti-Patterns"
weight: 10
description: "Detect and fix bad habits in your AI-assisted workflow"
---

# Anti-Patterns

The Anti-Patterns page is the core improvement engine of AI Engineer Coach. It runs a set of detection rules across your session data and produces scored findings with actionable recommendations.

![Anti-Patterns View](/screenshots/screen-antipatterns.png)

## Rule Engine

Anti-pattern detection is powered by an editable rule engine. Every detector is a self-contained markdown file with YAML frontmatter and a `Detection Logic` block written in a small domain-specific language (DSL). AI Engineer Coach ships 45 built-in rules spanning prompt-quality, session-hygiene, code-review, tool-mastery, and context-management. You can:

- Edit a rule's thresholds, description, and detection logic directly from the [Rule Editor](/improve/rule-editor/).
- Write a brand-new rule in natural language and let the AI builder scaffold the markdown and DSL for you.
- Live-test any rule against your own data, including threshold sliders for quick tuning.
- Drill into a **rule coverage heatmap** showing how each rule triggered across your workspaces.

## Score Categories

Five practice categories are evaluated, each scored from 0 to 100:

### Prompt Quality

Measures how well you provide context to the AI. Representative rules:

- **Missing File Context** -- Requests that do not reference files with `#file` or have open editors
- **Lazy Prompting** -- Short, unspecific requests that produce generic responses
- **Caps Lock Rage** -- Requests written mostly in CAPS indicating frustration
- **Profanity / Hostile Language / Frustration Signals** -- Sentiment-based rules that highlight breakdowns in the human-AI loop
- **Curiosity Balance** -- Three activity-balance levels: Balanced, Needs review, and Strongly skewed
- **Repeated Inquiry Wording** -- Exact normalized questions repeated across sessions, without inferring poor retention

### Session Hygiene

Evaluates how you manage your coding sessions:

- **Mega Sessions / Abandoned Sessions / Session Drift** -- Flag sessions that run too long, stop abruptly, or drift across unrelated topics
- **Late-Night Coding / Weekend Overwork** -- Detect overwork patterns
- **Repeated Prompts** -- Surface near-duplicate prompts that suggest your context isn't landing

### Code Review

Assesses how carefully you handle AI-generated output:

- **Auto-Approve Terminal** -- Terminal commands being auto-executed without a devcontainer
- **Speed Accept / Copy-Paste Blindness** -- Accept-heavy patterns that suggest minimal review
- **YOLO Mode / No Devcontainer** -- Unsafe execution sandboxes

### Tool Mastery

Evaluates how broadly you use available features:

- **No Slash Commands / No Plan Mode / Agentic No Tools** -- Underused productivity features
- **Premium Waste / Model Overreliance** -- Using expensive models for simple questions
- **No Skills / No Custom Instructions** -- Gaps in your context-engineering setup

### Context Management

Evaluates how efficiently your sessions use the context window:

- **Context Window Saturation** -- Sessions where the context window is nearly full
- **Compaction Storms** -- Frequent auto-compactions indicating sessions that run too long
- **Runaway Growth** -- Context size growing steadily without resolution

## Findings

Each finding includes:

- **PROBLEM** -- A description of what was detected, with specific counts
- **ACTION** -- A concrete recommendation for how to fix it
- **Examples** -- Expandable section showing real examples from your sessions

## Trends

Week-over-week (WoW) and month-over-month (MoM) trend indicators appear on each score card, so you can see whether your practices are improving or regressing.

## Curiosity checks

Curiosity appears inside **Prompt Quality**, alongside the existing findings.
There is no separate Curiosity tab. The Prompt Quality score card shows the
current level, and the **Curiosity checks** link on the
[Curiosity page](../measure/curiosity.md) opens this practice group.
The findings use the dashboard filters, not Curiosity's local date and language
selections.

For mixed coding work, the suggested ranges are **10-50% inquiry** and
**50-90% project work**, with **no more than 80% of inquiry turns from one
investigation type**. These are coaching defaults, not proven health standards.
Research-only and implementation-only periods can be intentional.

**Balanced** raises no balance finding. **Needs review** raises a medium-severity
finding when inquiry falls outside its suggested range or one inquiry type
exceeds 80%. **Strongly skewed** raises a high-severity finding when inquiry is
strictly below 5% or above 95%, or one inquiry type exceeds 95%.

Checks need **50 classified turns**, **seven active dates**, and **70% coverage**.
The investigation mix also needs **20 inquiry turns**. Smaller samples show the
ratios but no balance warning. Repeated wording is shown separately with an
example link; it does not prove poor retention.

Insufficient evidence is ungraded; it is not treated as Balanced. Repeated
wording is a separate low-severity finding and does not change the balance level.

Findings use the existing severity weights in the Prompt Quality score and
appear in the standard finding count, examples, and weekly trends. They are
native analysis checks, not editable DSL rules. Supporting examples describe
the aggregate evidence, not a violation by each individual message.
