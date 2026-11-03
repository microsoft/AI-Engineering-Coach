---
id: weekend-overwork
name: Weekend Overwork
group: session-hygiene
severity: low
scope: requests
version: 2
tags: [session, health, weekend]
thresholds:
  maxWeekendRate: 0.25
  minWeekendReqs: 20
---

# Description
Detects a high proportion of the prompts you type happening on weekends, which may indicate work-life balance issues. Only prompts you typed count, in both the weekend count and the total: turns that an agent, autopilot, the harness or a parent agent sent say when your agents ran, not when you worked.

# When Triggered
You typed {{count}} prompts ({{pct}}) on weekends. This may indicate work-life balance issues.

# How to Improve
Consider maintaining boundaries between work and personal time. Sustained overwork leads to burnout and decreased productivity.

# Examples
{{extra.weekendReqs}} weekend prompts vs {{extra.weekdayReqs}} weekday prompts

# Detection Logic
```detect
scan: requests
match: humanTurn == true AND timestamp > 0 AND (dayOfWeek(timestamp) == 0 OR dayOfWeek(timestamp) == 6)
aggregate: ratio
typedReqs: countWhere(all, "humanTurn", "==", true)
weekendReqs: count
weekdayReqs: typedReqs - count
emitTotal: typedReqs
check: ratio > thresholds.maxWeekendRate AND count > thresholds.minWeekendReqs
examples: "{{messageText | truncate:50}}"
```

# Tests
```test
{timestamp: "2026-01-17T12:00:00"} -> triggered
{timestamp: "2026-01-18T22:00:00"} -> triggered
{timestamp: "2026-01-17T12:00:00", nonHumanKind: "agent"} -> clean
{timestamp: "2026-01-17T12:00:00", humanTurn: false} -> clean
{timestamp: "2026-01-16T12:00:00"} -> clean
```
