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
[`lazy-prompting.md`](../src/core/rules/lazy-prompting.md) annotated section by section. In the
front matter, a comment is a whole line that starts with `#`: after a value, a `#` and the rest of
the line are read as part of the value.

````markdown
---
# Stable identifier, must match the filename
id: lazy-prompting
# Human-readable name shown in the UI
name: Lazy Prompting
# Practice category: prompt-quality | session-hygiene | code-review | tool-mastery | context-management
group: prompt-quality
# low | medium | high — drives score weighting
severity: medium
# requests (per-message) or sessions (per-session)
scope: requests
# Bump when changing detection logic
version: 1
# Free-form tags surfaced in the rule filter
tags: [prompt, quality, short]
# Tunable knobs, referenced as thresholds.<name> in the detection logic.
# Sliders for these appear in the Rule Editor.
thresholds:
  minChars: 30
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
The DSL has no comments. In the block below, scan sets what to iterate over, match is the predicate
(fields, thresholds.* and DSL helpers), aggregate is count or ratio, and check is the trigger
condition. A line that ends with a backslash continues on the next line.
```detect
scan: requests
match: messageLength < thresholds.minChars \
       AND messageLength > 0
aggregate: ratio
check: ratio > thresholds.maxRatio \
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
[`weekend-requests.metric.md`](../src/core/metrics/weekend-requests.metric.md), with its front
matter comments on their own lines. `# Filter` is a predicate over the scope, and `# Metric` is the
aggregation: count, ratio, sum or avg.

```markdown
---
# Stable identifier; reference as metrics.weekendRequests
id: weekend-requests
name: Weekend Requests
# requests or sessions
scope: requests
version: 1
tags: [wellbeing, time]
---

# Filter
dayOfWeek(timestamp) == 0 OR dayOfWeek(timestamp) == 6

# Metric
ratio

# Examples
{{messageText | truncate:60}} ({{dayOfWeek(timestamp)}})
```

Once defined, a metric is automatically available in the Rule Playground metric list and can be
referenced from any rule's detection logic.

## Patterns

A rule can keep its regular expressions in front matter under `patterns:` and use them as
`patterns.<name>` in its detection logic. Every entry is an array of strings, even one written as a
single string:

```yaml
patterns:
  frustration: ["!{3,}", "\\?{3,}", "wtf|come on|why won't"]
  headings: "(?m)^#+\\s"
```

Rule and metric front matter reads values this way:

- A list splits on commas outside quotes. Quote any item that contains a comma: `"!{3,}"` is one
  item, but an unquoted `!{3,}` becomes the two items `!{3` and `}`.
- In double quotes, `\\` is one backslash and `\"` is a double quote. Any other backslash stays as
  written, so `"\\d"` and `"\d"` are both `\d`. YAML escapes such as `\n` and `\t` aren't processed.
- In single quotes, `''` is one single quote, and a backslash is always literal.
- An unquoted value is used as written. If a quote is never closed, the value is read the old way: a
  list splits on every comma, and a rule file drops one quote character from each end of a value.
- A pattern can start with inline flags such as `(?i)` or `(?m)`.

These functions take one pattern or an array of patterns, and match when any pattern matches:
`matches(text, pattern)`, `matchesAny(text, patterns)`, `anyMatch(strings, pattern)` (1 or 0),
`hasSkillByPattern(reqs, pattern)` (1 or 0), and the `"matches"` operator of `countWhere`, `anyWhere`,
`someWhere` and `flatSomeWhere`. An empty array, an empty pattern and a value that isn't a string
match nothing, so an entry written as `[]` or left blank never matches. A regex literal such as
`/^fix/i` works only in `matches()`; elsewhere, write `"(?i)^fix"`.

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
