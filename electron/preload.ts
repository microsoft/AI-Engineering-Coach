/*---------------------------------------------------------------------------------------------
 *  AI Engineer Coach Desktop -- preload script
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * Runs in an isolated world inside the renderer before any page script.
 * Bridges the webview's existing `acquireVsCodeApi()` contract over Electron IPC,
 * so the prebuilt dashboard bundle can run unchanged.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Receive messages from main and dispatch them as `MessageEvent`s so the
// existing webview's `window.addEventListener('message', ...)` still works.
ipcRenderer.on('host:postMessage', (_event, data) => {
  window.dispatchEvent(new MessageEvent('message', { data }));
});

// Mirror of vscode.WebviewApi: postMessage + getState/setState backed by sessionStorage.
const api = {
  postMessage(msg: unknown): void {
    void ipcRenderer.invoke('webview:postMessage', msg);
  },
  getState(): unknown {
    try {
      const raw = sessionStorage.getItem('aiCoach.webviewState');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  setState(state: unknown): unknown {
    try {
      sessionStorage.setItem('aiCoach.webviewState', JSON.stringify(state));
    } catch {
      /* quota errors fall through silently, same as VS Code's API */
    }
    return state;
  },
};

// Expose a narrow factory rather than the API object itself. The bundle calls
// `acquireVsCodeApi()` exactly once at boot, matching VS Code's contract.
contextBridge.exposeInMainWorld('__aiCoachAcquireApi', () => api);

// i18n bridge: exposes synchronous-feeling getters + a subscription for language changes.
// The renderer requests the dictionary once at boot, then re-applies on language-change events.
contextBridge.exposeInMainWorld('__aiCoachI18n', {
  load: () => ipcRenderer.invoke('i18n:getAll') as Promise<{ lang: string; translations: Record<string, Record<string, unknown>> }>,
  onLanguageChanged: (cb: (payload: { lang: string; translations: Record<string, Record<string, unknown>> }) => void) => {
    const listener = (_e: unknown, payload: { lang: string; translations: Record<string, Record<string, unknown>> }) => cb(payload);
    ipcRenderer.on('i18n:languageChanged', listener);
    return () => ipcRenderer.removeListener('i18n:languageChanged', listener);
  },
});
