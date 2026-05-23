/*---------------------------------------------------------------------------------------------
 *  Resolve UI language for webviews (extension host).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveLocale, type Locale } from './webview/i18n';

export function getUiLanguageTag(): string {
  const pref = vscode.workspace.getConfiguration('aiEngineerCoach').get<string>('locale', 'auto');
  if (pref === 'en') return 'en';
  if (pref === 'ru') return 'ru';
  return vscode.env.language;
}

export function getUiLocale(): Locale {
  return resolveLocale(getUiLanguageTag());
}
