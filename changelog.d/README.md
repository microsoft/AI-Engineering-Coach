# Changelog fragments

Each pull request with a change users will notice adds one Markdown file here, named after the
pull request, for example `changelog.d/412.md` (use your branch name until the pull request has a
number). Write [Keep a Changelog](https://keepachangelog.com/en/2.0.0/) type headings with bullet
entries, and end each entry with the pull request or issue number:

```markdown
### Added

- **Prompt Cache** tab with cache efficiency per session (#412)

### Fixed

- The timeline no longer drops sessions that span midnight (#415)
```

Types: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Mark breaking changes
with `**Breaking:**`.

Don't add dates and don't edit `CHANGELOG.md` for new changes. `npm run changelog` and
`npm run package` merge every fragment into the history under the UTC date its file was added to
`main` (the merge or squash commit), read from git. Fragments not on `main` yet show under
`[Unreleased]`. Fix a fragment's wording by editing it; renaming it would change its date.
