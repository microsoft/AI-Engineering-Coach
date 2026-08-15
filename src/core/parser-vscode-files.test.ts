/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  reconstructFromJsonl,
  stripImageData,
  readFile,
  forEachJsonlLine,
  forEachJsonlLineAsync,
  parseWorkspaceName,
  parseWorkspaceFolderPath,
  parseCLIWorkspaceName,
  parseCLIWorkspaceFolderPath,
} from './parser-vscode-files';
import { prefetchCache } from './parser-shared';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-pvf-'));
  tempDirs.push(dir);
  return dir;
}

function withTempFile(name: string, content: string, run: (filePath: string) => void): void {
  const dir = makeTempDir();
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  run(filePath);
}

/** Write a temp file and return its path (for async tests that can't use the callback form). */
function makeTempFile(name: string, content: string): string {
  const dir = makeTempDir();
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readFile', () => {
  it('reads a file within trusted paths', () => {
    const dir = makeTempDir();
    const fp = path.join(dir, 'test.txt');
    fs.writeFileSync(fp, 'hello world', 'utf-8');
    expect(readFile(fp)).toBe('hello world');
  });

  it('throws for path traversal', () => {
    expect(() => readFile('/foo/../bar/../../etc/passwd')).toThrow();
  });
});

describe('stripImageData', () => {
  it('returns input unchanged when no image markers present', () => {
    const input = '{"kind":"text","value":"hello"}';
    expect(stripImageData(input)).toBe(input);
  });

  it('strips kind:image value objects', () => {
    const input = '{"kind":"image","value":{"data":"base64stuff","mimeType":"image/png"}}';
    const result = stripImageData(input);
    expect(result).toContain('"[stripped]"');
    expect(result).not.toContain('base64stuff');
  });

  it('strips JPEG byte arrays', () => {
    const input = `{"data":[255,216,255,0,1,2,3,4,5,6,7,8,9]}`;
    const result = stripImageData(input);
    expect(result).toBe('{"data":[]}');
  });

  it('strips PNG byte arrays', () => {
    const input = `{"data":[137,80,78,71,0,1,2,3,4,5,6,7,8,9]}`;
    const result = stripImageData(input);
    expect(result).toBe('{"data":[]}');
  });

  it('preserves non-image data arrays', () => {
    const input = `{"data":[1,2,3,4,5]}`;
    expect(stripImageData(input)).toBe(input);
  });
});

describe('reconstructFromJsonl', () => {
  it('rebuilds state from replace, set, and append records', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { messages: [], meta: { workspace: 'demo' } } }),
      JSON.stringify({ kind: 2, k: ['messages'], v: [{ role: 'user', content: 'hello' }] }),
      JSON.stringify({ kind: 1, k: ['meta', 'model'], v: 'gpt-4.1' }),
    ].join('\n');

    withTempFile('state.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath);
      expect(state).not.toBeNull();
      expect(state).toMatchObject({
        messages: [{ role: 'user', content: 'hello' }],
        meta: { workspace: 'demo', model: 'gpt-4.1' },
      });
    });
  });

  it('returns null for malformed jsonl input', () => {
    withTempFile('broken.jsonl', '{not valid json}\n', (filePath) => {
      expect(reconstructFromJsonl(filePath)).toBeNull();
    });
  });

  it('returns null for empty file', () => {
    withTempFile('empty.jsonl', '', (filePath) => {
      expect(reconstructFromJsonl(filePath)).toBeNull();
    });
  });

  it('handles kind 0 replace that resets state', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { data: 'old' } }),
      JSON.stringify({ kind: 0, v: { data: 'new', extra: true } }),
    ].join('\n');
    withTempFile('reset.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath);
      expect(state).toEqual({ data: 'new', extra: true });
    });
  });

  it('skips malformed lines without aborting', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { count: 1 } }),
      'INVALID JSON LINE',
      JSON.stringify({ kind: 1, k: ['count'], v: 42 }),
    ].join('\n');
    withTempFile('partial.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath);
      expect(state).toEqual({ count: 42 });
    });
  });

  it('handles nested set operations', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { a: { b: {} } } }),
      JSON.stringify({ kind: 1, k: ['a', 'b', 'c'], v: 'deep' }),
    ].join('\n');
    withTempFile('nested.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath);
      expect(state).toEqual({ a: { b: { c: 'deep' } } });
    });
  });

  it('handles append with array indices', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { items: [['a', 'b']] } }),
      JSON.stringify({ kind: 2, k: ['items', 0], v: ['c'] }),
    ].join('\n');
    withTempFile('arr.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath);
      expect(state).toEqual({ items: [['a', 'b', 'c']] });
    });
  });

  it('preserves initial plan mode even when later patches overwrite it', () => {
    const planUri = 'vscode-userdata:/Users/me/.vscode/agents/plan-agent/Plan.agent.md';
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'test-plan',
          inputState: { mode: { id: planUri, kind: 'agent' } },
          requests: [],
        },
      }),
      // VS Code patches mode to "agent" when executing
      JSON.stringify({ kind: 1, k: ['inputState', 'mode'], v: { id: 'agent', kind: 'agent' } }),
    ].join('\n');
    withTempFile('plan-overwrite.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath) as Record<string, unknown>;
      const is = state.inputState as Record<string, unknown>;
      const mode = is.mode as Record<string, unknown>;
      expect(mode.id).toBe(planUri);
    });
  });

  it('preserves initial agent mode when no patches overwrite it', () => {
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'test-agent',
          inputState: { mode: { id: 'agent', kind: 'agent' } },
          requests: [],
        },
      }),
      JSON.stringify({ kind: 1, k: ['requests', 0], v: { text: 'hello' } }),
    ].join('\n');
    withTempFile('agent-noop.jsonl', lines, (filePath) => {
      const state = reconstructFromJsonl(filePath) as Record<string, unknown>;
      const is = state.inputState as Record<string, unknown>;
      const mode = is.mode as Record<string, unknown>;
      expect(mode.id).toBe('agent');
    });
  });

  it('does not pollute Object.prototype via a __proto__ set path', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { ok: true } }),
      JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: 'pwned' }),
    ].join('\n');
    withTempFile('proto-set.jsonl', lines, (filePath) => {
      reconstructFromJsonl(filePath);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  it('does not pollute Object.prototype via a constructor.prototype append path', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { ok: true } }),
      JSON.stringify({ kind: 2, k: ['constructor', 'prototype', 'tainted'], v: ['x'] }),
    ].join('\n');
    withTempFile('proto-append.jsonl', lines, (filePath) => {
      reconstructFromJsonl(filePath);
      expect(({} as Record<string, unknown>).tainted).toBeUndefined();
    });
  });
});

describe('parseWorkspaceName', () => {
  it('extracts workspace name from workspace.json folder field', () => {
    const dir = makeTempDir();
    const wsJson = path.join(dir, 'workspace.json');
    fs.writeFileSync(wsJson, JSON.stringify({ folder: 'file:///Users/me/projects/my-app' }));
    expect(parseWorkspaceName(wsJson)).toBe('my-app');
  });

  it('extracts workspace name from workspace field', () => {
    const dir = makeTempDir();
    const wsJson = path.join(dir, 'workspace.json');
    fs.writeFileSync(wsJson, JSON.stringify({ workspace: 'file:///Users/me/projects/cool-project' }));
    expect(parseWorkspaceName(wsJson)).toBe('cool-project');
  });

  it('returns unknown for missing file', () => {
    expect(parseWorkspaceName('/nonexistent/workspace.json')).toBe('unknown');
  });

  it('returns unknown when no folder/workspace field', () => {
    const dir = makeTempDir();
    const wsJson = path.join(dir, 'workspace.json');
    fs.writeFileSync(wsJson, JSON.stringify({ other: 'stuff' }));
    expect(parseWorkspaceName(wsJson)).toBe('unknown');
  });

  it('handles URL-encoded paths', () => {
    const dir = makeTempDir();
    const wsJson = path.join(dir, 'workspace.json');
    fs.writeFileSync(wsJson, JSON.stringify({ folder: 'file:///Users/me/My%20Projects/app' }));
    expect(parseWorkspaceName(wsJson)).toBe('app');
  });
});

describe('parseWorkspaceFolderPath', () => {
  it('returns absolute folder path', () => {
    const dir = makeTempDir();
    const wsJson = path.join(dir, 'workspace.json');
    fs.writeFileSync(wsJson, JSON.stringify({ folder: 'file:///Users/me/projects/my-app' }));
    expect(parseWorkspaceFolderPath(wsJson)).toBe('/Users/me/projects/my-app');
  });

  it('returns null for relative paths', () => {
    const dir = makeTempDir();
    const wsJson = path.join(dir, 'workspace.json');
    fs.writeFileSync(wsJson, JSON.stringify({ folder: 'relative/path' }));
    expect(parseWorkspaceFolderPath(wsJson)).toBeNull();
  });

  it('returns null for missing file', () => {
    expect(parseWorkspaceFolderPath('/nonexistent/workspace.json')).toBeNull();
  });
});

describe('parseCLIWorkspaceName', () => {
  it('extracts workspace name from cwd line in yaml', () => {
    const dir = makeTempDir();
    const wsYaml = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(wsYaml, 'cwd: /Users/me/projects/my-cli-app\nother: stuff\n');
    expect(parseCLIWorkspaceName(wsYaml)).toBe('my-cli-app');
  });

  it('returns unknown when no cwd line', () => {
    const dir = makeTempDir();
    const wsYaml = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(wsYaml, 'other: stuff\n');
    expect(parseCLIWorkspaceName(wsYaml)).toBe('unknown');
  });

  it('returns unknown for missing file', () => {
    expect(parseCLIWorkspaceName('/nonexistent/workspace.yaml')).toBe('unknown');
  });
});

describe('parseCLIWorkspaceFolderPath', () => {
  it('returns absolute cwd path', () => {
    const dir = makeTempDir();
    const wsYaml = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(wsYaml, 'cwd: /Users/me/projects/my-app\n');
    expect(parseCLIWorkspaceFolderPath(wsYaml)).toBe('/Users/me/projects/my-app');
  });

  it('strips trailing slashes', () => {
    const dir = makeTempDir();
    const wsYaml = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(wsYaml, 'cwd: /Users/me/projects/my-app/\n');
    expect(parseCLIWorkspaceFolderPath(wsYaml)).toBe('/Users/me/projects/my-app');
  });

  it('returns null for relative cwd', () => {
    const dir = makeTempDir();
    const wsYaml = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(wsYaml, 'cwd: relative/path\n');
    expect(parseCLIWorkspaceFolderPath(wsYaml)).toBeNull();
  });

  it('returns null for missing file', () => {
    expect(parseCLIWorkspaceFolderPath('/nonexistent/workspace.yaml')).toBeNull();
  });
});

// Chunk size used by the streaming readers (mirrors JSONL_READ_CHUNK in parser-vscode-files.ts).
const READ_CHUNK = 1024 * 1024;

function collectLines(write: (onLine: (line: string) => void) => void): string[] {
  const lines: string[] = [];
  write((line) => lines.push(line));
  return lines;
}

describe('forEachJsonlLine (sync streaming reader)', () => {
  afterEach(() => prefetchCache.clear());

  it('emits each newline-delimited line without the trailing newline', () => {
    withTempFile('a.jsonl', 'one\ntwo\nthree\n', (fp) => {
      expect(collectLines((cb) => forEachJsonlLine(fp, cb))).toEqual(['one', 'two', 'three']);
    });
  });

  it('emits a final line that has no trailing newline', () => {
    withTempFile('a.jsonl', 'one\ntwo\nlast', (fp) => {
      expect(collectLines((cb) => forEachJsonlLine(fp, cb))).toEqual(['one', 'two', 'last']);
    });
  });

  it('emits empty lines between consecutive newlines', () => {
    withTempFile('a.jsonl', 'one\n\nthree\n', (fp) => {
      expect(collectLines((cb) => forEachJsonlLine(fp, cb))).toEqual(['one', '', 'three']);
    });
  });

  it('produces no lines for an empty file', () => {
    withTempFile('empty.jsonl', '', (fp) => {
      expect(collectLines((cb) => forEachJsonlLine(fp, cb))).toEqual([]);
    });
  });

  it('iterates a prefetched file from memory and consumes the cache entry', () => {
    withTempFile('p.jsonl', 'unused-on-disk\n', (fp) => {
      prefetchCache.set(fp, 'cached-one\ncached-two');
      expect(collectLines((cb) => forEachJsonlLine(fp, cb))).toEqual(['cached-one', 'cached-two']);
      // Cache entry is single-use: a second pass falls through to disk.
      expect(prefetchCache.has(fp)).toBe(false);
      expect(collectLines((cb) => forEachJsonlLine(fp, cb))).toEqual(['unused-on-disk']);
    });
  });

  it('reassembles a multibyte UTF-8 char split across the read-chunk boundary', () => {
    // Place a 3-byte '€' so its bytes straddle the 1MB chunk boundary: the StringDecoder must
    // carry the partial sequence to the next chunk instead of corrupting it (issue #106).
    const head = 'a'.repeat(READ_CHUNK - 2);
    withTempFile('wide.jsonl', `${head}\u20ac\nb`, (fp) => {
      const lines = collectLines((cb) => forEachJsonlLine(fp, cb));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`${head}\u20ac`);
      expect(lines[1]).toBe('b');
    });
  });

  it('emits a single line that spans many read chunks intact', () => {
    // A Copilot CLI events.jsonl line can embed tens of MB of inline base64. The reader must scan
    // only each freshly read chunk for newlines rather than re-splitting the whole growing buffer,
    // or one long line costs O(n^2) CPU (issue #106 follow-up). This line spans ~3.5 read chunks.
    const big = 'x'.repeat(READ_CHUNK * 3 + 512);
    withTempFile('huge.jsonl', `first\n${big}\nlast\n`, (fp) => {
      const lines = collectLines((cb) => forEachJsonlLine(fp, cb));
      expect(lines).toEqual(['first', big, 'last']);
    });
  });
});

describe('forEachJsonlLineAsync (async streaming reader)', () => {
  afterEach(() => prefetchCache.clear());

  it('emits the same lines as the sync reader', async () => {
    const fp = makeTempFile('a.jsonl', 'one\ntwo\nlast');
    const lines: string[] = [];
    await forEachJsonlLineAsync(fp, (line) => lines.push(line));
    expect(lines).toEqual(['one', 'two', 'last']);
  });

  it('emits a single line that spans many read chunks intact', async () => {
    // Guards the same O(n^2) regression as the sync reader: the async cold-parse path streams the
    // large CLI events.jsonl files, where a single inline-base64 line can span many chunks.
    const big = 'y'.repeat(READ_CHUNK * 3 + 512);
    const fp = makeTempFile('huge-async.jsonl', `first\n${big}\nlast\n`);
    const lines: string[] = [];
    await forEachJsonlLineAsync(fp, (line) => lines.push(line));
    expect(lines).toEqual(['first', big, 'last']);
  });

  it('reports final byte progress equal to the file size', async () => {
    const fp = makeTempFile('a.jsonl', 'one\ntwo\n');
    const total = fs.statSync(fp).size;
    const progress: Array<[number, number]> = [];
    await forEachJsonlLineAsync(fp, () => { /* noop */ }, (read, t) => progress.push([read, t]));
    expect(progress.at(-1)).toEqual([total, total]);
  });

  it('iterates a prefetched file from memory and reports its length as progress', async () => {
    const fp = makeTempFile('p.jsonl', 'unused\n');
    prefetchCache.set(fp, 'cached-one\ncached-two');
    const lines: string[] = [];
    const progress: Array<[number, number]> = [];
    await forEachJsonlLineAsync(fp, (line) => lines.push(line), (read, t) => progress.push([read, t]));
    expect(lines).toEqual(['cached-one', 'cached-two']);
    expect(progress.at(-1)).toEqual(['cached-one\ncached-two'.length, 'cached-one\ncached-two'.length]);
    expect(prefetchCache.has(fp)).toBe(false);
  });
});
