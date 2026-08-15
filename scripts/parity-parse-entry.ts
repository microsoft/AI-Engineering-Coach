/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Parse-parity entry. Bundled and run once per source tree by scripts/parse-parity.ts.
 *
 * It parses the real local logs with `parseAllLogs` and writes a deterministic, canonical
 * representation of the ParseResult (stable key order, sorted collections) as NDJSON, plus a
 * SHA-256 of that text. Two trees that produce the same SHA produced byte-for-byte identical
 * parsed output — the check this repo uses to prove a refactor (e.g. the O(n^2) JSONL streaming
 * fix) changed performance only, not the parsed result.
 *
 * Usage (driven by parse-parity.ts, not run directly):
 *   node <bundle>.cjs <outNdjsonPath>
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { findLogsDirs, parseAllLogs } from '../src/core/parser';

/** Recursively sort object keys so serialization is independent of insertion order. */
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function stable(v: unknown): string {
  return JSON.stringify(sortValue(v));
}

function main(): void {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('usage: <bundle>.cjs <outNdjsonPath>');

  const dirs = findLogsDirs();
  const result = parseAllLogs(dirs);

  const lines: string[] = [];

  // Workspaces — keyed and sorted by id.
  for (const id of [...result.workspaces.keys()].sort()) {
    lines.push(`WS\t${id}\t${stable(result.workspaces.get(id))}`);
  }

  // Sessions — sorted by sessionId so readdir ordering between trees cannot cause a false diff.
  const sessions = [...result.sessions].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0,
  );
  for (const s of sessions) lines.push(`SESSION\t${s.sessionId}\t${stable(s)}`);

  // Edit-location index — Map<requestId, Map<uri, linesAdded>>.
  for (const reqId of [...result.editLocIndex.keys()].sort()) {
    const inner = result.editLocIndex.get(reqId)!;
    const obj: Record<string, number> = {};
    for (const uri of [...inner.keys()].sort()) obj[uri] = inner.get(uri)!;
    lines.push(`EDIT\t${reqId}\t${stable(obj)}`);
  }

  // Session-source index.
  for (const sid of [...result.sessionSourceIndex.keys()].sort()) {
    lines.push(`SRC\t${sid}\t${stable(result.sessionSourceIndex.get(sid))}`);
  }

  const body = lines.join('\n');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(outPath, body);
  fs.writeFileSync(`${outPath}.sha256`, sha);

  // eslint-disable-next-line no-console
  console.log(
    `  sessions=${result.sessions.length} workspaces=${result.workspaces.size} ` +
      `editLoc=${result.editLocIndex.size} sources=${result.sessionSourceIndex.size} sha256=${sha}`,
  );
}

main();
