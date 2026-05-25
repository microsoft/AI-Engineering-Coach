---
title: "Features"
weight: 20
---

AI Engineer Coach organizes its capabilities into three areas that mirror a continuous improvement cycle: **Observe** your usage, **Measure** your output, and **Improve** your practices.

When Team Mode is enabled, a fourth shared view becomes available to admins: a team dashboard built only from privacy-safe aggregates. It shows per-developer score cards, token totals, anti-pattern severity, and week-over-week trends without exposing raw prompts, code, or file names. The extension can sync to a Cloudflare Workers + D1 backend so the team keeps basic usage lightweight and cost-conscious.

## Observe

- [Dashboard](/observe/dashboard/) -- At-a-glance practice scores, activity charts, and skill recommendations
- Team Dashboard -- Optional admin-only team overview for aggregated AI usage quality and coaching trends
- [Timeline](/observe/timeline/) -- Gantt-style session timeline showing when and how long you worked with AI
- [Coding Moments](/observe/coding-moments/) -- Screenshot gallery from AI coding sessions with story reels and workspace filtering

## Measure

- [Output](/measure/output/) -- AI-generated lines of code and model usage breakdown
- [Burndown](/measure/burndown/) -- Track AI credit consumption against your monthly allowance *(temporarily disabled)*
- [Activity Patterns](/measure/patterns/) -- Work-hour heatmaps, calendar views, and per-project breakdowns

## Improve

- [Anti-Patterns](/improve/anti-patterns/) -- Scored detectors for prompt quality, session hygiene, code review, and tool mastery, backed by an editable rule engine
- [Rule Editor](/improve/rule-editor/) -- Edit, clone, live-test, and AI-draft detection rules written as markdown
- [Rule Playground](/improve/rule-playground/) -- Interactive REPL for the rule DSL with a field browser, function catalog, and metric list
- [Data Explorer](/improve/data-explorer/) -- Inspect request/session fields and distributions
- [Skill Finder](/improve/skill-finder/) -- Discover repeated prompts and matching community skills
- [Context Health](/improve/context-health/) -- Evaluate context quality and session management efficiency

## Team Mode

- Team Mode is optional and off by default
- Admins bootstrap the backend first, then generate invite codes for teammates
- Developers only upload aggregate numeric snapshots after local analysis
- No raw prompts, code, file names, or session text ever leave the developer machine

## Level Up

- [Learning Center](/level-up/learning/) -- Personalized quizzes and challenges built from your actual usage
- [Achievements](/level-up/achievements/) -- XP-based progression with Bronze, Silver, Gold, and Diamond tiers
- [Agentic SDLC](/level-up/sdlc/) -- Track how you use AI across the full development lifecycle
- [Share](/level-up/share/) -- Generate shareable stat cards
