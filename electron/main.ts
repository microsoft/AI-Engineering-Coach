/*---------------------------------------------------------------------------------------------
 *  AI Engineer Coach Desktop (Electron port)
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/* Electron main process. Replaces the VS Code extension host. */

// Forked child processes (parse-worker, etc.) reuse process.execPath, which under
// Electron is the Electron binary. Without ELECTRON_RUN_AS_NODE=1 the child treats
// itself as a renderer and never runs the Node code we shipped. We can't set it on
// our own process — Electron's own Helper sub-processes would inherit it and crash
// trying to parse Chromium flags. So we monkey-patch fork() to inject it per-call.
// https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require('child_process') as typeof import('child_process');
const originalFork = childProcess.fork.bind(childProcess);
childProcess.fork = ((
  modulePath: string,
  args?: readonly string[] | import('child_process').ForkOptions,
  options?: import('child_process').ForkOptions,
) => {
  const opts: import('child_process').ForkOptions = (Array.isArray(args) ? options : args) ?? {};
  const merged: import('child_process').ForkOptions = {
    ...opts,
    env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: '1' },
  };
  return Array.isArray(args)
    ? originalFork(modulePath, args, merged)
    : originalFork(modulePath, merged);
}) as typeof childProcess.fork;

import { app, BrowserWindow, ipcMain, shell, Menu, type MenuItemConstructorOptions } from 'electron';

// Silence the harmless "Autofill.enable wasn't found" devtools spam.
app.commandLine.appendSwitch('disable-features', 'Autofill');
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

import { Analyzer } from '../src/core/analyzer';
import { findLogsDirs, parseAllLogsViaWorker, ParseResult } from '../src/core/parser';
import { getRpcHandler } from '../src/webview/panel-rpc';
import { errorResult } from '../src/webview/panel-shared';
import {
  loadAllRuleLayersAsync,
  loadAllMetricLayersAsync,
  setDefaultTrustGate,
} from '../src/core/rule-loader';
import { createTrustGate, setDefaultTrustStore } from '../src/core/rule-trust';
import { initI18n, changeLanguage, t, getCurrentLang, getAllTranslations, SUPPORTED_LANGS, type Lang } from './i18n';

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let analyzer: Analyzer | undefined;
let parseResult: ParseResult | undefined;
const pendingMessages: unknown[] = [];
let dataReady = false;

// Minimal disk-backed key/value store (replaces vscode.Memento).
const storePath = path.join(app.getPath('userData'), 'state.json');
let storeCache: Record<string, unknown> | null = null;

async function loadStore(): Promise<Record<string, unknown>> {
  if (storeCache) return storeCache;
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    storeCache = JSON.parse(raw);
  } catch {
    storeCache = {};
  }
  return storeCache!;
}

async function saveStore(): Promise<void> {
  if (!storeCache) return;
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(storeCache, null, 2), 'utf8');
}

// Memento-like adapter so we can hand a `globalState` to anything that wants it.
const globalState = {
  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const store = await loadStore();
    return (store[key] as T | undefined) ?? defaultValue;
  },
  async update(key: string, value: unknown): Promise<void> {
    const store = await loadStore();
    if (value === undefined) delete store[key];
    else store[key] = value;
    await saveStore();
  },
  keys: () => Object.keys(storeCache ?? {}),
};

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'AI Engineer Coach',
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      // Security defaults per https://www.electronjs.org/docs/latest/tutorial/security
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open dev tools only when launched with --dev
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Outgoing-link safety: never allow renderer to open new windows; route http(s) to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-page navigation away from file:// origin (defense in depth).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// RPC: webview <-> main process
// ---------------------------------------------------------------------------

function postToWebview(msg: Record<string, unknown>): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('host:postMessage', msg);
}

function postResponse(id: string, data: unknown): void {
  postToWebview({ type: 'response', id, data });
}

function postError(id: string, message: string): void {
  postToWebview({ type: 'response', id, data: errorResult(message) });
}

async function handleWebviewRequest(msg: { id: string; method: string; params?: Record<string, unknown> }): Promise<void> {
  // Open external URLs via the OS browser.
  if (msg.method === 'openExternal') {
    const url = (msg.params as Record<string, unknown> | undefined)?.url;
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
    }
    postResponse(msg.id, { ok: true });
    return;
  }

  // Budget persistence (was a vscode.Memento in the extension; here it's the disk store).
  if (msg.method === 'saveModelBudgets') {
    const budgets = (msg.params as Record<string, unknown> | undefined)?.budgets;
    await globalState.update('modelBudgets', budgets);
    postResponse(msg.id, { ok: true });
    return;
  }
  if (msg.method === 'loadModelBudgets') {
    const budgets = (await globalState.get<Record<string, number>>('modelBudgets', {})) ?? {};
    postResponse(msg.id, budgets);
    return;
  }

  // Custom service methods (LLM-backed: skill generation, learning quiz, GitHub auth, etc.).
  // The VS Code build runs these through panel-request-service.ts using vscode.LanguageModelChat
  // and vscode.authentication. In this desktop PoC they're disabled with a clear message
  // so the rest of the dashboard stays fully functional.
  const DESKTOP_DISABLED = new Set<string>([
    'createSkill',
    'generateSkillContent',
    'generateLearningQuiz',
    'generateLearningResources',
    'generateCodeComparison',
    'generateDidYouKnow',
    'exportSummary',
    'installSkill',
    'installCatalogItem',
    'triageSkills',
    'discoverCatalog',
    'triageCatalog',
    'reviewContextFiles',
    'getWorkspaceDeps',
    'getSdlcToolAnalysis',
    'getSdlcRepoScan',
    'getSdlcGitHubData',
  ]);
  if (DESKTOP_DISABLED.has(msg.method)) {
    postError(msg.id, `"${msg.method}" requires the VS Code build (uses Language Model / GitHub auth APIs).`);
    return;
  }

  // Everything else is a pure data query against the analyzer.
  if (!dataReady || !analyzer || !parseResult) {
    pendingMessages.push(msg);
    return;
  }

  const handler = getRpcHandler(msg.method);
  if (!handler) {
    postError(msg.id, `Unknown method: ${msg.method}`);
    return;
  }

  try {
    const result = handler(analyzer, parseResult, msg.params ?? {});
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      try {
        const data = await (result as Promise<unknown>);
        postResponse(msg.id, data);
      } catch (err) {
        postError(msg.id, err instanceof Error ? err.message : 'Internal error');
      }
    } else {
      postResponse(msg.id, result);
    }
  } catch (err) {
    postError(msg.id, err instanceof Error ? err.message : 'Internal error');
  }
}

function flushPendingMessages(): void {
  const drained = pendingMessages.splice(0, pendingMessages.length);
  for (const m of drained) void handleWebviewRequest(m as Parameters<typeof handleWebviewRequest>[0]);
}

// ---------------------------------------------------------------------------
// Data load
// ---------------------------------------------------------------------------

async function loadData(): Promise<void> {
  // Wire trust gate (no UI prompts in the desktop PoC; only built-in rules are loaded).
  const trustGate = createTrustGate(globalState as unknown as Parameters<typeof createTrustGate>[0]);
  setDefaultTrustGate(trustGate);
  setDefaultTrustStore(globalState as unknown as Parameters<typeof setDefaultTrustStore>[0]);

  await Promise.allSettled([
    loadAllRuleLayersAsync(undefined, trustGate),
    loadAllMetricLayersAsync(undefined, trustGate),
  ]);

  const dirs = findLogsDirs();
  if (dirs.length === 0) {
    postToWebview({
      type: 'progress',
      phase: 0,
      detail: 'No AI coding session logs found on this machine.',
      pct: 0,
    });
    return;
  }

  parseResult = await parseAllLogsViaWorker(dirs, progress => {
    postToWebview({ type: 'progress', ...progress });
  });

  analyzer = new Analyzer(parseResult.sessions, parseResult.editLocIndex, parseResult.workspaces);

  postToWebview({
    type: 'progress',
    phase: 5,
    detail: 'Ready',
    pct: 100,
    sessions: parseResult.sessions.length,
  });

  dataReady = true;
  postToWebview({ type: 'dataReady', currentWorkspace: os.hostname() || '' });

  try {
    await analyzer.warmUp();
  } catch {
    /* non-fatal */
  }

  flushPendingMessages();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function buildAppMenu(): void {
  const langLabel = (l: Lang) =>
    ({ en: t('menu.languageEnglish'), ru: t('menu.languageRussian'), uk: t('menu.languageUkrainian') })[l];

  const languageSubmenu: MenuItemConstructorOptions[] = SUPPORTED_LANGS.map(l => ({
    label: langLabel(l),
    type: 'radio',
    checked: getCurrentLang() === l,
    click: () => void onLanguageChange(l),
  }));

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          {
            label: t('menu.reloadData'),
            accelerator: 'CmdOrCtrl+R',
            click: () => void reloadData(),
          },
          {
            label: t('menu.revealLogs'),
            click: () => {
              const dirs = findLogsDirs();
              if (dirs[0]) void shell.openPath(dirs[0]);
            },
          },
          { type: 'separator' },
          { label: t('menu.language'), submenu: languageSubmenu },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

async function onLanguageChange(lang: Lang): Promise<void> {
  await changeLanguage(lang);
  await globalState.update('language', lang);
  buildAppMenu();
  // Push the new dictionary to the renderer so it can re-render labels.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('i18n:languageChanged', { lang, translations: getAllTranslations() });
  }
}

async function reloadData(): Promise<void> {
  dataReady = false;
  analyzer = undefined;
  parseResult = undefined;
  pendingMessages.length = 0;
  await loadData();
}

app.on('ready', async () => {
  // Restore saved language before menu construction so the menu is in the right locale.
  const savedLang = (await globalState.get<Lang>('language', 'en')) ?? 'en';
  await initI18n(SUPPORTED_LANGS.includes(savedLang) ? savedLang : 'en');
  buildAppMenu();

  createWindow();

  ipcMain.handle('webview:postMessage', (_event, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
    if (msg.type === 'request' && typeof msg.id === 'string' && typeof msg.method === 'string') {
      void handleWebviewRequest({ id: msg.id, method: msg.method, params: msg.params });
    }
  });

  // Webview state persistence (in lieu of vscode.Webview.getState/setState).
  ipcMain.handle('webview:loadState', async () => {
    return (await globalState.get<unknown>('webviewState')) ?? null;
  });
  ipcMain.handle('webview:saveState', async (_event, state: unknown) => {
    await globalState.update('webviewState', state);
  });

  // i18n IPC: renderer asks for current language + the full dictionary at boot.
  ipcMain.handle('i18n:getAll', () => ({ lang: getCurrentLang(), translations: getAllTranslations() }));

  // Start loading data once the renderer has had a chance to mount.
  mainWindow?.webContents.once('did-finish-load', () => {
    void loadData().catch(err => {
      postToWebview({
        type: 'progress',
        phase: 0,
        detail: `Load failed: ${err instanceof Error ? err.message : String(err)}`,
        pct: 0,
      });
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
