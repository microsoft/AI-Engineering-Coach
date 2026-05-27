# AI Engineer Coach — Desktop App Roadmap

Status of the Electron port (fork of microsoft/AI-Engineering-Coach), based on hands-on inspection of the running PoC against ~1 GB of Claude Code logs and ~12 GB of Codex CLI logs.

---

## ✅ What works in the PoC today

Verified end-to-end with real data:

- **App launches** as a native macOS `.app` with sandbox-on, contextIsolation-on, no nodeIntegration (Electron security checklist passing).
- **Log discovery** finds all harnesses: Claude Code, Codex CLI, OpenCode, VS Code Copilot, Xcode (when present).
- **Parse pipeline** runs in a forked Node worker (via the `ELECTRON_RUN_AS_NODE=1` fork shim). 743 sessions across 47 workspaces parsed successfully on first run.
- **Dashboard renders** with: sidebar nav, workspace/harness filters, badges (Timeline 837, Output 261K, Anti-Patterns 26, Skills, etc).
- **All read-only data RPCs** route through the existing `getRpcHandler` registry. Pages confirmed visually loading: Dashboard, Timeline, Coding Moments. Other read-only pages (Output, Patterns, Anti-Patterns, Context Health, Level Up) share the same RPC plumbing and should render — need explicit click-through to confirm absence of edge cases.
- **Disk-backed state** (model budgets, webview state) persists between launches via `app.getPath('userData')/state.json`.
- **Open-external** links route to the OS browser through `shell.openExternal`.
- **Process hygiene**: monkey-patched `child_process.fork` so only forked workers inherit `ELECTRON_RUN_AS_NODE=1` — the Helper renderer processes still start as Chromium.

## 🟡 Known limitations (by design, gated explicitly in main.ts)

The following methods are routed through `DESKTOP_DISABLED` and return a clear "not available in desktop build" error. They depend on VS Code-only APIs that have no Electron equivalent without re-implementing the underlying service:

| Method | VS Code API used | Effort to enable in desktop |
|---|---|---|
| `createSkill`, `generateSkillContent` | `vscode.lm.selectChatModels` | Wire to user's Anthropic/OpenAI key (~1 day) |
| `generateLearningQuiz`, `generateLearningResources` | `vscode.lm` | Same as above |
| `generateCodeComparison`, `generateDidYouKnow` | `vscode.lm` | Same as above |
| `installSkill`, `installCatalogItem`, `triageSkills`, `discoverCatalog`, `triageCatalog` | `vscode.lm` + `vscode.workspace.fs` | Same as above |
| `reviewContextFiles`, `getWorkspaceDeps` | `vscode.lm` + workspace introspection | Same as above |
| `getSdlcGitHubData`, `getSdlcRepoScan`, `getSdlcToolAnalysis` | `vscode.authentication.getSession('github')` | Implement OAuth device flow (~2 days) |
| `exportSummary` | `vscode.window.showSaveDialog` | Electron `dialog.showSaveDialog` (~30 min) |

**Visible impact**: Skill Finder, Context Health, and Level Up pages still load and show whatever pure-data content they have, but their "regenerate / install / sync GitHub" buttons will surface a "not available" toast. Read-only views work.

## 🔴 Real issues found during inspection

| # | Issue | Severity | Repro | Root cause | Fix effort |
|---|---|---|---|---|---|
| 1 | Codex CLI parse never reaches "Ready" on machines with >5 GB of Codex sessions. Progress bar shows last filename but stalls. | **High** | User has 12 GB at `~/.codex/sessions` | Original `parser-codex.ts` reads every session synchronously; pre-existing scalability bug in upstream Microsoft code | Add a max-bytes-per-harness cap or batched streaming. ~3-4 h. **Not a regression from porting.** |
| 2 | Title bar shows generic "Electron" / "Claude" depending on what app stole focus; on cold launch the bundle ID isn't yet set so menu reads "Electron". | Low | Always | `electron-builder` hasn't rebranded the dev binary; only the packaged `.app` carries the right `productName`. | Already correct in packaged build. Dev launch will always say "Electron". |
| 3 | Loading screen overlays the sidebar (renders full-window) for the entire 30-90s parse window. Looks like the app froze. | Medium | Always on first launch | The webview's progress UI in `app.ts` doesn't render sidebar until `dataReady`. Pre-existing. | Render sidebar in a disabled state during load. ~1 h. |
| 4 | DevTools console autofill warnings ("`Autofill.enable` wasn't found"). | Cosmetic | Always with `--dev` | Chromium probes for autofill provider; harmless. | Suppress with `app.commandLine.appendSwitch('disable-features', 'Autofill')`. ~5 min. |
| 5 | The `electron-builder` final packaging step took >5 minutes and was killed; `out/mac-arm64/Electron.app` left half-built. | Medium | `npm run package:app` | Likely the `asar: true` + first-run native-module pack with no on-disk cache. | Re-run with longer timeout, or `asar: false` for first build. ~10 min. |
| 6 | Coding Moments page says "No Loadable Images Found" even though 250 sessions reference images. | Low | Always (with the user's data) | The page expects raw screenshot files alongside session JSON; Claude Code CLI doesn't store them, only Copilot in VS Code does. Pre-existing limitation. | Hide page if no harness produces images, or document the limitation in-app. ~1 h. |

## 🎨 Visual polish — needed before this is a "product"

The webview was designed to live inside a VS Code panel. It works in a standalone window but is not yet macOS-native feeling. Items here are not blockers — they're the difference between a "PoC that runs" and a "thing you'd hand to a friend."

| Area | What's missing | Why it matters | Effort |
|---|---|---|---|
| **Window chrome** | `titleBarStyle: 'hiddenInset'` already on, but the area under the traffic lights has no drag region; user can't drag the window from the top strip. | Native macOS expectation. | 30 min — add `-webkit-app-region: drag` band. |
| **Vibrancy** | Window background is flat `#0d1117`. macOS apps typically have NSVisualEffectView under the chrome. | Looks dated. | 1 h — `vibrancy: 'sidebar'` in BrowserWindow + adjust webview colors. |
| **Sidebar typography** | Sidebar icons are HTML entities (▪ ━ ◣ ▲) instead of the SVG icons used in the VS Code version (I had to strip SVGs from `electron/index.html` because the build pipeline didn't carry over the `FF_TOKEN_REPORTING_ENABLED` flag check at HTML-generation time). | Looks crude vs original. | 1 h — bake the SVG set into `index.html` literally. |
| **Loading states** | Empty page states are blank ("No Loadable Images Found") — no illustration, no suggestion. | Feels broken. | 1 day to do well across all pages. |
| **macOS menu** | Current menu is `Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}])` — fine, but missing app-specific items: "Reload Data", "Reveal Logs in Finder", "Switch Language". | App feels feature-less. | 1 h. |
| **Dock icon** | Currently the generic Electron icon. | Looks like a placeholder. | Need a 1024x1024 .icns. 1 h once a source PNG exists. |
| **First-run experience** | No welcome screen, no explanation of what the app does or where it reads from. | Confusing on cold install. | Half a day. |
| **Settings UI** | No UI to: configure data refresh, choose language, opt out of telemetry (there isn't any, but say so), set log paths. | Standard expectation. | 1-2 days. |
| **Dark/light** | Hard-coded dark. macOS users expect to follow system. | Modern UX. | 2 days (audit every CSS color). |

Realistic total for "product-grade polish": **2-3 weeks of focused work** by one engineer.

## 🌐 Internationalization (i18n)

### What's done in this commit

I added an i18n skeleton so the work isn't blocked on a library decision later:

- **Library**: [`i18next`](https://www.i18next.com) (BSD-3 license, free, ~10M weekly downloads, used in Discord/Slack/Figma's webviews). Picked over `lingui` (heavier compile-time setup) and `formatjs` (heavier runtime). i18next supports plain JSON files and lazy backend loading — perfect for an Electron app reading bundled locale files.
- **Languages scaffolded**: English (EN, source), Russian (RU), Ukrainian (UK). Adding more = drop a JSON file in `electron/locales/`.
- **Where it's wired**: Sidebar nav labels + the Electron application menu. ~50 strings.
- **Language switcher**: Under the macOS app menu → "Language" submenu. Persists choice to the same disk-backed state store as model budgets.

### What's NOT done — the honest part

Full UI localization requires touching every webview page file. There are ~50 page files in `src/webview/` with thousands of inline English strings. Each needs:

1. Replace literal strings with `t('key')` calls.
2. Extract the keys into a master `en.json`.
3. Translate to RU/UK (machine translation is fine for a start; native review needed for quality).
4. Localize chart labels, axis units, date formats (i18next has `formatjs`-compatible plurals/dates built in).
5. Localize markdown rule descriptions in `src/core/rules/*.md` — these are the heart of the Anti-Patterns content. **This is the biggest chunk** — ~45 rule files in English prose.

Realistic estimate for full i18n: **5-8 working days** for one engineer plus translator time per language.

### How to extend

```ts
// In any webview file:
import { t } from './i18n';
const label = t('sidebar.dashboard');  // returns "Dashboard" / "Панель" / "Інформаційна панель"
```

```json
// electron/locales/uk.json
{
  "sidebar": {
    "dashboard": "Інформаційна панель",
    ...
  }
}
```

To add a language: copy `en.json` to `xx.json`, translate values, add the code to `LANGS` in `electron/main.ts`.

## 📦 Build & distribution

| Step | Status |
|---|---|
| Dev launch (`npm run start:electron`) | ✅ works |
| Production bundle (`npm run build:electron`) | ✅ works, ~50 MB output |
| Unsigned `.app` (`npm run package:app`) | 🟡 was killed at 5 min timeout. Needs longer wall clock or `asar: false`. |
| Code signing | ❌ Not configured. Requires Apple Developer ID ($99/y). |
| Notarization | ❌ Same. |
| Auto-update | ❌ Not configured. `electron-updater` config is one yaml block away once signing exists. |
| Windows / Linux builds | ❌ Not configured. The macOS-specific `osx*` flags and `assets/icon.png` would need cross-platform equivalents. |

## 🛣️ Suggested priority order

If you want to push this to "good enough to share with 1-2 friends":

1. **(half day)** Fix issues #3, #4, #5, #6 from the table above. Get a clean packaged `.app`.
2. **(half day)** Visual polish bucket items 1-3 (window chrome, vibrancy, sidebar SVGs).
3. **(1 day)** Reveal Logs / Reload / Switch Language in the app menu, dock icon, first-run welcome.
4. **(2-3 days)** Full i18n: extract keys from webview, run through DeepL, ship EN/RU/UK.
5. **(1-2 days)** Settings UI.
6. **(2-3 days)** Optional: wire your own Anthropic API key so LLM features come back online (Skill Finder / Learning quiz / Anti-Pattern editor). The existing `panel-llm.ts` already abstracts the call site — just need a new provider.
7. **(1 day)** Apple Developer ID, sign + notarize, ship a `.dmg`.
8. **(2-3 days)** Linux / Windows builds via `electron-builder` targets.

**Total to ship a real public-facing product: ~3 focused weeks.**

## What this fork is not

This is not a competitor to the upstream VS Code extension — that one stays the right answer for anyone who lives in VS Code. This fork exists to:

1. Let people who use the Claude Code CLI (no VS Code) still get the coaching dashboard.
2. Run as a standalone always-on tray-ish app in the future.
3. Be a reference for "how to port a VS Code extension to Electron" — every shim and gotcha is commented in `electron/`.

If you only want VS Code analytics and you're a VS Code user, install the upstream extension directly.
