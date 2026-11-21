---
id: late-night-coding
name: Late-Night Coding
group: session-hygiene
severity: low
scope: requests
version: 2
tags: [session, health, hours]
thresholds:
  lateNightHour: 5
  minSample: 10
---

# Description
Detects prompts you typed between midnight and early morning. Late-night coding correlates with more bugs and lower quality output. Turns that an agent, autopilot, the harness or a parent agent sent don't count: they say when your agents ran, not when you worked.

# When Triggered
You typed {{count}} prompts between midnight and {{extra.lateNightHour}}am. Late-night coding correlates with more bugs and lower quality.

# How to Improve
Consider establishing healthier work hours. Quality drops significantly when fatigued.

# Examples
{{extra.timestamp}}: "{{message}}..."

# Detection Logic
```detect
scan: requests
match: humanTurn == true AND timestamp > 0 AND hour(timestamp) >= 0 AND hour(timestamp) < thresholds.lateNightHour
aggregate: count
check: count > thresholds.minSample
examples: "{{messageText | truncate:50}}"
```

# Tests
```test
{timestamp: "2026-01-14T02:00:00"} -> triggered
{timestamp: "2026-01-14T00:30:00", messageText: "fix the failing build"} -> triggered
{timestamp: "2026-01-14T02:00:00", nonHumanKind: "autopilot"} -> clean
{timestamp: "2026-01-14T02:00:00", nonHumanKind: "relayed"} -> clean
{timestamp: "2026-01-14T02:00:00", humanTurn: false} -> clean
{timestamp: "2026-01-14T05:00:00"} -> clean
{timestamp: "2026-01-14T12:00:00"} -> clean
```
