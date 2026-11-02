---
id: no-spec-driven-development
name: No Spec-Driven Development
group: prompt-quality
severity: medium
scope: sessions
version: 2
tags: [prompt, spec, planning]
thresholds:
  minAgentSessions: 5
  specRate: 0.2
  planRate: 0.15
patterns:
  specFileExts: "(?i)\\.(md|txt|spec|prd|design|plan|rfc|adoc)$"
  specKeywords: "(?i)\\b(spec|requirements?|acceptance criteria|design doc|PRD|RFC|plan file|constraint|must|should|ensure)\\b"
  bulletList: "(?m)^[-*]\\s"
  numberedList: "(?m)^\\d+[.)]\\s"
  headings: "(?m)^#+\\s"
---

# Description
Detects when few sessions start with specs, plans, or structured requirements. Spec-first development consistently beats vibe-coding.

# When Triggered
Only {{extra.specDrivenCount}} of {{extra.totalSessions}} sessions ({{extra.specPct}}%) start with specs, plans, or structured requirements. Spec-first development consistently beats vibe-coding.

# How to Improve
Adopt Spec-Driven Development (SDD): write a brief spec before coding.
How sessions are classified:
- Spec-driven: first prompt references a .md/.spec file, contains structured bullet points/numbered lists, uses keywords like "requirements", "acceptance criteria", "must", "ensure", or starts in plan mode.
- Planning: any request uses plan mode (/plan) or contains planning keywords (plan, architect, design, outline, roadmap).
- Unstructured: everything else — typically vague, single-sentence prompts that lead to more iterations.
Start each session with: 1) What you're building, 2) Acceptance criteria, 3) Constraints. Even 3 bullet points dramatically improve AI output quality.

# Examples
{{extra.workspace}}: "{{message}}..."

# Detection Logic
```detect
scan: sessions
match: requestCount >= 3 AND NOT (\
  anyMatch(first(requests).referencedFiles, patterns.specFileExts) OR \
  matches(first(requests).messageText, patterns.specKeywords) OR \
  (matches(first(requests).messageText, patterns.bulletList) AND lineCount(first(requests).messageText) >= 3) OR \
  (matches(first(requests).messageText, patterns.numberedList) AND lineCount(first(requests).messageText) >= 3) OR \
  matches(first(requests).messageText, patterns.headings) OR \
  first(requests).slashCommand == "plan" OR \
  contains(str(first(requests).agentMode), "plan"))
aggregate: count
specSessionTotal: countWhere(all, "requestCount", ">=", 3)
specRate: (specSessionTotal - count) / specSessionTotal
specDrivenCount: specSessionTotal - count
totalSessions: specSessionTotal
specPct: round(specRate * 100)
check: specSessionTotal >= thresholds.minAgentSessions AND specRate < thresholds.specRate
examples: {{workspaceName}}: not spec-driven
```

# Tests
```test
{messageText: "fix the login bug", requestCount: 3} -> triggered
{messageText: "- add the parser\n- add tests\n- update the docs", requestCount: 3} -> clean
{messageText: "1. add the parser\n2. add tests\n3. update the docs", requestCount: 3} -> clean
{messageText: "# Goal\nadd the parser", requestCount: 3} -> clean
{messageText: "the export must keep the order", requestCount: 3} -> clean
{messageText: "update the parser", referencedFiles: ["docs/spec.md"], requestCount: 3} -> clean
{messageText: "update the parser", referencedFiles: ["src/parser.ts"], requestCount: 3} -> triggered
```
