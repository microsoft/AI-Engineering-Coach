/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { classifyCuriosityActivity, hasRecordedToolEvidence, recordedInvestigation, recordedToolFiles, recordedTools, recordedWebDomains } from './curiosity-activity';
import { createRequest } from './parser-shared';
import { detectCuriosity } from './curiosity';

describe('Recorded Curiosity tools', () => {
  it.each([
    ['functions.view', true], ['functions.web_fetch', true], ['apply_patch', true],
    ['Agent', true], ['spawn_agent', true], ['multi_tool_use.parallel', true],
    ['bash', false], ['task_complete', false], ['unknown_read_tool', false],
  ])('checks evidence eligibility before reading arguments: %s', (name, eligible) => {
    expect(hasRecordedToolEvidence(name)).toBe(eligible);
  });

  it('does not inspect irrelevant arguments or expand ordinary tool calls', () => {
    const inspect = vi.fn(() => { throw new Error('Arguments must not be read'); });
    const args = Object.defineProperties({}, {
      path: { get: inspect }, tool_uses: { get: inspect }, agent_type: { get: inspect },
    });
    expect(recordedTools('bash', args)).toEqual([{ name: 'bash', args }]);
    expect(recordedWebDomains('bash', args)).toEqual([]);
    expect(recordedToolFiles('bash', args)).toEqual({ edited: [], referenced: [] });
    expect(recordedInvestigation('bash', args)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('uses identities, not substrings or user intent words', () => {
    const make = (toolsUsed: string[]) => createRequest({ messageText: 'Can you fix this?', responseText: 'A reason.',
      toolsUsed, curiosity: detectCuriosity('Can you fix this?'), answerEvidence: 'final' });
    expect(classifyCuriosityActivity(make(['functions.view', 'functions.web_search']))).toBe('repository');
    expect(classifyCuriosityActivity(make(['functions.bash']))).toBe('action');
    expect(classifyCuriosityActivity(make(['container.exec']))).toBe('action');
    expect(classifyCuriosityActivity(make(['task_complete', 'web_search']))).toBe('web');
    expect(classifyCuriosityActivity(make(['untrusted_read_file_and_write']))).toBe('unknownTool');
    expect(classifyCuriosityActivity(make(['functions.task']))).toBe('unknownTool');
    expect(classifyCuriosityActivity(make(['AskUserQuestion']))).toBe('clarification');
  });

  it.each(['powershell', 'functions.powershell', 'read_powershell', 'functions.stop_powershell'])(
    'classifies recorded PowerShell command tools as actions: %s', tool => {
      const request = createRequest({ messageText: 'Run the tests.', responseText: '', toolsUsed: [tool],
        curiosity: detectCuriosity('Run the tests.') });
      expect(classifyCuriosityActivity(request)).toBe('action');
      expect(hasRecordedToolEvidence(tool)).toBe(false);
    });

  it('keeps PowerShell process listing neutral and unknown lookalikes unknown', () => {
    const request = createRequest({ messageText: 'Why does the process stop?', responseText: 'An answer.',
      toolsUsed: ['functions.list_powershell'], curiosity: detectCuriosity('Why does the process stop?'), answerEvidence: 'final' });
    expect(classifyCuriosityActivity(request)).toBe('direct');
    expect(classifyCuriosityActivity({ ...request, toolsUsed: ['custom_powershell_tool'] })).toBe('unknownTool');
  });

  it('uses recorded roles for investigation evidence, never agent names or prompt keywords', () => {
    expect(recordedInvestigation('functions.task', { agent_type: 'research' })).toBe('research');
    expect(recordedInvestigation('Agent', { subagent_type: 'Explore' })).toBe('explore');
    expect(recordedInvestigation('spawn_agent', { agent_type: 'general-purpose', prompt: 'Research the web.' })).toBeUndefined();
    expect(recordedInvestigation('unknown_research_agent', { agent_type: 'research' })).toBeUndefined();
  });
  it('expands complete parallel wrappers and leaves incomplete wrappers unknown', () => {
    expect(recordedTools('multi_tool_use.parallel', { tool_uses: [
      { recipient_name: 'functions.view', parameters: { path: 'src/a.ts' } },
      { recipient_name: 'functions.bash', parameters: { command: 'npm test' } },
    ] }).map(call => call.name)).toEqual(['functions.view', 'functions.bash']);
    expect(recordedTools('multi_tool_use.parallel', { tool_uses: [{}] })[0].name).toBe('multi_tool_use.parallel');
  });

  it('reads paths from tool metadata and freeform patch headers, not commands or prompts', () => {
    expect(recordedToolFiles('functions.rg', { paths: ['a.ts', 'b.py'], pattern: 'x.rs' }).referenced).toEqual(['a.ts', 'b.py']);
    expect(recordedToolFiles('bash', { command: 'cat a.ts', path: 'b.py' })).toEqual({ edited: [], referenced: [] });
    expect(recordedToolFiles('apply_patch', '*** Update File: a.ts\n+text\n*** Move to: b.ts\n*** Add File: c.py\n+text'))
      .toEqual({ edited: ['a.ts', 'b.ts', 'c.py'], referenced: [] });
  });

  it('retains normalized URL hosts without credentials, paths, queries, or topic guesses', () => {
    expect(recordedWebDomains('functions.web_fetch', {
      url: 'https://user:password@Docs.Python.org:443/3/library.html?token=secret#content',
      urls: ['https://docs.python.org/3/', 'http://learn.microsoft.com./typescript', 'file:///private/project'],
    })).toEqual(['docs.python.org', 'learn.microsoft.com']);
    expect(recordedWebDomains('web_search', { query: 'https://example.edu/ robotics', prompt: 'Learn SQL.' })).toEqual([]);
    expect(recordedWebDomains('bash', { url: 'https://example.com/' })).toEqual([]);
    expect(recordedWebDomains('unknown_web_fetch', { url: 'https://example.com/' })).toEqual([]);
    expect(recordedWebDomains('web_fetch', { url: 'https://[invalid' })).toEqual([]);
    expect(recordedWebDomains('multi_tool_use.parallel', { tool_uses: [
      { recipient_name: 'functions.web_fetch', parameters: { url: 'https://example.org/a' } },
      { recipient_name: 'functions.web_search', parameters: { query: 'https://invented.org' } },
    ] })).toEqual(['example.org']);
  });
});
