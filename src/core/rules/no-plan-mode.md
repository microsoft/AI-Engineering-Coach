---
id: no-plan-mode
name: Never Uses Plan Mode
group: tool-mastery
severity: medium
scope: requests
requiresIdeContext: true
version: 2
tags: [tools, planning, agent]
thresholds:
  minReqs: 30
  agentRate: 0.3
---

# Description
Detects heavy agentic usage with no use of plan mode, which helps the agent understand scope before implementation. Only requests from harnesses that log plan mode count: VS Code (Local Agent), GitHub Copilot CLI and App, and OpenCode. Claude Code, Codex and Xcode logs don't record it, so their requests are left out.

# When Triggered
{{extra.agenticReqs}} agentic requests but no use of plan mode. Jumping straight to implementation often leads to wrong approaches.

# How to Improve
Use plan mode (or /plan) before complex tasks. Planning helps the agent understand scope, break down work, and avoid wasted iterations.

# Examples
Switch to Plan mode in the mode picker before starting large features
Use /plan to outline an approach before coding
Plan first, then switch to Agent mode to execute

# Detection Logic
```detect
scan: requests
match: matches(harness, "^(Local Agent|GitHub Copilot (CLI|App)$|OpenCode$)") AND (agentMode == "agent" OR agentName != "")
aggregate: count
planLoggedReqs: countWhere(all, "harness", "matches", "^(Local Agent|GitHub Copilot (CLI|App)$|OpenCode$)")
agentRatio: count / planLoggedReqs
planUsage: someWhere(all, "slashCommand", "plan") OR someWhere(all, "agentMode", "matches", "(?i)plan")
agenticReqs: count
emitTotal: planLoggedReqs
check: planUsage == 0 AND planLoggedReqs >= thresholds.minReqs AND agentRatio >= thresholds.agentRate
```

# Tests
```test
{harness: "Local Agent", agentName: "GitHub Copilot", agentMode: "agent"} -> triggered
{harness: "Local Agent (Insiders)", agentName: "GitHub Copilot", agentMode: "agent", slashCommand: "plan"} -> clean
{harness: "Local Agent", agentName: "GitHub Copilot", agentMode: "plan"} -> clean
{harness: "GitHub Copilot CLI", agentName: "GitHub Copilot CLI", agentMode: "agent"} -> triggered
{harness: "GitHub Copilot App", agentName: "GitHub Copilot App", agentMode: "plan"} -> clean
{harness: "OpenCode", agentName: "build", agentMode: "build"} -> triggered
{harness: "Claude", agentName: "Claude", agentMode: "agent"} -> clean
{harness: "Codex", agentName: "Codex", agentMode: "agent"} -> clean
```
