---
id: cache-hit-starvation
name: Prompt Cache Starvation
group: tool-mastery
severity: medium
scope: requests
version: 2
tags: [tokens, cache, context, cost]
thresholds:
  minPromptTokens: 5000
  minSample: 20
  minCacheRate: 0.1
---

# Description
Detects requests with large prompts (>5K input tokens) where almost none of the prompt is being served from the model's prompt cache. Low cache hit rates mean every request pays full price for the same prefixes — usually caused by churning instructions, frequent compaction, or unstable system prompts. Only requests whose harness reports cache usage count. `cacheReadTokens` and `cacheWriteTokens` are null when the harness doesn't report cache usage, as with VS Code chat logs, and those requests are never reported as starved. They are 0 when the harness reported no cache reads or writes, for example with prompt caching turned off, and those requests count as fully uncached.

# When Triggered
{{count}} requests had prompts >{{extra.minPromptTokens}} tokens but only {{extra.cachePctLabel}} of input tokens came from cache. Each long-prompt request is paying full price for context the model has seen before.

# How to Improve
Stabilize the front of your prompts: keep custom instructions short and stable, avoid frequent compaction, prefer file references over pasted code, and avoid clearing chat mid-task. Within a session, repeated prefixes get cached and re-used for free. The Prompt Cache tab in Context Health shows why the cache broke, when your harness logs it.

# Examples
{{promptTokens}} prompt tokens · {{coalesce(cacheReadTokens, 0)}} cached

# Detection Logic
```detect
scan: requests
match: promptTokens > thresholds.minPromptTokens AND (coalesce(cacheReadTokens, -1) >= 0 OR coalesce(cacheWriteTokens, -1) >= 0)
aggregate: count
totalPrompt: sumField(matched, "promptTokens")
totalCache: sumField(matched, "cacheReadTokens")
cacheRate: totalCache / totalPrompt
cachePctLabel: cacheRate | pct:1
emitCount: count
emitTotal: count
check: count > thresholds.minSample AND cacheRate < thresholds.minCacheRate
examples: {{promptTokens}} prompt tokens, {{coalesce(cacheReadTokens, 0)}} cached
```

# Tests
```test
{harness: "Claude", promptTokens: 40000, cacheReadTokens: 0, cacheWriteTokens: 0} -> triggered
{harness: "OpenCode", promptTokens: 40000, cacheReadTokens: 0, cacheWriteTokens: 0} -> triggered
{harness: "Claude", promptTokens: 40000, cacheReadTokens: 0, cacheWriteTokens: 40000} -> triggered
{harness: "Claude", promptTokens: 40000, cacheReadTokens: 36000, cacheWriteTokens: 4000} -> clean
{harness: "Local Agent", promptTokens: 40000, cacheReadTokens: null, cacheWriteTokens: null} -> clean
```
