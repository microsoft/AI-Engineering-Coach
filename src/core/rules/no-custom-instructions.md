---
id: no-custom-instructions
name: No Custom Instructions
group: tool-mastery
severity: medium
scope: requests
requiresIdeContext: true
version: 2
tags: [tools, instructions, personalization]
thresholds:
  minRate: 0.05
  minReqs: 20
---

# Description
Detects when very few requests use custom instructions, missing out on personalized and project-specific responses. Only VS Code (Local Agent) logs which instruction files were active, so only its requests count; the rule never fires without them.

# When Triggered
Only {{extra.usagePct}}% of VS Code requests use custom instructions ({{extra.withInstructions}}/{{total}}). Missing out on personalized responses.

# How to Improve
Create a .github/copilot-instructions.md or .instructions.md file in your workspace to give Copilot persistent context about your project conventions, stack, and coding style.

# Examples
{{extra.withInstructions}} of {{total}} VS Code requests had custom instructions

# Detection Logic
```detect
scan: requests
match: startsWith(harness, "Local Agent") AND customInstructions.length == 0
aggregate: count
instrReportedReqs: countWhere(all, "harness", "matches", "^Local Agent")
withInstructions: instrReportedReqs - count
usageRate: withInstructions / instrReportedReqs
usagePct: round(usageRate * 100)
emitTotal: instrReportedReqs
check: usageRate < thresholds.minRate AND instrReportedReqs > thresholds.minReqs
```

# Tests
```test
{harness: "Local Agent", customInstructions: []} -> triggered
{harness: "Local Agent (Server)", customInstructions: []} -> triggered
{harness: "Local Agent", customInstructions: [".github/copilot-instructions.md"]} -> clean
{harness: "GitHub Copilot CLI", customInstructions: []} -> clean
{harness: "Claude", customInstructions: []} -> clean
{harness: "OpenCode", customInstructions: []} -> clean
```
