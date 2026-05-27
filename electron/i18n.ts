/*---------------------------------------------------------------------------------------------
 *  AI Engineer Coach Desktop -- i18n module (main process)
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/* i18next setup for the Electron main process. Locale JSON files are bundled
 * alongside the app and loaded synchronously at startup. Webview consumes the
 * translations via the `i18n:t` IPC channel; the main process owns the source
 * of truth so the system menu and webview stay in sync.
 */

import i18next from 'i18next';
import * as fs from 'fs';
import * as path from 'path';

export const SUPPORTED_LANGS = ['en', 'ru', 'uk'] as const;
export type Lang = typeof SUPPORTED_LANGS[number];

const localesDir = path.join(__dirname, 'locales');

function loadLocaleFile(lang: Lang): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(localesDir, `${lang}.json`), 'utf8'));
  } catch {
    return {};
  }
}

export async function initI18n(initialLang: Lang = 'en'): Promise<void> {
  const resources: Record<string, { translation: Record<string, unknown> }> = {};
  for (const lang of SUPPORTED_LANGS) {
    resources[lang] = { translation: loadLocaleFile(lang) };
  }

  await i18next.init({
    lng: initialLang,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGS as unknown as string[],
    interpolation: { escapeValue: false },
    resources,
  });
}

export async function changeLanguage(lang: Lang): Promise<void> {
  await i18next.changeLanguage(lang);
}

export function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, opts) as string;
}

export function getCurrentLang(): Lang {
  return (i18next.language as Lang) || 'en';
}

export function getAllTranslations(): Record<Lang, Record<string, unknown>> {
  const all = {} as Record<Lang, Record<string, unknown>>;
  for (const lang of SUPPORTED_LANGS) {
    all[lang] = loadLocaleFile(lang);
  }
  return all;
}
