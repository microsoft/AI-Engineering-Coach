/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const DATASET_SOURCE = path.resolve(__dirname, '..', '..', 'tests', 'vscode', 'data', 'projects.json');
const projectSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  language: z.enum(['typescript', 'python', 'go']),
  modelId: z.string(),
  sourceFile: z.string().regex(/^[a-z][a-z0-9_.]*$/),
  testFile: z.string().regex(/^[a-z][a-z0-9_.]*$/),
  prompts: z.tuple([z.string(), z.string(), z.string()]),
  source: z.array(z.string()).min(1),
  revised: z.array(z.string()).min(1),
  tests: z.array(z.string()).min(1),
});
const dataset = z.object({
  description: z.string(),
  schedule: z.array(z.object({
    daysAgo: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(22),
    topic: z.string(),
  })).min(1),
  projects: z.array(projectSchema).min(1),
}).parse(JSON.parse(readFileSync(DATASET_SOURCE, 'utf8')));
type Project = z.infer<typeof projectSchema>;

export const INITIAL_COUNTS = { Requests: '63', Sessions: '21', 'AI LoC': '315', Workspaces: '3' };
export const RELOADED_COUNTS = { Requests: '66', Sessions: '22', 'AI LoC': '330', Workspaces: '3' };
export const INITIAL_NET_LOC = 294;
export const PROJECT_NAMES = dataset.projects.map(project => project.id);

const totalsSchema = z.object({ sessions: z.number(), requests: z.number(), aiLoc: z.number(), netAiLoc: z.number() });
export const fixtureDatasetSchema = z.object({
  source: z.literal('tests/vscode/data/projects.json'),
  synthetic: z.literal(true),
  projects: z.array(z.object({ name: z.string(), language: z.string(), model: z.string() })),
  activeDays: z.number(),
  initial: totalsSchema,
  afterReload: totalsSchema.nullable(),
  inputFiles: z.object({ initial: z.number(), reload: z.number() }),
});

export function isolatedEnvironment(root: string, original: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  const env: NodeJS.ProcessEnv = {
    ...original,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    COPILOT_HOME: path.join(home, '.copilot'),
    GH_CONFIG_DIR: path.join(home, '.config', 'gh'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key.startsWith('NODE_')
      || ['ELECTRON_RUN_AS_NODE', 'EXTENSION_DEV_PATH', 'EXTENSIONS_FOLDER', 'TEST_RESOURCES',
        'CODE_VERSION', 'MOCHA_GREP', 'MOCHA_INVERT'].includes(key)) {
      delete env[key];
    }
  }
  return env;
}

export function fixturePaths(root: string, platform: NodeJS.Platform = process.platform) {
  const home = path.join(root, 'home');
  const codeUser = platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'Code', 'User')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
      : path.join(home, '.config', 'Code', 'User');
  return {
    home,
    logs: path.join(codeUser, 'workspaceStorage'),
    cliLogs: path.join(home, '.copilot', 'session-state'),
    workspace: path.join(home, 'workspaces', 'smoke-workspace'),
    runtimeLog: path.join(home, '.copilot-analytics-cache', 'runtime.log'),
  };
}

/** The synthetic Copilot App family: a coordinator that starts two children (one starts a grandchild), a child it
 *  starts by relaying its first message, and a lone Copilot CLI session. */
export const FAMILY = {
  coordinator: '0f000000-0000-4000-8000-000000000001',
  payment: '0f000000-0000-4000-8000-000000000002',
  docs: '0f000000-0000-4000-8000-000000000003',
  lint: '0f000000-0000-4000-8000-000000000004',
  perf: '0f000000-0000-4000-8000-000000000005',
  lone: '0f000000-0000-4000-8000-000000000006',
  sessions: 6,
  requests: 9,
  /** The GitHub handle the synthetic Copilot sign-in uses; branches start with it and the Timeline removes it. */
  handle: 'octo-dev',
};

export const familyDatasetSchema = z.object({
  synthetic: z.literal(true),
  kind: z.literal('session-family'),
  harnesses: z.array(z.string()),
  sessions: z.number(),
  requests: z.number(),
  family: z.object({ coordinators: z.number(), children: z.number(), grandchildren: z.number(), relayStarted: z.number() }),
});

export function familyFixtureFiles(root: string, timestamp: number): Map<string, string> {
  const { home, cliLogs } = fixturePaths(root);
  const at = (h: number, m = 0) => { const d = new Date(timestamp); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const relay = (from: string, text: string) => ({ content: text, transformedContent: `<cross_session_message>\nfrom_session_id: ${from}\n</cross_session_message>\n${text}` });
  const usage = (ts: string, credits: number) => ({ type: 'session.usage_record', timestamp: ts,
    data: { usage: { model: 'claude-opus-4.7', inputTokens: 40_000, outputTokens: 2_000, initiator: 'agent', copilotUsage: { totalNanoAiu: credits * 1e9 } } } });
  const start = (id: string, app = true) => ({ type: 'session.start', timestamp: at(9), data: { sessionId: id, selectedModel: 'claude-opus-4.7', ...(app ? { remoteSteerable: true } : {}) } });
  const reply = (ts: string, text: string) => ({ type: 'assistant.message', id: `a-${ts}`, timestamp: ts, data: { content: text, phase: 'final' } });
  const create = (id: string, child: string) => [
    { type: 'tool.execution_start', data: { toolName: 'create_session', toolCallId: id } },
    { type: 'tool.execution_complete', data: { toolCallId: id, success: true, result: { content: `Created session ${child}.` } } },
  ];
  const files = new Map<string, string>();
  const session = (id: string, name: string, branch: string, events: object[]) => {
    files.set(path.join(cliLogs, id, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    files.set(path.join(cliLogs, id, 'workspace.yaml'), [`id: ${id}`, `cwd: ${path.join(home, 'workspaces', 'shop')}`,
      ...(name ? [`name: ${name}`] : []), `branch: ${branch}`, `repository: ${FAMILY.handle}/shop`, 'fork_count: 0'].join('\n') + '\n');
  };
  session(FAMILY.coordinator, 'Checkout revamp', `${FAMILY.handle}/checkout-revamp`, [
    start(FAMILY.coordinator), { type: 'user.message', timestamp: at(10), data: { content: 'Split the checkout work into sessions.' } },
    usage(at(10, 1), 3), ...create('c1', FAMILY.payment), ...create('c2', FAMILY.docs), reply(at(10, 5), 'Started two sessions.'),
    { type: 'user.message', timestamp: at(10, 40), data: relay(FAMILY.payment, 'Payment tests pass.') }, reply(at(10, 41), 'Noted.'),
    { type: 'user.message', timestamp: at(11, 30), data: { content: 'Ship it.' } }, usage(at(11, 40), 2), reply(at(11, 50), 'Shipped.'),
  ]);
  session(FAMILY.payment, 'Payment tests', `${FAMILY.handle}/payment-tests`, [
    start(FAMILY.payment), { type: 'user.message', timestamp: at(10, 2), data: relay(FAMILY.coordinator, 'Add payment tests.') },
    usage(at(10, 3), 5), ...create('p1', FAMILY.lint), reply(at(10, 30), 'Tests added.'),
    { type: 'user.message', timestamp: at(10, 35), data: { content: 'Also cover refunds.' } }, reply(at(10, 38), 'Refunds covered.'),
  ]);
  session(FAMILY.docs, 'Docs update', `${FAMILY.handle}/docs`, [
    start(FAMILY.docs), { type: 'user.message', timestamp: at(10, 4), data: relay(FAMILY.coordinator, 'Update the docs.') },
    usage(at(10, 10), 2), reply(at(10, 20), 'Docs updated.'),
  ]);
  session(FAMILY.lint, 'Lint fixes', `${FAMILY.handle}/lint`, [
    start(FAMILY.lint), { type: 'user.message', timestamp: at(10, 6), data: relay(FAMILY.payment, 'Fix the lint errors.') },
    reply(at(10, 15), 'Lint fixed.'),
  ]);
  session(FAMILY.perf, 'Perf probe', `${FAMILY.handle}/perf`, [
    start(FAMILY.perf), { type: 'user.message', timestamp: at(12), data: relay(FAMILY.coordinator, 'Profile checkout.') },
    usage(at(12, 10), 1), reply(at(12, 20), 'Profiled.'),
  ]);
  session(FAMILY.lone, '', 'main', [
    start(FAMILY.lone, false), { type: 'user.message', timestamp: at(14), data: { content: 'Explain the build.' } }, reply(at(14, 5), 'Explained.'),
  ]);
  files.set(path.join(home, '.copilot', 'config.json'), JSON.stringify({ lastLoggedInUser: { host: 'https://github.com', login: FAMILY.handle } }) + '\n');
  return files;
}

function scheduledTime(anchor: number, daysAgo: number, hour: number, projectIndex: number): number {
  const date = new Date(anchor);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, projectIndex * 5, 0, 0);
  return date.getTime();
}

function addSessionFiles(
  files: Map<string, string>,
  root: string,
  project: Project,
  session: { id: string; timestamp: number; topic: string },
): void {
  const { home, logs } = fixturePaths(root);
  const sourceUri = pathToFileURL(path.join(home, 'workspaces', project.id, 'src', session.id, project.sourceFile)).href;
  const testUri = pathToFileURL(path.join(home, 'workspaces', project.id, 'src', session.id, project.testFile)).href;
  const source = project.source.join('\n') + '\n';
  const revised = project.revised.join('\n') + '\n';
  const tests = project.tests.join('\n') + '\n';
  const responses = [
    `Use a small local fixture for ${session.topic}, implement the function, then verify the boundary with tests.`,
    `Implemented the synthetic example:\n\`\`\`${project.language}\n${source}\`\`\``,
    `Corrected the boundary and added tests:\n\`\`\`${project.language}\n${revised}\`\`\`\n\`\`\`${project.language}\n${tests}\`\`\``,
  ];
  const requests = project.prompts.map((prompt, index) => ({
    requestId: `${session.id}-request-${index}`,
    timestamp: session.timestamp + [0, 7, 18][index] * 60_000,
    message: { text: `${prompt} Task: ${session.topic}.` },
    response: [{ value: responses[index] }],
    modelId: project.modelId,
    agent: { extensionDisplayName: 'Synthetic coding agent', id: 'agent' },
    editedFileEvents: index === 0 ? [] : (index === 1 ? [sourceUri] : [sourceUri, testUri]).map(uri => ({ uri: { path: new URL(uri).pathname } })),
    result: {
      timings: { firstProgress: 250, totalElapsed: 2_000 + index * 500 },
      metadata: { toolCallRounds: [{ toolCalls: (index === 0 ? ['read_file'] : index === 1
        ? ['create_file'] : ['replace_string_in_file', 'create_file', 'run_in_terminal']).map(name => ({ name })) }] },
    },
  }));
  files.set(path.join(logs, project.id, 'chatSessions', `${session.id}.json`), JSON.stringify({
    sessionId: session.id, customTitle: `${project.id}: ${session.topic}`,
    creationDate: session.timestamp, lastMessageDate: requests[2].timestamp, requests,
  }, null, 2) + '\n');
  files.set(path.join(logs, project.id, 'chatEditingSessions', session.id, 'state.json'), JSON.stringify({
    timeline: { operations: [
      { type: 'create', requestId: requests[1].requestId, uri: { external: sourceUri }, epoch: 1, initialContent: source },
      { type: 'textEdit', requestId: requests[2].requestId, uri: { external: sourceUri }, epoch: 2,
        edits: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1_000_000, endColumn: 1 }, text: revised }] },
      { type: 'create', requestId: requests[2].requestId, uri: { external: testUri }, epoch: 3, initialContent: tests },
    ] },
  }, null, 2) + '\n');
}

export function fixtureFiles(root: string, timestamp: number, reloaded = false): Map<string, string> {
  const { home, logs } = fixturePaths(root);
  const files = new Map<string, string>();
  for (const [index, project] of dataset.projects.entries()) {
    const workspace = path.join(home, 'workspaces', project.id);
    files.set(path.join(logs, project.id, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(workspace).href }) + '\n');
    for (const schedule of dataset.schedule) {
      addSessionFiles(files, root, project, {
        id: `${project.id}-day-${schedule.daysAgo}`,
        timestamp: scheduledTime(timestamp, schedule.daysAgo, schedule.hour, index),
        topic: schedule.topic,
      });
    }
  }
  if (reloaded) {
    addSessionFiles(files, root, dataset.projects[0], {
      id: 'inventory-api-reload', timestamp: scheduledTime(timestamp, 0, 18, 0), topic: 'reload regression',
    });
  }
  return files;
}

export async function prepareFixtures(root: string, timestamp: number, populated: boolean): Promise<void> {
  const { home, workspace } = fixturePaths(root);
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(path.join(root, 'tmp'), { recursive: true }),
    ...PROJECT_NAMES.map(name => fs.mkdir(path.join(home, 'workspaces', name), { recursive: true })),
  ]);
  if (!populated) return;
  for (const [file, content] of fixtureFiles(root, timestamp)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: 'wx' });
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(file));
    else files.push(file);
  }
  return files;
}

export async function assertFixturesUnchanged(root: string, timestamp: number, reloaded = false): Promise<void> {
  const expected = fixtureFiles(root, timestamp, reloaded);
  assert.deepEqual((await listFiles(fixturePaths(root).logs)).sort(), [...expected.keys()].sort(),
    'Session-log files were added or removed unexpectedly');
  for (const [file, content] of expected) {
    assert.equal(await fs.readFile(file, 'utf8'), content, `Session-log input was modified: ${file}`);
  }
}

export async function addReloadFixture(root: string, timestamp: number): Promise<void> {
  await assertFixturesUnchanged(root, timestamp);
  const original = fixtureFiles(root, timestamp);
  for (const [file, content] of fixtureFiles(root, timestamp, true)) {
    if (!original.has(file)) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { flag: 'wx' });
    }
  }
}

export async function exportFixtureDataset(root: string, timestamp: number, artifacts: string, populated: boolean): Promise<void> {
  const initial = populated ? fixtureFiles(root, timestamp) : new Map<string, string>();
  const full = populated ? fixtureFiles(root, timestamp, true) : new Map<string, string>();
  for (const [file, content] of full) {
    const stage = initial.has(file) ? 'initial' : 'reload';
    const target = path.join(artifacts, 'fixtures', stage, path.relative(fixturePaths(root).logs, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (stage === 'initial') await fs.copyFile(file, target);
    else await fs.writeFile(target, content);
  }
  await fs.mkdir(path.join(artifacts, 'fixtures'), { recursive: true });
  await fs.copyFile(DATASET_SOURCE, path.join(artifacts, 'fixtures', 'projects.json'));
  const summary = fixtureDatasetSchema.parse({
    source: 'tests/vscode/data/projects.json', synthetic: true,
    projects: populated ? dataset.projects.map(project => ({ name: project.id, language: project.language, model: project.modelId })) : [],
    activeDays: populated ? dataset.schedule.length : 0,
    initial: populated ? { sessions: 21, requests: 63, aiLoc: 315, netAiLoc: INITIAL_NET_LOC }
      : { sessions: 0, requests: 0, aiLoc: 0, netAiLoc: 0 },
    afterReload: populated ? { sessions: 22, requests: 66, aiLoc: 330, netAiLoc: 308 } : null,
    inputFiles: { initial: initial.size, reload: full.size - initial.size },
  });
  await fs.writeFile(path.join(artifacts, 'dataset.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Synthetic dataset: ${summary.projects.length} projects, ${summary.initial.sessions} sessions, ` +
    `${summary.initial.requests} requests, ${summary.initial.aiLoc} AI LoC across ${summary.activeDays} days.`);
  console.log(`Fixture definitions: ${summary.source}; raw synthetic inputs: ${path.join(artifacts, 'fixtures')}`);
}

/** The families scenario: Copilot App and Copilot CLI session-state files only, no VS Code projects. */
export async function prepareFamilyFixtures(root: string, timestamp: number): Promise<void> {
  await fs.mkdir(fixturePaths(root).workspace, { recursive: true });
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  for (const [file, content] of familyFixtureFiles(root, timestamp)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: 'wx' });
  }
}

export async function assertFamilyFixturesUnchanged(root: string, timestamp: number): Promise<void> {
  const expected = familyFixtureFiles(root, timestamp);
  const logs = [...expected.keys()].filter(file => file.startsWith(fixturePaths(root).cliLogs));
  assert.deepEqual((await listFiles(fixturePaths(root).cliLogs)).sort(), logs.sort(), 'Session-log files were added or removed unexpectedly');
  for (const [file, content] of expected) {
    assert.equal(await fs.readFile(file, 'utf8'), content, `Session-log input was modified: ${file}`);
  }
}

export async function exportFamilyDataset(root: string, timestamp: number, artifacts: string): Promise<void> {
  const { home } = fixturePaths(root);
  for (const [file, content] of familyFixtureFiles(root, timestamp)) {
    const target = path.join(artifacts, 'fixtures', 'initial', path.relative(home, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const summary = familyDatasetSchema.parse({ synthetic: true, kind: 'session-family', harnesses: ['GitHub Copilot App', 'GitHub Copilot CLI'],
    sessions: FAMILY.sessions, requests: FAMILY.requests, family: { coordinators: 1, children: 3, grandchildren: 1, relayStarted: 1 } });
  await fs.writeFile(path.join(artifacts, 'dataset.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Synthetic dataset: ${FAMILY.sessions} Copilot App and CLI sessions, ${FAMILY.requests} requests, one session family.`);
}

export function scenarioContext(): { root: string; timestamp: number } {
  const root = process.env.AIC_E2E_SCENARIO_ROOT;
  const timestamp = Number(process.env.AIC_E2E_TIMESTAMP);
  if (!root || !path.isAbsolute(root) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Missing isolated test context. Run these tests through npm run test:vscode.');
  }
  return { root, timestamp };
}
