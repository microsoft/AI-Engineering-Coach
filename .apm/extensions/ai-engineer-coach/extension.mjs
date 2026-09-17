/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Canvas extension entry point. Serves the AI Engineer Coach dashboard as a
 * Copilot app canvas. Owns a single loopback HTTP server and decides per request
 * whether the project is built: if not, it serves a setup guide; once built, it
 * hands every request to the bundled canvas host (dist/canvas-host.cjs). */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const require = createRequire(import.meta.url);

// Anchor to this file's location (.apm/extensions/ai-engineer-coach — the apm package
// source, loaded either via a forwarding stub at .github/extensions/ai-engineer-coach/ in
// this repo, or via a copy `apm install --target copilot` deploys into a consumer's
// .github/extensions/), not the process cwd: a forked canvas extension runs with cwd set
// to the Copilot home.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const distDir = path.join(repoRoot, "dist");
const repoName = path.basename(repoRoot);

const appJsPath = path.join(distDir, "webview", "app.js");
const hostCjsPath = path.join(distDir, "canvas-host.cjs");

const BUILD_COMMAND = "npm install && npm run build";

function isBuilt() {
  return fs.existsSync(appJsPath) && fs.existsSync(hostCjsPath);
}

let host;
function ensureHost() {
  if (host) return host;
  if (!isBuilt()) return undefined;
  // A stale or malformed build can throw on require/start; swallow it so the
  // request handler falls through to the recoverable setup page instead of
  // crashing the forked extension process.
  try {
    const { createCanvasHost } = require(hostCjsPath);
    host = createCanvasHost({ distDir, repoName });
    host.start();
    return host;
  } catch (err) {
    host = undefined;
    console.error(`AI Engineer Coach: failed to start canvas host. Run: ${BUILD_COMMAND}`, err);
    return undefined;
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ built: ensureHost() !== undefined }));
    return;
  }

  const active = ensureHost();
  if (active) {
    active.handle(req, res);
    return;
  }

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupHtml());
    return;
  }

  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end("Build required");
});

server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const canvas = createCanvas({
  id: "dashboard",
  displayName: "AI Engineer Coach",
  description:
    "Local AI coding analytics dashboard: sessions, output, anti-patterns, and context health derived from your on-disk agent logs. Agent-dependent features are read-only in canvas mode.",
  inputSchema: {
    type: "object",
    description:
      "No input required. The dashboard reads your local AI coding session logs from disk.",
    properties: {},
    additionalProperties: false,
  },
  open() {
    return {
      url: baseUrl,
      title: "AI Engineer Coach",
      status: isBuilt() ? "Loading dashboard" : "Build required",
    };
  },
});

const session = await joinSession({ canvases: [canvas] });
await session.log(
  isBuilt()
    ? `AI Engineer Coach canvas ready for session ${session.sessionId}.`
    : `AI Engineer Coach canvas loaded, build required. Run: ${BUILD_COMMAND}`,
);

function setupHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI Engineer Coach — Setup</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117; color: #e6edf3; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 32px;
  }
  .card {
    max-width: 560px; width: 100%; background: #161b22;
    border: 1px solid #30363d; border-radius: 12px; padding: 32px;
  }
  .icon { width: 44px; height: 44px; color: #d29922; margin-bottom: 16px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  p { color: #8b949e; font-size: 14px; line-height: 1.6; margin-bottom: 16px; }
  .cmd {
    display: flex; align-items: center; gap: 12px; background: #0d1117;
    border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px;
    font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace; font-size: 13px;
  }
  .cmd code { flex: 1; color: #e6edf3; user-select: all; }
  button {
    border: 1px solid #30363d; background: #21262d; color: #e6edf3;
    border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #30363d; }
  .row { display: flex; gap: 10px; margin-top: 20px; align-items: center; }
  .status { font-size: 12px; color: #8b949e; }
  .steps { margin: 16px 0; padding-left: 18px; }
  .steps li { color: #8b949e; font-size: 13px; line-height: 1.7; }
  .note {
    margin-top: 20px; padding: 12px 14px; background: #0d1117;
    border: 1px solid #30363d; border-radius: 8px; font-size: 12px; color: #8b949e;
  }
</style>
</head>
<body>
<div class="card">
  <svg class="icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 1l6 3.5v7L8 15l-6-3.5v-7L8 1z" stroke="currentColor" stroke-width="1.1" fill="none"/>
    <path d="M8 5.2a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6z" stroke="currentColor" stroke-width="1.1" fill="none"/>
  </svg>
  <h1>Build required</h1>
  <p>This project has not been built yet. Build it once, then this panel loads the full dashboard automatically.</p>
  <div class="cmd">
    <code id="cmd">${BUILD_COMMAND}</code>
    <button id="copy" type="button">Copy</button>
  </div>
  <ol class="steps">
    <li>Open a terminal in the repository root (<code>${repoName}</code>).</li>
    <li>Run the command above to install dependencies and build.</li>
    <li>This panel detects the build and reloads on its own.</li>
  </ol>
  <div class="row">
    <button id="retry" type="button">Retry now</button>
    <span class="status" id="status">Watching for a completed build...</span>
  </div>
  <div class="note">
    Skill Finder, Learning quizzes, and context review need the local VS Code agent. They appear read-only in canvas mode.
  </div>
</div>
<script>
  document.getElementById('copy').addEventListener('click', function () {
    navigator.clipboard.writeText(document.getElementById('cmd').textContent).then(function () {
      var b = document.getElementById('copy'); b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500);
    });
  });
  document.getElementById('retry').addEventListener('click', function () { location.reload(); });
  setInterval(function () {
    fetch('/status').then(function (r) { return r.json(); }).then(function (s) {
      if (s.built) { document.getElementById('status').textContent = 'Build detected, loading...'; location.reload(); }
    }).catch(function () {});
  }, 2500);
</script>
</body>
</html>`;
}
