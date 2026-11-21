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
export const FIRST_PROMPT = `${dataset.projects[0].prompts[0]} Task: ${dataset.schedule[0].topic}.`;

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
    workspace: path.join(home, 'workspaces', 'smoke-workspace'),
    runtimeLog: path.join(home, '.copilot-analytics-cache', 'runtime.log'),
  };
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

export function scenarioContext(): { root: string; timestamp: number } {
  const root = process.env.AIC_E2E_SCENARIO_ROOT;
  const timestamp = Number(process.env.AIC_E2E_TIMESTAMP);
  if (!root || !path.isAbsolute(root) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Missing isolated test context. Run these tests through npm run test:vscode.');
  }
  return { root, timestamp };
}
