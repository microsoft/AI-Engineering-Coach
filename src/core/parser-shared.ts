/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Shared parsing utilities used by all harness-specific parsers */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeBlock, Session, SessionRequest, Workspace } from './types';
import { SessionSource } from './cache';
import { classifyWorkType } from './helpers';
import { warnCore } from './log';
import { SessionSchema } from './schemas';

/* ---- Path safety ---- */

/**
 * Validates that a file path is within trusted directories and does not
 * contain path traversal sequences. Throws if the path is unsafe.
 */
export function assertTrustedPath(filePath: string): void {
  const normalized = path.resolve(filePath);

  // Reject path traversal
  const segments = filePath.replaceAll('\\', '/').split('/');
  if (segments.includes('..')) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }

  const trustedRoots = getTrustedRoots();
  const isTrusted = trustedRoots.some(root => normalized.startsWith(root + path.sep) || normalized === root);
  if (!isTrusted) {
    throw new Error(`Path is outside trusted directories: ${filePath}`);
  }
}

function getTrustedRoots(): string[] {
  const roots: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) roots.push(path.resolve(home));

  // VS Code extension storage paths
  if (process.platform === 'darwin') {
    if (home) roots.push(path.resolve(home, 'Library', 'Application Support', 'Code'));
    if (home) roots.push(path.resolve(home, 'Library', 'Application Support', 'Code - Insiders'));
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || '';
    if (appdata) {
      roots.push(path.resolve(appdata, 'Code'));
      roots.push(path.resolve(appdata, 'Code - Insiders'));
    }
  } else {
    if (home) roots.push(path.resolve(home, '.config', 'Code'));
    if (home) roots.push(path.resolve(home, '.config', 'Code - Insiders'));
  }

  // Standard session log locations
  if (home) {
    roots.push(path.resolve(home, '.copilot'));
    roots.push(path.resolve(home, '.claude'));
    roots.push(path.resolve(home, '.codex'));
    roots.push(path.resolve(home, '.local', 'share', 'opencode'));
    roots.push(path.resolve(home, '.config', 'github-copilot'));
  }

  // OS temp directory (used by tests and VS Code temp storage)
  const tmpDir = os.tmpdir();
  if (tmpDir) roots.push(path.resolve(tmpDir));

  return roots.filter(r => r.length > 0);
}

/* ---- OOM protection ---- */

/** Maximum file size (50 MB) that parsers will read into memory. */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Reads a file safely, returning null (with a warning) if the file exceeds MAX_FILE_SIZE.
 */
export function readFileSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      warnCore('parser', `Skipping oversized file (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${filePath}`);
      return null;
    }
  } catch (e) {
    warnCore('parser', `Cannot stat file: ${filePath}`, e);
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/** Shared prefetch cache: file path -> contents. Populated async, consumed sync by parsers. */
export const prefetchCache = new Map<string, string>();

export const CODE_BLOCK_RE = /```(\w+)?\n([\s\S]*?)```/g;

const MAX_STORED_MESSAGE_CHARS = 16_000;
const MAX_STORED_RESPONSE_CHARS = 24_000;
const MAX_CODE_SCAN_CHARS = 128_000;

export const LANG_ALIASES: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash',
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  py: 'python', python3: 'python',
  cs: 'csharp', 'c#': 'csharp',
  yml: 'yaml', md: 'markdown',
  tf: 'terraform', rs: 'rust', rb: 'ruby',
  jsonc: 'json', jsonl: 'json',
  txt: 'text', plaintext: 'text', env: 'dotenv',
};

const EXT_TO_TECH: Record<string, string> = {
  py: 'Python', pyx: 'Python', pyi: 'Python',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', jsx: 'React',
  java: 'Java', cs: 'C#', csx: 'C#',
  go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP',
  swift: 'Swift', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  html: 'HTML', htm: 'HTML',
  css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS',
  json: 'JSON', jsonc: 'JSON', jsonl: 'JSON',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  ps1: 'PowerShell', psm1: 'PowerShell',
  tf: 'Terraform', tfvars: 'Terraform', bicep: 'Bicep',
  md: 'Markdown', mdx: 'Markdown',
  dockerfile: 'Docker', r: 'R', lua: 'Lua', dart: 'Dart',
  vue: 'Vue', svelte: 'Svelte', ipynb: 'Jupyter',
  proto: 'Protobuf', graphql: 'GraphQL', gql: 'GraphQL',
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  csharp: 'C#', rust: 'Rust', ruby: 'Ruby',
  terraform: 'Terraform', text: 'Text', dotenv: 'Dotenv',
  mermaid: 'Mermaid', tex: 'LaTeX', latex: 'LaTeX',
  properties: 'Properties', ini: 'INI',
  gitignore: 'Git Config', ignore: 'Git Config', dockerignore: 'Docker',
  powershell: 'PowerShell', hcl: 'Terraform',
  log: 'Log', diff: 'Diff', csv: 'CSV', svg: 'XML',
  console: 'Shell', azurecli: 'Shell', dotnetcli: 'Shell',
  makefile: 'Make', bicepparam: 'Bicep',
};

export function techFromPath(filePath: string): string {
  const name = filePath.replaceAll('\\', '/').split('/').pop()!.toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'Docker';
  if (name === 'makefile' || name === 'gnumakefile') return 'Make';
  if (name === 'cmakelists.txt') return 'CMake';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_TO_TECH[ext] || '';
}

export function shortPath(fullPath: string, workspaceName: string): string {
  const parts = fullPath.replaceAll('\\', '/').split('/');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === workspaceName) {
      return parts.slice(i + 1).join('/');
    }
  }
  return parts.length > 3 ? parts.slice(-3).join('/') : fullPath;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(CODE_BLOCK_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    let lang = (m[1] || 'unknown').toLowerCase().trim();
    lang = LANG_ALIASES[lang] || lang;
    const code = m[2].trim();
    const loc = code ? code.split('\n').length : 0;
    blocks.push({ language: lang, loc });
  }
  return blocks;
}

function compactTextForStorage(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.max(0, Math.floor(maxChars * 0.75));
  const tailChars = Math.max(0, maxChars - headChars - 64);
  const omitted = text.length - headChars - tailChars;
  const marker = `\n\n[truncated ${omitted.toLocaleString()} chars]\n\n`;
  return text.slice(0, headChars) + marker + text.slice(text.length - tailChars);
}

function textForCodeScan(text: string): string {
  if (text.length <= MAX_CODE_SCAN_CHARS) return text;
  return text.slice(0, MAX_CODE_SCAN_CHARS);
}

/* ---- Factories ---- */

/** Context object passed through all directory-level parsing operations. */
export interface ParseContext {
  workspaces: Map<string, Workspace>;
  sessions: Session[];
  editLocIndex: Map<string, Map<string, number>>;
  sessionSourceIndex: Map<string, SessionSource>;
  /** Running total of AI-generated lines of code (sum of all aiCode blocks). */
  aiLoc: number;
}

/** Creates a SessionRequest with sensible defaults; callers only supply non-default fields. */
export function createRequest(overrides: Partial<SessionRequest> & Pick<SessionRequest, 'messageText' | 'responseText'>): SessionRequest {
  const rawMsg = overrides.messageText;
  const rawResp = overrides.responseText;
  const msg = compactTextForStorage(rawMsg, MAX_STORED_MESSAGE_CHARS);
  const resp = compactTextForStorage(rawResp, MAX_STORED_RESPONSE_CHARS);
  const sanitizedTs = (overrides.timestamp != null && overrides.timestamp > 0) ? overrides.timestamp : null;
  const { timestamp: _ts, ...rest } = overrides;
  return {
    requestId: '',
    timestamp: sanitizedTs,
    isCanceled: false,
    agentName: '',
    agentMode: '',
    modelId: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    slashCommand: '',
    variableKinds: {},
    customInstructions: [],
    skillsUsed: [],
    firstProgress: null,
    totalElapsed: null,
    toolConfirmations: [],
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    compaction: null,
    todoSnapshot: null,
    reasoningEffort: null,
    ...rest,
    messageText: msg,
    responseText: resp,
    messageLength: rawMsg.length,
    responseLength: rawResp.length,
    userCode: overrides.userCode ?? extractCodeBlocks(textForCodeScan(rawMsg)),
    aiCode: overrides.aiCode ?? extractCodeBlocks(textForCodeScan(rawResp)),
    workType: overrides.workType || classifyWorkType(msg),
  };
}

/** Creates a Session with sensible defaults; callers only supply non-default fields. */
export function createSession(overrides: Partial<Session> & Pick<Session, 'sessionId' | 'workspaceId' | 'workspaceName' | 'harness' | 'requests'>): Session {
  const reqs = overrides.requests;
  const timestamps = reqs.map(r => r.timestamp).filter((t): t is number => t != null && t > 0);
  const computed = {
    creationDate: timestamps.length > 0 ? Math.min(...timestamps) : null,
    lastMessageDate: timestamps.length > 0 ? Math.max(...timestamps) : null,
  };
  const merged = {
    location: 'panel' as const,
    ...computed,
    requestCount: reqs.length,
    ...overrides,
  };
  // Sanitize session-level timestamps that came from overrides (e.g. raw file data with 0).
  if (merged.creationDate != null && merged.creationDate <= 0) merged.creationDate = computed.creationDate;
  if (merged.lastMessageDate != null && merged.lastMessageDate <= 0) merged.lastMessageDate = computed.lastMessageDate;
  return merged;
}

const DEVCONTAINER_PATH_RE = /(?:^|[\s=:"'`])\/workspaces\//;

export function detectDevcontainerFromRequests(requests: SessionRequest[], cwd?: string): boolean {
  if (typeof cwd === 'string' && cwd.startsWith('/workspaces/')) return true;
  for (const r of requests) {
    if (Array.isArray(r.toolConfirmations)) {
      for (const tc of r.toolConfirmations) {
        if (tc.isTerminal && typeof tc.commandLine === 'string' && DEVCONTAINER_PATH_RE.test(tc.commandLine)) {
          return true;
        }
      }
    }
    if (Array.isArray(r.editedFiles)) {
      for (const f of r.editedFiles) {
        if (typeof f === 'string' && f.startsWith('/workspaces/')) return true;
      }
    }
    if (Array.isArray(r.referencedFiles)) {
      for (const f of r.referencedFiles) {
        if (typeof f === 'string' && f.startsWith('/workspaces/')) return true;
      }
    }
  }
  return false;
}

/** Regex to extract the skill directory name from a path ending in `/skills/<name>/SKILL.md`. */
const SKILL_PATH_RE = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i;

/** Extract a skill name from a file path pointing to a SKILL.md file.
 *  Returns null if the path does not match the expected pattern. */
export function extractSkillNameFromPath(rawPath: string): string | null {
  const m = SKILL_PATH_RE.exec(rawPath);
  if (!m) return null;
  const name = m[1].trim();
  return (name && !name.includes('ai_toolkit')) ? name : null;
}

/** Regex to find SKILL.md path references embedded inside a larger string
 *  (e.g. a shell command line like `cat ~/.codex/skills/foo/SKILL.md`).
 *  The skill segment forbids whitespace and shell quote chars so the match
 *  cannot run past the path boundary. Slug-style names (the convention in
 *  the wild) are not affected by these restrictions. */
const SKILL_PATH_IN_TEXT_RE = /[/\\]skills[/\\][^\s/\\'"`]+[/\\]SKILL\.md/gi;

/** Extract all SKILL.md path references embedded in a string. Use this for
 *  harnesses whose tool calls expose shell commands or other free-form text
 *  rather than structured `file_path` arguments (e.g. Codex). For structured
 *  paths, prefer {@link extractSkillNameFromPath} directly. */
export function extractSkillPathsFromText(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  return text.match(SKILL_PATH_IN_TEXT_RE) || [];
}

/**
 * Optional validation gate that individual parsers can call before returning
 * sessions. Returns the session unchanged if valid, or null (with a warning)
 * if the session is malformed. Non-breaking: parsers may choose to skip this.
 */
export function validateSession(session: unknown, source: string): Session | null {
  const result = SessionSchema.safeParse(session);
  if (result.success) {
    return result.data as Session;
  }
  warnCore('schema', `Invalid session from ${source}: ${result.error.issues[0]?.message ?? 'unknown'}`);
  return null;
}
