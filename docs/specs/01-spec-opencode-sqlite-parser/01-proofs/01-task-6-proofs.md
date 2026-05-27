# Task 6 Proofs — OpenCode documentation updated

## Task Summary

`docs/content/getting-started/supported-tools.md` now documents both the SQLite
and legacy JSON storage layouts, lists the exact file paths checked on each
platform, and includes a troubleshooting section for users whose OpenCode sessions
do not appear in the dashboard.

## What This Task Proves

- Docs explain the storage-layout change that caused sessions to stop loading.
- Exact paths for macOS/Linux and Windows are documented.
- A short troubleshooting checklist tells users how to verify their data directory.

## Artifact: Updated supported-tools.md OpenCode section

**What it proves:** Documentation now includes storage layout table and troubleshooting guidance.

**Command:**
```bash
grep -A 25 "^## OpenCode" docs/content/getting-started/supported-tools.md
```

**Result summary:** Section now includes a layout table (SQLite vs legacy JSON),
Windows path note, and a numbered troubleshooting list.

```markdown
## OpenCode

Parses session logs from the open-source OpenCode terminal tool that supports multiple LLM backends.

OpenCode data is read from either of two storage layouts depending on the installed version:

| Layout | Path | OpenCode version |
| --- | --- | --- |
| **SQLite** (current) | `~/.local/share/opencode/opencode.db` | ≥ 0.1.x |
| **Legacy JSON** | `~/.local/share/opencode/storage/` | < 0.1.x |

On Windows both paths use `%USERPROFILE%\.local\share\opencode\`.
SQLite is preferred when both layouts are present.

**Troubleshooting — OpenCode sessions not appearing:**

1. Confirm the file exists: `ls ~/.local/share/opencode/opencode.db`
2. If the file is missing, check whether the legacy JSON storage directory exists:
   `ls ~/.local/share/opencode/storage/session/global/`
3. On Windows use `%USERPROFILE%\.local\share\opencode\` for the same paths.
```

## Reviewer Conclusion

Documentation now correctly describes both storage layouts and gives users a
clear path to diagnose missing OpenCode sessions.
