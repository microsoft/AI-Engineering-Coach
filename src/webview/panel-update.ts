/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The dashboard's side of the update check: answers the build stamp footer's requests, even
 * before the data is ready, and pushes status changes to it. The webview never chooses what to
 * install; the update service confirms natively first. */

import type * as vscode from 'vscode';
import { runtimeDebug } from '../core/runtime-debug';
import type { UpdateStatusMessage } from '../core/types';
import { getUpdateService } from '../update/update-service';
import { postResponse, type RequestMessage } from './panel-shared';

const UPDATE_METHODS: ReadonlySet<string> = new Set(['getUpdateStatus', 'promptUpdate', 'reloadAfterUpdate']);

/** Answers the footer's update requests; returns false for every other request. */
export function tryHandleUpdateRequest(webview: vscode.Webview, msg: RequestMessage): boolean {
  if (!UPDATE_METHODS.has(msg.method)) return false;
  const updates = getUpdateService();
  if (msg.method === 'getUpdateStatus') {
    try { postResponse(webview, msg.id, updates?.getStatus() ?? { state: 'none' }); } catch { /* disposed */ }
    return true;
  }
  const action = msg.method === 'promptUpdate' ? updates?.promptInstall() : updates?.reloadAfterUpdate();
  void action?.catch((err: unknown) => runtimeDebug('update', 'webview-action-error', err));
  try { postResponse(webview, msg.id, { ok: updates !== undefined }); } catch { /* disposed */ }
  return true;
}

/** Pushes every status change to the webview until `disposables` are disposed. */
export function forwardUpdateStatus(webview: vscode.Webview, disposables: vscode.Disposable[]): void {
  getUpdateService()?.onDidChangeStatus(status => {
    const message: UpdateStatusMessage = { type: 'updateStatus', status };
    try {
      Promise.resolve(webview.postMessage(message)).catch(() => undefined);
    } catch { /* disposed */ }
  }, null, disposables);
}
