/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { displayFolderName, hideAccountName, redactHomePaths, shortenHomePath } from './display-path';

describe('shortenHomePath', () => {
  it('replaces a Windows home folder with ~, ignoring case and separator style', () => {
    expect(shortenHomePath('C:\\Users\\Dev\\source\\api', 'C:\\Users\\Dev')).toBe('~\\source\\api');
    expect(shortenHomePath('c:/users/dev/source/api', 'C:\\Users\\Dev')).toBe('~/source/api');
  });

  it('replaces a POSIX home folder and the home folder itself', () => {
    expect(shortenHomePath('/home/dev/work/api', '/home/dev/')).toBe('~/work/api');
    expect(shortenHomePath('/home/dev', '/home/dev')).toBe('~');
  });

  it('only matches the home folder as a whole path prefix', () => {
    expect(shortenHomePath('/home/devops/api', '/home/dev')).toBe('/home/devops/api');
    expect(shortenHomePath('/srv/home/dev/api', '/home/dev')).toBe('/srv/home/dev/api');
    expect(shortenHomePath('/home/dev team/api', '/home/dev')).toBe('/home/dev team/api');
    expect(shortenHomePath('C:\\Users\\Dev (old)\\api', 'C:\\Users\\Dev')).toBe('C:\\Users\\Dev (old)\\api');
  });

  it('decodes file URIs before shortening', () => {
    expect(shortenHomePath('file:///c%3A/Users/Dev/my%20app', 'C:\\Users\\Dev')).toBe('~/my app');
  });

  it('leaves names and paths outside the home folder unchanged', () => {
    expect(shortenHomePath('my-api', 'C:\\Users\\Dev')).toBe('my-api');
    expect(shortenHomePath('D:\\work\\api', 'C:\\Users\\Dev')).toBe('D:\\work\\api');
  });
});

describe('redactHomePaths', () => {
  it('replaces every home folder occurrence inside free text', () => {
    const text = 'workspace 3/9: C:\\Users\\Dev\\api — reading C:/Users/Dev/api/x.json';
    expect(redactHomePaths(text, 'C:\\Users\\Dev')).toBe('workspace 3/9: ~\\api — reading ~/api/x.json');
  });

  it('does not touch longer names that start with the home folder', () => {
    expect(redactHomePaths('/home/devops/x and /home/dev/y', '/home/dev')).toBe('/home/devops/x and ~/y');
  });

  it('ignores an empty, root or bare-drive home', () => {
    expect(redactHomePaths('/a/b', '/')).toBe('/a/b');
    expect(redactHomePaths('', '/home/dev')).toBe('');
    expect(redactHomePaths('C:\\work\\api', 'C:\\')).toBe('C:\\work\\api');
    expect(shortenHomePath('C:\\work\\api', 'C:')).toBe('C:\\work\\api');
  });
});

describe('displayFolderName', () => {
  it('returns the last segment for either separator and for URIs', () => {
    expect(displayFolderName('~\\source\\my-api')).toBe('my-api');
    expect(displayFolderName('/work/my-api/')).toBe('my-api');
    expect(displayFolderName('file:///c%3A/work/my%20app')).toBe('my app');
    expect(displayFolderName('my-api')).toBe('my-api');
  });
});

describe('hideAccountName', () => {
  it('masks whole path segments equal to the account name, in any case and separator style', () => {
    expect(hideAccountName('/home/dev/api', 'Dev')).toBe('/home/…/api');
    expect(hideAccountName('vscode-remote://ssh-remote+box/home/dev', 'dev')).toBe('vscode-remote://ssh-remote+box/home/…');
    expect(hideAccountName('workspace 2/9: D:\\Users\\DEV\\api — chat 1/2', 'dev')).toBe('workspace 2/9: D:\\Users\\…\\api — chat 1/2');
  });

  it('leaves names that only contain the account name, and short account names, alone', () => {
    expect(hideAccountName('/work/devtools/dev-api', 'dev')).toBe('/work/devtools/dev-api');
    expect(hideAccountName('/home/me/api', 'me')).toBe('/home/me/api');
    expect(hideAccountName('api', 'dev')).toBe('api');
  });
});
