/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared DSL cheat-sheet text used in system prompts for rule generation
 * and inline-editing LLM assistance. Keep this the single source of truth
 * so the two call sites cannot drift.
 */

export const DSL_CHEATSHEET = `## Rule Structure
\`\`\`markdown
---
id: rule-id
name: Human-Readable Name
group: prompt-quality | session-hygiene | code-review | tool-mastery | context-management
severity: low | medium | high
scope: requests | sessions
version: 1
tags: [tag1, tag2]
thresholds:
  key: number
---

# Description
What this rule detects.

# When Triggered
{{count}} ... out of {{total}} ({{pct}}). Use {{extra.keyName}} for reduce values.

# How to Improve
Actionable advice.

# Examples
"{{message}}..."

# Detection Logic
\\\`\\\`\\\`detect
scan: requests | sessions
match: <boolean expression per row>
aggregate: count | ratio
<reduceKey>: <expression over matched/all/allReqs/allSessions>
emitCount: <number expression for displayed count>
emitTotal: <number expression for displayed total>
check: <boolean trigger condition>
examples: <template per matched row>
severity: <boolean expression for dynamic severity upgrade>
\\\`\\\`\\\`
\`\`\`

## Available Row Fields (requests)
messageText, messageLength, timestamp, totalElapsed, modelId, agentMode, agentName,
slashCommand, referencedFiles (array), customInstructions (array), skillsUsed (array),
toolsUsed (array), toolConfirmations (array), aiCode (array of {language, loc}),
userCode (array), cancelled (boolean), sessionId, workspaceName,
harness (the request's session harness, e.g. "Local Agent" for VS Code)

## Available Row Fields (sessions)
sessionId, workspaceName, requestCount, requests (array), harness, startTime, endTime,
creationDate, lastMessageDate

## DSL Functions
- hasProfanity(text) - true if text contains profanity
- hasConstraint(text) - true if text has constraint keywords
- matchesAny(text, patterns) - regex match against pattern array
- capsWordRatio(text, minWords) - ratio of ALL-CAPS words
- isSpecDriven(requests) - true if session starts with specs
- isStructured(request) - true if request has bullet points/structure
- hasPlanUsage(requests) - 1 if any request uses plan mode
- countWhere(arr, field, op, value) - count items matching condition
- someWhere(arr, field, value) - true if any item matches
- avgField(arr, field) - average of numeric field
- sumField(arr, field) - sum of numeric field
- flatCount(arr, field) - sum of sub-array lengths
- flatUnique(arr, field) - count of distinct values across sub-arrays
- reasoningEffortStats(reqs[, level]) - premium reasoning-effort usage ratio
- instructionBloatStats(sessions[, maxBytes]) - custom-instructions size analysis

- excessFileContextStats(reqs[, minFiles]) - outliers attaching huge file context
- hasSkillByPattern(reqs, /pattern/) - any skillsUsed matches the regex
- first(arr) - first element
- length(arr) - array length
- round(n), floor(n), ceil(n), abs(n), min(a,b), max(a,b)
- sumAiLoc(requests) - sum of all AI code LoC in requests
- duplicateGroups(reqs, minKeyLen, minCount) -> {totalDupes, distinctCount}
- profanityMatches(reqs) -> {count, total, flaggedWords}
- contextGapCount(reqs) -> {gapCount, gaps[], reqCount}
- modelStats(reqs) -> {topModel, topCount, topShare, modelCount, total}
- flowScoreStats(sessions, minReqs, rapidMs) -> {fragmentedDays, totalDays, avgScore, lowScoreRate}
- adjacentPairCount(sessions, minLoc, maxGapMs) -> {count, avgLoc, avgGap}
- mdRatioByWorkspace(sessions, minLoc, docLangs) -> {lowCount, totalWorkspaces, overallRatio, workspaces[]}
- devcontainerStats(sessions, reqs) -> {terminalReqs, vscodeReqs, sandboxedTerminalReqs, totalTerminalReqs, terminalRate}
- langExplorationWeeks(reqs) -> {weeksSinceNew, totalLangs, recentNew, totalWeeks}
- yoloStats(reqs) -> {autoApproved, totalConfirmations, ratio}
- autoApproveStats(reqs) -> {terminalAutoApproved, autoApprovedTotal}
- groupTopBySum(arr, groupField, sumField) -> {key, sum, share, count}

## Match Expression Operators
AND, OR, NOT, ==, !=, >, <, >=, <=, field.length, field access with dot notation

## Reduce Expressions
After match, use reduce keys to compute aggregates over matched rows.
Use emitCount/emitTotal to override the displayed count/total.
The check expression has access to count, total, ratio, and all reduce keys.`;
