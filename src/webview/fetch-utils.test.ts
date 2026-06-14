/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { readTextWithByteLimit } from './fetch-utils';

describe('readTextWithByteLimit', () => {
  it('reads content under the byte limit', async () => {
    const response = new Response('hello', { headers: { 'content-length': '5' } });
    await expect(readTextWithByteLimit(response, 5, 'too large')).resolves.toBe('hello');
  });

  it('rejects when content-length exceeds the limit', async () => {
    const response = new Response('hello', { headers: { 'content-length': '6' } });
    await expect(readTextWithByteLimit(response, 5, 'too large')).rejects.toThrow('too large');
  });

  it('rejects streamed content after the byte limit is exceeded', async () => {
    const response = new Response('hello');
    await expect(readTextWithByteLimit(response, 4, 'too large')).rejects.toThrow('too large');
  });
});
