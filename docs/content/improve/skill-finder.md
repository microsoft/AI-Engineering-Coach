---
title: "Skill Finder"
weight: 20
description: "Discover repeated prompts and matching community skills"
---

# Skill Finder

The Skill Finder analyzes your prompt history to identify repeated patterns that waste time and matches them against a community-maintained skill catalog.

![Skill Finder](/screenshots/screen-skill-finder.png)

## Custom Skill Opportunities

AI Engineer Coach groups similar prompts across your sessions. When the same type of request appears multiple times in different sessions, it surfaces as a **Custom Skill Opportunity**. For example, if you repeatedly ask to "package the extension", the Skill Finder detects this pattern and suggests creating a reusable skill for it.

Each opportunity shows:

- The number of repetitions and sessions
- Example prompts that triggered the detection
- An **Install Skill** button that helps you create a reusable instruction file

## Community Skills and Agents

Below the custom opportunities, AI Engineer Coach queries the community skill catalog and displays matching entries. These are curated skills and agents maintained in the open-source `awesome-copilot` directory.

The catalog loads skills, agents, and instructions from the community site's JSON
feeds, rather than scraping its page layout. Skills use their `SKILL.md` file path
so the Install button downloads the instruction file, not a directory.

Each community match shows:

- **Skill name** and category (e.g., VS CODE, TESTING, OTHER)
- **Description** of what the skill does
- **Why it matches** your usage pattern
- An **Install** button to add it to your workspace

Catalog loading or AI matching failures appear as **Catalog error** messages,
separately from a successful analysis with no matching recommendations. Custom
skill opportunities remain visible. Click **Analyze** again, or **Retry Scan** on
the dashboard, to retry without restarting VS Code. Failed results are not cached;
successful results retain the full reviewed-item count when navigating between
the dashboard and Skill Finder.

Analyze stays disabled until both custom-skill analysis and catalog matching
finish. Switching the workspace, harness, or page leaves the new view's results
and cache isolated from any requests still finishing for the previous view.

## Configuration

You can select the workspace and look-back period (1 month, 3 months, 6 months) to control the scope of the analysis. Click **Analyze** to refresh the findings.
