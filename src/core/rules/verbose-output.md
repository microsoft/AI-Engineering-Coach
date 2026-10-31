---
id: verbose-output
name: Verbose Model Output
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [tokens, output, verbosity, cost]
thresholds:
  minCompletionTokens: 5000
  maxMessageLength: 200
  minSample: 10
  maxRatio: 0.1
---

# Description
Detects requests where the AI generated very long responses (>5K completion tokens) for short, low-context prompts. These rambling outputs burn through completion-token budgets without proportional value.

# When Triggered
{{count}} requests ({{pct}}) produced >{{extra.minCompletionTokens}} completion tokens from prompts shorter than {{extra.maxMessageLength}} characters. Verbose outputs are a major driver of token spend.

# How to Improve
Be explicit about response length and format: ask for "a concise answer", "a one-line summary", "no commentary", or specify a maximum number of bullets. Add output constraints to your custom instructions for routine tasks.

# Examples
"{{messageText | truncate:80}}" → {{completionTokens}} completion tokens

# Detection Logic
```detect
scan: requests
match: completionTokens > thresholds.minCompletionTokens AND messageLength > 0 AND messageLength < thresholds.maxMessageLength
aggregate: ratio
check: ratio > thresholds.maxRatio AND count > thresholds.minSample
examples: "{{messageText | truncate:80}}" → {{completionTokens}} tokens
```

# Tests
```test
{messageText: "fix this", messageLength: 8, completionTokens: 8000} -> triggered
{messageText: "Explain in detail how the OAuth flow works including token refresh, PKCE, and edge cases for mobile clients. Cover the authorization code exchange, how refresh tokens rotate, and what to store on the device versus the server", messageLength: 224, completionTokens: 8000} -> clean
{messageText: "fix this", messageLength: 8, completionTokens: 200} -> clean
```
