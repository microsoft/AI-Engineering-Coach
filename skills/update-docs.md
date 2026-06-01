---
name: update-docs
description: Update or add a documentation page under docs/content/ (Hugo static site).
when_to_use: User asks to "update the docs", "add a doc page", "fix the documentation", or
  changes a feature whose page is published at https://microsoft.github.io/AI-Engineering-Coach/.
---

# Update Docs

The published docs at https://microsoft.github.io/AI-Engineering-Coach/ are built from
[`docs/`](../docs/) with Hugo. Each page is a markdown file with YAML front matter; section
landing pages are `_index.md`.

## Layout

```
docs/
├── hugo.toml                      # site config
├── AUTHORING_RULES.md             # rule and metric authoring guide (separate doc, not Hugo)
├── content/
│   ├── _index.md                  # site home
│   ├── features/_index.md
│   ├── getting-started/{installation,supported-tools}.md
│   ├── improve/{anti-patterns,context-health,data-explorer,
│   │            rule-editor,rule-playground,skill-finder}.md
│   ├── level-up/{achievements,learning,sdlc,share}.md
│   ├── measure/{burndown,output,patterns}.md
│   └── observe/{dashboard,timeline}.md
└── themes/                        # Hugo theme; do not edit
```

The page URL maps from the file path: `docs/content/improve/skill-finder.md` →
`/improve/skill-finder/`.

## Front matter

Every content page starts with:

```yaml
---
title: "Skill Finder"
weight: 20            # ordering inside the section
description: "One-line summary used in section listings"
---
```

Section index files (`_index.md`) use the same front matter; their `weight` orders the section in
the top-level nav.

## Internal links

Inside `docs/content/`, link to other pages by their **site path**:

```markdown
See the [Rule Editor](/improve/rule-editor/) for live-test details.
```

Outside `docs/content/` — including from `AGENTS.md`, `README.md`, or `CONTRIBUTING.md` — these
site paths do **not** resolve on GitHub. Use a repo-relative path instead:

```markdown
See [docs/content/improve/rule-editor.md](docs/content/improve/rule-editor.md).
```

## Screenshots

- Drop the image at `docs/static/screenshots/<slug>.png`. Hugo serves it at
  `/screenshots/<slug>.png`.
- Reuse an existing dashboard screenshot from `assets/` only if it already shows the page; do not
  copy assets into `docs/static/` to avoid drift.
- Reference inside a doc page:

  ```markdown
  ![Skill Finder](/screenshots/screen-skill-finder.png)
  ```

## Local preview

Hugo is not pinned in this repo. Install it locally
(`brew install hugo` / `go install github.com/gohugoio/hugo@latest`) then:

```bash
cd docs
hugo server -D
```

The PDF build (`docs/build-pdf.sh`) is optional; CI doesn't require it for a docs PR.

## Cross-references to update

When you add or rename a page, also update:

- `AGENTS.md` Documentation Index at the repo root.
- The section's `_index.md` bullet list (e.g. `docs/content/improve/_index.md`).
- Any sibling pages that link to the renamed page.
- `README.md` "Pages" tables if the change affects feature framing.

## Spellcheck

`npm run spellcheck` runs cspell over `docs/**/*.md`. Add genuine new terms (product names,
acronyms) to `cspell.json` — do not silence the check inline.

## Anti-patterns

- Don't add a doc page without an entry in the section's `_index.md` — the nav skips it.
- Don't link to `https://microsoft.github.io/AI-Engineering-Coach/...` from within `docs/content/`
  pages; use the relative site path so local preview works too.
- Don't write content that duplicates `README.md` — link to the doc page from the README instead.
