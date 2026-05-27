/*---------------------------------------------------------------------------------------------
 *  Minimal `vscode` API stub used by the Electron build.
 *  - panel-rpc.ts and panel-shared.ts statically import 'vscode' for types and (rarely) values.
 *  - In the desktop build the LLM / GitHub-auth code paths are never invoked
 *    (handleWebviewRequest filters them via DESKTOP_DISABLED).
 *  - We still need the imports to *resolve* at runtime so bundling succeeds.
 *
 *  Anything in here that actually gets called would be a bug in the desktop dispatcher.
 *--------------------------------------------------------------------------------------------*/

const notSupported = (api: string): never => {
  throw new Error(`vscode.${api} is not available in the AI Engineer Coach desktop build`);
};

// --- Types we only need shapes for ---
export class Uri {
  constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
  static file(p: string): Uri { return new Uri(p, 'file'); }
  static parse(s: string): Uri { return new Uri(s, s.split(':')[0] || 'file'); }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const path = require('path') as typeof import('path');
    return new Uri(path.join(base.fsPath, ...segments), base.scheme);
  }
  toString(): string { return `${this.scheme}://${this.fsPath}`; }
  get path(): string { return this.fsPath; }
  with(_change: Record<string, unknown>): Uri { return this; }
}

// --- workspace ---
export const workspace = {
  fs: {
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      const fs = require('fs/promises') as typeof import('fs/promises');
      const path = require('path') as typeof import('path');
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content);
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      const fs = require('fs/promises') as typeof import('fs/promises');
      return fs.readFile(uri.fsPath);
    },
    async stat(uri: Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> {
      const fs = require('fs/promises') as typeof import('fs/promises');
      const s = await fs.stat(uri.fsPath);
      return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
    },
  },
  workspaceFolders: undefined as unknown,
  name: '' as string,
  getConfiguration: () => ({ get: () => undefined, has: () => false, inspect: () => undefined, update: async () => {} }),
};

// --- commands ---
export const commands = {
  executeCommand: async (_cmd: string, ..._args: unknown[]) => notSupported('commands.executeCommand'),
  registerCommand: () => ({ dispose: () => {} }),
};

// --- window ---
export const window = {
  showInformationMessage: async (_msg: string, ..._items: string[]) => undefined,
  showWarningMessage: async (_msg: string, ..._items: string[]) => undefined,
  showErrorMessage: async (_msg: string, ..._items: string[]) => undefined,
  showQuickPick: async () => undefined,
  showSaveDialog: async () => undefined,
  showOpenDialog: async () => undefined,
  createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
  createWebviewPanel: () => notSupported('window.createWebviewPanel'),
  withProgress: async <T>(_opts: unknown, task: (p: { report: (v: unknown) => void }) => Promise<T>) =>
    task({ report: () => {} }),
  registerWebviewViewProvider: () => ({ dispose: () => {} }),
  activeTextEditor: undefined,
};

// --- env ---
export const env = {
  openExternal: async (uri: Uri) => {
    const { shell } = require('electron') as typeof import('electron');
    await shell.openExternal(uri.toString());
    return true;
  },
  clipboard: { writeText: async (_text: string) => {}, readText: async () => '' },
};

// --- authentication ---
export const authentication = {
  getSession: async (_provider: string, _scopes: string[], _opts?: unknown) => notSupported('authentication.getSession'),
};

// --- Language model API (LM) ---
export class LanguageModelChatMessage {
  constructor(public readonly role: number, public readonly content: string) {}
  static User(content: string): LanguageModelChatMessage { return new LanguageModelChatMessage(0, content); }
  static Assistant(content: string): LanguageModelChatMessage { return new LanguageModelChatMessage(1, content); }
}
export const lm = {
  selectChatModels: async () => [],
};

// --- Misc constants used by the bundle ---
export enum ViewColumn { One = 1, Two = 2, Three = 3, Active = -1, Beside = -2 }
export enum ProgressLocation { Notification = 15, SourceControl = 1, Window = 10 }
export class CancellationTokenSource { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }; cancel() {} dispose() {} }
export class Disposable { static from(...d: { dispose(): void }[]) { return { dispose() { d.forEach(x => x.dispose()); } }; } constructor(_fn?: () => void) {} dispose() {} }
export class EventEmitter<T> { event = (_listener: (e: T) => void) => ({ dispose: () => {} }); fire(_data: T) {} dispose() {} }
export class CancellationError extends Error { constructor() { super('Canceled'); this.name = 'CancellationError'; } }
