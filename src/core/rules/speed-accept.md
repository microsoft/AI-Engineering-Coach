---
id: speed-accept
name: Speed Accept (No Review)
group: code-review
severity: high
scope: sessions
version: 2
tags: [review, speed, accept]
thresholds:
  minAiLoc: 20
  maxGapMs: 15000
  minOccurrences: 5
---

# Description
Detects instances where the next message you typed was sent within seconds of receiving large AI code blocks, indicating no time for review. A turn that an agent, autopilot or the harness sent right after the code doesn't count: it isn't you accepting the code.

# When Triggered
{{count}} times you typed the next message within {{extra.maxGapSec}}s of receiving {{extra.minAiLoc}}+ lines of AI code (avg {{extra.avgLoc}} LOC, avg {{extra.avgGap}}s gap). Not enough time to review.

# How to Improve
Take time to read AI-generated code before moving on. Review for correctness, security issues, and edge cases. A quick glance is not a review.

# Examples
{{extra.workspace}}: {{extra.aiLoc}} AI LOC, {{extra.gapSec}}s gap -> "{{message}}..."

# Detection Logic
```detect
scan: sessions
match: requestCount >= 2
aggregate: count
pairs: adjacentPairCount(allSessions, thresholds.minAiLoc, thresholds.maxGapMs)
emitCount: pairs.count
emitTotal: count
avgLoc: pairs.avgLoc
avgGap: pairs.avgGap
maxGapSec: round(thresholds.maxGapMs / 1000)
minAiLoc: thresholds.minAiLoc
check: pairs.count >= thresholds.minOccurrences
examples: {{workspaceName}}: speed-accept detected
```
