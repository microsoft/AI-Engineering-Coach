/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The browser suite must reach its server only through tests/e2e/harness-url.ts, so E2E_PORT moves
// the web server, every spec and the served-build check together. A literal host or port still
// passes in CI, which uses the default port, but fails or tests another server on any other port.
// This guard lives here because Playwright would also collect a *.test.ts file under tests/e2e.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = new Set(['tests/e2e/harness-url.ts']);
// Scripts and pages, which can request a URL; data files such as JSON may record real addresses.
const SCANNED = /\.(?:[cm]?[jt]sx?|html?)$/i;
// Comments document the defaults; they do not build URLs.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const HOST = String.raw`localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0`;
// A loopback host in a URL, before a port or as a whole string; any http(s) URL with a port; the
// default port itself. Prose such as "the server on localhost" in mock data is not an address.
const HARD_CODED = new RegExp([
  String.raw`(?://|@)(?:${HOST})`,
  String.raw`(?:${HOST}):(?:\d|\$\{)`,
  String.raw`(?<quote>['"\x60])(?:${HOST}|::1)\k<quote>`,
  String.raw`\bhttps?://[^\s'"\x60/]+:(?:\d|\$\{)`,
  String.raw`(?<![\d.])3999(?!\d)`,
].join('|'), 'i');

function hardCodedUrls(text: string): { line: number; text: string }[] {
  return text.split(/\r?\n/).flatMap((line, index) =>
    !COMMENT_LINE.test(line) && HARD_CODED.test(line) ? [{ line: index + 1, text: line.trim() }] : []);
}

function scannedFiles(dir = 'tests/e2e'): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return scannedFiles(file);
    return SCANNED.test(entry.name) && !ALLOWED.has(file) ? [file] : [];
  });
}

describe('browser suite server URLs', () => {
  it.each([
    "await page.goto('http://localhost:3999/tests/e2e/harness.html');",
    'const origin = `127.0.0.1:${port}`;',
    'command: `npx serve . --listen tcp://[::1]:${port}`,',
    "const socket = net.connect(port, '::1');",
    'await fetch(`http://${host}:${port}/dist/webview/app.js`);',
    "const mock = 'https://example.test:8443/report';",
    'webServer: { port: 3999 },',
  ])('flags %s', line => {
    expect(hardCodedUrls(line)).toHaveLength(1);
  });

  it.each([
    "await page.goto(harnessUrl('tests/e2e/harness?page=curiosity'));",
    "url: 'https://github.com/github/awesome-copilot/tree/main/skills/review',",
    "messageText: 'The dev server on localhost stopped responding.',",
    '// E2E_PORT (default 3999) picks the port.',
    ' * Served on http://localhost:3999 unless E2E_PORT is set.',
    'const tokens = 13999 + 39990 + 0.3999;',
  ])('allows %s', line => {
    expect(hardCodedUrls(line)).toEqual([]);
  });

  it('finds no hard-coded host or port in the browser suite or its config', () => {
    const files = ['playwright.config.ts', ...scannedFiles()];
    expect(files).toEqual(expect.arrayContaining(['tests/e2e/global-setup.ts', 'tests/e2e/harness.html', 'tests/e2e/curiosity.spec.ts']));
    const findings = files.flatMap(file => hardCodedUrls(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .map(found => `${file}:${found.line}: ${found.text}`));
    expect(findings, 'Build e2e server URLs with harnessUrl() from tests/e2e/harness-url.ts (e2ePort() for a bare port) '
      + 'instead of a literal host or port. Mock data can use a host such as example.test without a port').toEqual([]);
  });
});
