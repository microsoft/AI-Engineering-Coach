# Authoring Rules and Metrics

Detection rules and metrics are the primary extensibility surface of AI Engineer Coach. Every rule
and metric is a self-contained markdown file with YAML frontmatter and a small DSL — no code changes
required to ship a new one.

This guide covers contributing a built-in rule or metric to this repository. For the in-extension
authoring flow (live-test, threshold sliders, AI-assisted drafting), see the
[Rule Editor guide](https://microsoft.github.io/AI-Engineering-Coach/improve/rule-editor/).

## Where rules and metrics live

| Layer | Location | Trust | Use when |
|---|---|---|---|
| Built-in | [`src/core/rules/`](../src/core/rules/), [`src/core/metrics/`](../src/core/metrics/) | Trusted | Contributing a rule for everyone via this repo |
| Personal | `~/.ai-engineer-coach/rules/`, `~/.ai-engineer-coach/metrics/` | Prompted on first load | Private rules shared across all your workspaces |
| Project | `<workspace>/.ai-engineer-coach/rules/`, `<workspace>/.ai-engineer-coach/metrics/` | Prompted on first load | Workspace-specific rules checked into a repo |

Personal and project rules follow the same file format as built-in rules but are loaded at runtime
through the trust gate in [`src/core/rule-trust.ts`](../src/core/rule-trust.ts).

For the full DSL reference — field schema, function catalog, and metric primitives — open the
**DSL Reference** modal inside the extension (Rule Editor → DSL Reference) or the
[Rule Playground](https://microsoft.github.io/AI-Engineering-Coach/improve/rule-playground/).

## Anatomy of a rule

A rule file lives at `src/core/rules/<rule-id>.md`. Below is
[`lazy-prompting.md`](../src/core/rules/lazy-prompting.md) annotated section by section:

````markdown
---
id: lazy-prompting              # Stable identifier, must match the filename
name: Lazy Prompting             # Human-readable name shown in the UI
group: prompt-quality            # Practice category: prompt-quality | session-hygiene |
                                 #   code-review | tool-mastery | context-management
severity: medium                 # low | medium | high — drives score weighting
scope: requests                  # requests (per-message) or sessions (per-session)
version: 1                       # Bump when changing detection logic
tags: [prompt, quality, short]   # Free-form tags surfaced in the rule filter
thresholds:                      # Tunable knobs. Referenced as thresholds.<name> in DSL.
  minChars: 30                   #   Sliders for these appear in the Rule Editor.
  maxRatio: 0.3
  minSample: 10
---

# Description
Short, user-facing summary of what this rule detects.

# When Triggered
One-line finding text. Supports template variables: {{count}}, {{total}}, {{pct}},
and anything you emit via extra.<key> in the detection logic.

# How to Improve
Concrete, actionable recommendation shown alongside the finding.

# Examples
Template for the per-occurrence example list. {{message}} and any field on the
matched row (e.g. {{extra.charCount}}) are available.

# Detection Logic
```detect
scan: requests                                    # What to iterate over
match: messageLength < thresholds.minChars        # Predicate; uses field schema
       AND messageLength > 0                      #   + thresholds.* + DSL helpers
aggregate: ratio                                  # count | ratio | sum | someWhere | ...
check: ratio > thresholds.maxRatio                # The trigger condition
       AND count > thresholds.minSample
examples: "{{messageText | truncate:80}}" ({{messageLength}} chars)
```

# Tests
```test
{messageText: "fix bug", messageLength: 7} -> triggered
{messageText: "Refactor the authentication middleware to use JWT tokens", messageLength: 60} -> clean
{messageText: "", messageLength: 0} -> clean
```
````

The `# Tests` block is optional but strongly encouraged — each line is a synthetic row evaluated
against the rule. Tests run as part of the standard `npm test` suite.

## Anatomy of a metric

Metrics are simpler than rules — they emit a single named value that rules and dashboards can
consume. A metric file lives at `src/core/metrics/<metric-id>.metric.md`. Below is
[`weekend-requests.metric.md`](../src/core/metrics/weekend-requests.metric.md):

```markdown
---
id: weekend-requests             # Stable identifier; reference as metrics.weekendRequests
name: Weekend Requests
scope: requests                  # requests or sessions
version: 1
tags: [wellbeing, time]
---

# Filter
dayOfWeek(timestamp) == 0 OR dayOfWeek(timestamp) == 6   # Predicate over the scope

# Metric
ratio                            # Aggregation: count | ratio | sum | avg

# Examples
{{messageText | truncate:60}} ({{dayOfWeek(timestamp)}})
```

Once defined, a metric is automatically available in the Rule Playground metric list and can be
referenced from any rule's detection logic.

## Local testing workflow

Before opening a pull request:

1. **Install and build**
   ```bash
   npm install
   npm run build
   ```
2. **Run the rule and metric tests** — these load every markdown file under `src/core/rules/` and
   `src/core/metrics/`, validate the frontmatter, and execute any `# Tests` blocks:
   ```bash
   npm test
   ```
3. **Live-test against your own data.** Launch the extension in the VS Code Extension Development
   Host (`F5`), open the **Rule Editor**, find your new rule, and click **Test Rule**. Use the
   threshold sliders to sweep values without re-editing the markdown.
4. **Prototype DSL expressions** in the **Rule Playground** before committing them — it shares the
   same runtime as the rule engine, so anything that evaluates there will behave identically in a
   rule.
5. **Lint**
   ```bash
   npm run lint
   ```

## References

- Built-in rules: [`src/core/rules/`](../src/core/rules/) — 45 worked examples across all categories
- Built-in metrics: [`src/core/metrics/`](../src/core/metrics/)
- A minimal rule with tests: [`src/core/rules/lazy-prompting.md`](../src/core/rules/lazy-prompting.md)
- A rule using a custom aggregator and `extra.*` fields: [`src/core/rules/yolo-mode.md`](../src/core/rules/yolo-mode.md)
- A minimal metric: [`src/core/metrics/weekend-requests.metric.md`](../src/core/metrics/weekend-requests.metric.md)
- Anti-Patterns overview: [content/improve/anti-patterns.md](content/improve/anti-patterns.md)
- Rule Editor guide: [content/improve/rule-editor.md](content/improve/rule-editor.md)
- Rule Playground guide: [content/improve/rule-playground.md](content/improve/rule-playground.md)
