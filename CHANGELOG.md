# Changelog

## Unreleased

- Configurable AI model selection with automatic fallback: new `aiEngineerCoach.preferredModel` setting and an "AI Model" picker in the dashboard sidebar. Auto mode iterates available Copilot models and skips any that return an empty response (e.g. models disabled for a plan or organization), fixing AI features failing silently (#91).

## 0.1.0 — First Release

- Dashboard with timeline, output, and consumption views
- Anti-pattern detection with 40+ built-in rules
- Skill Finder and context quality analysis
- Activity patterns (projects, work hours)
