---
id: frustration-signals
name: Frustration Signals
group: prompt-quality
severity: medium
scope: requests
version: 2
tags: [prompt, frustration, caps, punctuation]
thresholds:
  capsRate: 0.4
  minWords: 3
  minReqs: 2
patterns:
  frustration: ["!{3,}", "\\?{3,}", "wtf|come on|why won't", "this is broken|doesn't work"]
---

# Description
Detects requests showing frustration indicators like excessive punctuation (!!!?, ???) or ALL CAPS writing.

# When Triggered
{{count}} requests show frustration indicators (excessive punctuation, ALL CAPS). This usually means the approach isn't working.

# How to Improve
When frustrated, step back and change strategy. Start a new session, rephrase the problem, or break it into smaller pieces instead of escalating the same prompt.

# Examples
"{{message}}"

# Detection Logic
```detect
scan: requests
match: messageLength >= 10 AND (matchesAny(messageText, patterns.frustration) OR capsWordRatio(messageText, thresholds.minWords) >= thresholds.capsRate)
aggregate: count
check: count >= thresholds.minReqs
examples: "{{messageText | truncate:80}}"
```

# Tests
```test
{messageText: "WHY WONT THIS WORK???!!!", messageLength: 25} -> triggered
{messageText: "Please refactor the auth module", messageLength: 31} -> clean
{messageText: "THIS IS SO BROKEN FIX IT NOW", messageLength: 28} -> triggered
{messageText: "Add error handling to the API endpoint", messageLength: 38} -> clean
{messageText: "please fix the config { a } now", messageLength: 31} -> clean
{messageText: "why does this still fail!!!", messageLength: 27} -> triggered
{messageText: "what is going on here???", messageLength: 24} -> triggered
```
