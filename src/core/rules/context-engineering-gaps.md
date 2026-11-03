---
id: context-engineering-gaps
name: Context Engineering Gaps
group: prompt-quality
severity: medium
scope: both
version: 2
tags: [context, agents, skills, mcp, instructions]
thresholds:
  minReqs: 30
  fileRefMinRate: 0.1
  instructionMinRate: 0.05
---

# Description
Audits your context engineering setup: custom agents, skills, MCP tools, file references, and custom instructions. Missing components limit AI effectiveness. Only VS Code (Local Agent) logs which instruction files were active, so the custom-instructions signal counts VS Code requests only, and without them it's left out of the total.

# When Triggered
{{count}} of {{total}} context engineering signals missing. Your AI lacks the context to be maximally effective.

# How to Improve
Level up your context engineering: create AGENTS.md for custom agents, SKILL.md for domain knowledge, connect MCP tools, use #file references, and add .instructions.md with project conventions.

# Examples
{{extra.gapCount}} of {{extra.signalCount}} context engineering signals missing

# Detection Logic
```detect
scan: requests
match: true
aggregate: count
reqCount: count
hasSubAgents: someWhere(allReqs, "agentName", "!=", "") AND \
  someWhere(allReqs, "agentName", "!=", "copilot") AND \
  someWhere(allReqs, "agentMode", "agent")
hasSkills: flatCount(allReqs, "skillsUsed") > 0
hasMcp: flatSomeWhere(allReqs, "toolsUsed", ".", "mcp_", "startsWith")
fileRefRate: countWhere(allReqs, "referencedFiles.length", ">", 0) / reqCount
instrReportedReqs: countWhere(allReqs, "harness", "matches", "^Local Agent")
instrRate: countWhere(allReqs, "customInstructions.length", ">", 0) / instrReportedReqs
gap1: hasSubAgents == 0
gap2: hasSkills == 0
gap3: hasMcp == 0
gap4: fileRefRate < thresholds.fileRefMinRate
gap5: instrReportedReqs > 0 AND instrRate < thresholds.instructionMinRate
gapCount: gap1 + gap2 + gap3 + gap4 + gap5
signalCount: 4 + (instrReportedReqs > 0)
emitCount: gapCount
emitTotal: signalCount
check: gapCount > 0 AND reqCount >= thresholds.minReqs
severity: gapCount >= 4
```

# Tests
```test
{harness: "Local Agent"} -> triggered
{harness: "Claude"} -> triggered
{harness: "Local Agent", agentName: "reviewer", agentMode: "agent", skillsUsed: ["pdf"], toolsUsed: ["mcp_github_search"], referencedFiles: ["src/app.ts"]} -> triggered
{harness: "Local Agent (Insiders)", agentName: "reviewer", agentMode: "agent", skillsUsed: ["pdf"], toolsUsed: ["mcp_github_search"], referencedFiles: ["src/app.ts"]} -> triggered
{harness: "Local Agent", agentName: "reviewer", agentMode: "agent", skillsUsed: ["pdf"], toolsUsed: ["mcp_github_search"], referencedFiles: ["src/app.ts"], customInstructions: [".github/copilot-instructions.md"]} -> clean
{harness: "Claude", agentName: "reviewer", agentMode: "agent", skillsUsed: ["pdf"], toolsUsed: ["mcp_github_search"], referencedFiles: ["src/app.ts"]} -> clean
{harness: "GitHub Copilot CLI", agentName: "reviewer", agentMode: "agent", toolsUsed: ["mcp_github_search"], referencedFiles: ["src/app.ts"]} -> triggered
```
