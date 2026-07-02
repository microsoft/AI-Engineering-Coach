/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Minimal markdown-to-HTML renderer for the self-contained CLI report page. */

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PAGE_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #0f172a;
    --card: #111827;
    --text: #e5e7eb;
    --muted: #9ca3af;
    --border: #374151;
    --accent: #60a5fa;
  }

  body {
    margin: 0;
    padding: 40px;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
  }

  main {
    max-width: 980px;
    margin: 0 auto;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 32px;
    box-shadow: 0 24px 80px rgba(0,0,0,.25);
  }

  h1 {
    font-size: 38px;
    letter-spacing: -0.04em;
    margin: 0 0 16px;
  }

  h2 {
    margin-top: 36px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    font-size: 24px;
  }

  h3 {
    margin-top: 24px;
    color: var(--accent);
  }

  p {
    color: var(--muted);
  }

  li {
    margin: 6px 0;
  }

  ol, ul {
    padding-left: 24px;
  }
`;

interface ListState {
  inList: boolean;
  inOrderedList: boolean;
}

function closeLists(state: ListState, body: string[]): void {
  if (state.inList) {
    body.push('</ul>');
    state.inList = false;
  }

  if (state.inOrderedList) {
    body.push('</ol>');
    state.inOrderedList = false;
  }
}

function renderLine(line: string, state: ListState, body: string[]): void {
  if (line.startsWith('### ')) {
    closeLists(state, body);
    body.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    return;
  }

  if (line.startsWith('## ')) {
    closeLists(state, body);
    body.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    return;
  }

  if (line.startsWith('# ')) {
    closeLists(state, body);
    body.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    return;
  }

  if (line.startsWith('- ')) {
    if (!state.inList) {
      closeLists(state, body);
      body.push('<ul>');
      state.inList = true;
    }

    body.push(`<li>${escapeHtml(line.slice(2))}</li>`);
    return;
  }

  if (/^\d+\.\s+/.test(line)) {
    if (!state.inOrderedList) {
      closeLists(state, body);
      body.push('<ol>');
      state.inOrderedList = true;
    }

    body.push(`<li>${escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`);
    return;
  }

  closeLists(state, body);
  body.push(`<p>${escapeHtml(line)}</p>`);
}

export function markdownToHtml(markdown: string): string {
  const body: string[] = [];
  const state: ListState = { inList: false, inOrderedList: false };

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      closeLists(state, body);
      continue;
    }

    renderLine(line, state, body);
  }

  closeLists(state, body);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI Engineer Coach Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${body.join('\n')}
</main>
</body>
</html>
`;
}
