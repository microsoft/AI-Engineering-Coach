---
id: repeated-prompts
name: Repeated Prompts
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [prompt, duplicate, waste]
thresholds:
  minDuplicates: 3
  minPromptLength: 20
  highThreshold: 20
---

# Description
Detects near-duplicate prompts that waste quota without producing new results.

# When Triggered
{{count}} requests are near-duplicates across {{extra.distinctCount}} distinct prompts. This wastes quota without new results.

# How to Improve
If a prompt isn't working, rephrase it or provide more context instead of retrying the same message.

# Examples
"{{message}}..." (repeated {{extra.repeatCount}}x)

# Detection Logic
```detect
scan: requests
match: messageLength >= thresholds.minPromptLength AND NOT contains(messageText, "[$") AND NOT startsWith(messageText, "Репозиторий:") AND NOT startsWith(messageText, "Repository:") AND NOT contains(messageText, "AGENTS.md")
aggregate: count
dupes: duplicateGroups(matched, thresholds.minPromptLength, thresholds.minDuplicates)
emitCount: dupes.totalDupes
emitTotal: total
distinctCount: dupes.distinctCount
check: dupes.totalDupes >= thresholds.minDuplicates
severity: dupes.totalDupes > thresholds.highThreshold
examples: "{{messageText | truncate:60}}"
```
