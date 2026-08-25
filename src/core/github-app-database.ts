/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

const QUERY_TIMEOUT_MS = 10_000;
const QUERY_MAX_BUFFER = 2 * 1024 * 1024;

export interface GitHubAppDatabaseDependencies {
  databasePath?: string;
  sessionStorePath?: string;
  exists?: (filePath: string) => boolean;
  query?: (databasePath: string, sql: string) => Promise<string>;
}

export interface GitHubAppDatabaseAccess {
  databasePath: string;
  sessionStorePath: string;
  exists: (filePath: string) => boolean;
  query: (databasePath: string, sql: string) => Promise<string>;
}

function defaultDatabasePath(): string {
  const configuredHome = process.env.COPILOT_HOME?.trim();
  const copilotHome = configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), '.copilot');
  return path.join(copilotHome, 'data.db');
}

function queryWithSqlite(databasePath: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'sqlite3',
      ['-readonly', '-json', databasePath, sql],
      {
        encoding: 'utf-8',
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: QUERY_MAX_BUFFER,
        cwd: os.tmpdir(),
      },
      (error, stdout) => {
        if (error) reject(new Error(error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}

export function resolveGitHubAppDatabaseAccess(
  dependencies: GitHubAppDatabaseDependencies,
): GitHubAppDatabaseAccess {
  const databasePath = dependencies.databasePath ?? defaultDatabasePath();
  return {
    databasePath,
    sessionStorePath: dependencies.sessionStorePath
      ?? path.join(path.dirname(databasePath), 'session-store.db'),
    exists: dependencies.exists ?? fs.existsSync,
    query: dependencies.query ?? queryWithSqlite,
  };
}
