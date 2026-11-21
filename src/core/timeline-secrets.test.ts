/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A synthetic secret corpus: fake credentials in the shapes people paste into prompts, commands and config, built at
 * run time so no token-shaped literal sits in the repository. No part of any of them may reach what the Timeline shows
 * of a lane's text, nor its dataset, the chat tool or the summary export. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatTimeline } from '../mcp/formatters';
import { Analyzer } from './analyzer';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { scrubText } from './session-labels';
import { buildSummaryExportFromAnalyzer } from './summary-export';
import { timelineSessionText } from './timeline-text';

let seed = 20261121;
function rand(alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor(seed / 65536) % alphabet.length];
  }
  return out;
}
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
/** Letters in both cases and digits, as generated keys are. */
const mixed = (n: number) => rand(ALNUM, n - 3) + rand(UPPER, 1) + rand(LOWER, 1) + rand(DIGITS, 1);
const b64 = (n: number) => mixed(n - 2) + '+/';
const urlSafe = (n: number) => mixed(n - 2) + '-_';
const hex = (n: number) => rand('0123456789abcdef', n);
/** A pass phrase: words that appear nowhere else in the corpus. */
const phrase = () => `${rand(LOWER, 7)} ${rand(LOWER, 6)} ${rand(LOWER, 8)}${rand(DIGITS, 2)}`;

interface Case { name: string; text: string; secrets: string[] }

function corpus(): Case[] {
  const c = (name: string, text: (s: string[]) => string, ...secrets: string[]): Case => ({ name, text: text(secrets), secrets });
  const keyBody = () => [b64(64), b64(64), b64(20)].join('\n');
  return [
    c('bearer header', ([t]) => `curl -H "Authorization: Bearer ${t}" https://api.example.com`, mixed(40)),
    c('other Authorization scheme', ([t]) => `Authorization: SharedKey demoacct:${t}=`, b64(43)),
    c('Authorization in JSON', ([t]) => `{"headers": {"Authorization": "token ${t}"}}`, mixed(30)),
    c('JWT', ([t]) => `the id token is ${t}`, `eyJ${urlSafe(20)}.${urlSafe(40)}.${urlSafe(43)}`),
    c('GitHub tokens', ([a, b, d, e, f]) => `${a} ${b} ${d} ${e}\nGH=${f}`, 'ghp_' + mixed(36), 'gho_' + mixed(36), 'ghs_' + mixed(36), 'ghu_' + mixed(36), `github_pat_11${rand(UPPER + DIGITS, 20)}_${mixed(59)}`),
    c('AWS', ([id, key]) => `aws configure set aws_access_key_id ${id}\naws_secret_access_key = ${key}`, 'AKIA' + rand(UPPER + DIGITS, 16), b64(40)),
    c('GCP', ([k, o, p, i]) => `key=${k} and ${o}\n{"private_key_id": "${i}", "private_key": "-----BEGIN PRIVATE KEY-----\\n${p}\\n-----END PRIVATE KEY-----\\n"}`,
      'AIza' + urlSafe(35), 'ya29.' + urlSafe(60), b64(64), hex(40)),
    c('Azure storage connection string', ([k]) => `DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${k}==;EndpointSuffix=core.windows.net`, b64(86)),
    c('Azure SAS', ([s]) => `BlobEndpoint=https://demo.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=${s}`, mixed(43)),
    c('SQL connection string', ([p]) => `Server=tcp:db.example.net;Database=app;User ID=app;Password=${p};Encrypt=true`, phrase()),
    c('Azure OpenAI key', ([k, s]) => `api-key: ${k}\nThen call it with ${s} as the key.`, hex(32), hex(32)),
    c('Azure DevOps PAT', ([p]) => `PAT ${p}`, rand('abcdefghijklmnopqrstuvwxyz234567', 52)),
    c('OpenAI and Anthropic keys', ([o, a]) => `OPENAI=${o}\nuse ${a}`, 'sk-proj-' + urlSafe(48), 'sk-ant-api03-' + urlSafe(80)),
    c('Slack, npm, GitLab, Hugging Face, Stripe, SendGrid', ([s, n, g, h, st, sg]) => [s, n, g, h, st, sg].join(' '),
      `xoxb-${rand(DIGITS, 12)}-${rand(DIGITS, 13)}-${mixed(24)}`, 'npm_' + mixed(36), 'glpat-' + urlSafe(20), 'hf_' + mixed(34), 'sk_live_' + mixed(24), `SG.${urlSafe(22)}.${urlSafe(43)}`),
    c('private key blocks', ([a, b, d, e]) => [
      `-----BEGIN RSA PRIVATE KEY-----\n${a}\n-----END RSA PRIVATE KEY-----`,
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${b}\n-----END OPENSSH PRIVATE KEY-----`,
      `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${d}\n-----END PGP PRIVATE KEY BLOCK-----`,
      `paste: -----BEGIN EC PRIVATE KEY-----\n${e}`,
    ].join('\n'), keyBody(), keyBody(), keyBody(), keyBody()),
    c('.npmrc', ([t, a]) => `//registry.npmjs.org/:_authToken=${t}\n_auth=${a}=`, mixed(24), b64(24)),
    c('basic auth in a URL', ([p, q]) => `git clone https://deploy:${p}@git.example.com/repo.git; psql postgres://app:${q}@db:5432/app`, mixed(16), mixed(16)),
    c('query-string secrets', ([t, s, k]) => `GET /callback?code=1&token=${t}&sig=${s} then /v1?key=${k}`, mixed(20), b64(30), mixed(24)),
    c('env lines', ([a, b, d, e]) => `export GITHUB_TOKEN=${a}\nDB_PASSWORD=${b}\n$env:OPENAI_API_KEY = "${d}"\nset STRIPE_SECRET=${e}`, mixed(20), phrase().replaceAll(' ', '_'), mixed(24), mixed(20)),
    c('JSON and YAML fields', ([a, b, d, e, f, g]) =>
      `{"clientSecret": "${a}", "apiKey":"${b}"}\n{\\"password\\":\\"${d}\\"}\nclient-secret: ${e}\nPassword: ${f}\nrefresh_token: '${g}'`,
    phrase(), mixed(24), mixed(18), mixed(20), mixed(14), mixed(30)),
    c('doubled-quote JSON in a command', ([a]) => `az rest --body "{""password"":""${a}""}"`, mixed(18)),
    c('command-line flags', ([a, b, d, e, f, g, h, i, j]) => [
      `gh auth login --token ${a}`, `login --password "${b}"`, `az ad sp create --client-secret=${d}`, `curl -u ci:${e} x`,
      `docker login -u ci -p ${f} registry`, `mysql -u root -p${g} app`, `sshpass -p ${h} ssh host`, `az storage blob upload --account-key ${i}`,
      `openssl enc -pass pass:${j}`,
    ].join('\n'), mixed(20), phrase(), mixed(20), mixed(12), mixed(14), mixed(12), mixed(12), b64(88), mixed(12)),
    c('random-looking strings next to a secret word', ([a, b, d]) => `my password is ${a}\nthe api key ${b}\ntoken for CI: ${d}`,
      rand(LOWER, 10) + rand(DIGITS, 6), mixed(32), rand(LOWER + DIGITS, 14) + '7q'),
    c('oversized values', ([a, b, d, e, f, g]) => [
      `{"password": "${a}"}`, `login --password "${b}"`, `login --password "${d}`, `DB_PASSWORD=${e}`, `Authorization: Bearer ${f}`, `push ${g}`,
    ].join('\n'), rand(LOWER, 2100), rand(LOWER, 2500), rand(LOWER, 3000), rand(LOWER, 2600), mixed(3000), 'ghp_' + mixed(400)),
  ];
}

const CASES = corpus();

/** Every part of a secret that would give it away: each word of a phrase, and every 8-character run of a token. */
function leaks(out: string, secrets: readonly string[]): string[] {
  const found: string[] = [];
  for (const secret of secrets) {
    for (const part of secret.split(/[\s\n]+/).filter(Boolean)) {
      if (part.length < 8) { if (part.length >= 5 && out.includes(part)) found.push(part); continue; }
      for (let i = 0; i + 8 <= part.length; i++) if (out.includes(part.slice(i, i + 8))) { found.push(part.slice(i, i + 8)); break; }
    }
  }
  return found;
}

const labels = { home: '/home/jdoe', names: ['jdoe'], handles: ['octo-dev'] };

describe('scrubText against the secret corpus', () => {
  it.each(CASES.map(x => [x.name, x] as const))('leaks nothing of %s', (_name, x) => {
    expect(leaks(scrubText(x.text, labels), x.secrets)).toEqual([]);
  });

  it('keeps ordinary text readable', () => {
    const plain = [
      'commit 3f2a9c4e1b7d8a6f5e4d3c2b1a0f9e8d7c6b5a49, session 7e470000-0000-4000-8000-000000000001',
      'claude-sonnet-4-5-20250929 used 1200 tokens; set max_tokens=4096',
      'design=wide, mkdir -p out && sort -u names.txt && npm run -s build -- --token-file cfg.json --max-tokens 4096',
      'Primary key: userId. Released 2.4.1 on 2026-05-02 at 15:02.',
    ].join('\n');
    expect(scrubText(plain, labels)).toBe(plain);
  });

  it('stays linear on long runs that look like the start of a secret', () => {
    const t = Date.now();
    for (const s of ['a_'.repeat(50_000), '--a-'.repeat(25_000), 'token '.repeat(20_000), `password: "${'x'.repeat(100_000)}`,
      `--password "${'x'.repeat(100_000)}`, `Authorization: "${'x '.repeat(50_000)}`, 'password: "a" '.repeat(10_000)]) scrubText(s, labels);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('the Timeline surfaces against the secret corpus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-timeline-secrets-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const ID = '7e470000-0000-4000-8000-00000000000a';
  const at = (m: number) => new Date(2026, 10, 17, 10, m).toISOString();

  /** One Copilot session that carries the corpus in every field the Timeline can show. */
  function session() {
    const text = (i: number) => CASES[i % CASES.length].text;
    let m = 0;
    const events: Record<string, unknown>[] = [{ type: 'session.start', timestamp: at(0), data: { sessionId: ID } }];
    for (let i = 0; i < CASES.length; i++) {
      const id = `c${i}`;
      events.push(
        { type: 'user.message', timestamp: at(m++), id: `u${i}`, data: { content: text(i) } },
        { type: 'assistant.message', timestamp: at(m++), id: `a${i}`, data: { content: text(i + 1) } },
        { type: 'tool.execution_start', timestamp: at(m++), data: { toolName: 'ask_user', toolCallId: `q${id}`, arguments: { question: text(i + 2), choices: [text(i + 3)] } } },
        { type: 'human_response.recorded', timestamp: at(m), data: { toolCallId: `q${id}`, response: { answer: text(i + 4) } } },
        { type: 'tool.execution_complete', timestamp: at(m++), data: { toolCallId: `q${id}`, success: true, result: { content: `User responded: ${text(i + 4)}` } } },
        { type: 'permission.requested', timestamp: at(m++), data: { requestId: `p${id}`, permissionRequest: { kind: text(i + 5), fullCommandText: text(i + 6), intention: text(i + 7) } } },
        { type: 'permission.completed', timestamp: at(m++), data: { requestId: `p${id}`, decisionSource: 'human_response', result: { kind: 'approved' } } },
        { type: 'tool.execution_start', timestamp: at(m++), data: { toolName: 'relay_session_input', toolCallId: `r${id}`, arguments: { context: text(i + 8) } } },
        { type: 'tool.execution_complete', timestamp: at(m++), data: { toolCallId: `r${id}`, success: true, result: { content: JSON.stringify({ question: text(i + 9), answer: text(i + 10) }) } } },
        { type: 'session.task_complete', timestamp: at(m++), data: { success: true, summary: text(i + 11) } },
      );
    }
    const dir = path.join(root, ID);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, events.map(x => JSON.stringify(x)).join('\n'));
    const s = parseCLIEventsFile(file, 'ws', 'fixture');
    if (!s) throw new Error('fixture did not parse');
    return s;
  }

  const all = CASES.flatMap(x => x.secrets);

  it('the text of a lane, as the panel receives it, leaks none', () => {
    const s = session();
    const out = timelineSessionText(s, labels);
    // The fixture did carry the corpus into every field.
    expect(out.turns.length).toBe(CASES.length);
    expect(out.waits.filter(w => w.k === 'question' && w.ask && w.answer && w.choices && w.before)).toHaveLength(CASES.length);
    expect(out.waits.filter(w => w.k === 'permission' && w.ask && w.intention && w.tool)).toHaveLength(CASES.length);
    expect(out.waits.filter(w => w.k === 'relay' && w.ask && w.answer)).toHaveLength(CASES.length);
    expect(leaks(JSON.stringify(out), all)).toEqual([]);
  });

  it('the dataset, the chat tool and the summary export carry none of it', () => {
    const an = new Analyzer([session()], new Map());
    const day = { fromDate: '2026-11-17', toDate: '2026-11-17' };
    for (const out of [an.getTimelineData(day), formatTimeline(an, day, '2026-11-17'), buildSummaryExportFromAnalyzer(an, day)]) {
      expect(leaks(JSON.stringify(out), all)).toEqual([]);
    }
  });
});
