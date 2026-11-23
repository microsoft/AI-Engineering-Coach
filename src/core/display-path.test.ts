/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { displayFolderName, redactHomePaths, shortenHomePath } from './display-path';

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

  it('ignores an empty or root home', () => {
    expect(redactHomePaths('/a/b', '/')).toBe('/a/b');
    expect(redactHomePaths('', '/home/dev')).toBe('');
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
