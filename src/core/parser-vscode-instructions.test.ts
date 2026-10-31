/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Instruction files VS Code attached to a request (`customInstructions`), from its content references. The
 * Local harness loads copilot-instructions.md, AGENTS.md and CLAUDE.md, and targeted *.instructions.md files
 * and Markdown files in .claude/rules. Prompt files (*.prompt.md) are prompts you run, not instructions. */

import { describe, expect, it } from 'vitest';
import { parseRawRequest } from './parser-vscode-request';

function instructions(...refs: Array<{ external?: string; fsPath?: string }>): string[] {
  return parseRawRequest({
    message: { text: 'go' },
    response: [{ value: 'done' }],
    contentReferences: refs.map(reference => ({ reference })),
  }).customInstructions;
}

const uri = (rel: string): string => `file:///c%3A/repo/${rel}`;

describe('VS Code custom instructions', () => {
  it('recognizes every instruction file kind the Local harness loads', () => {
    expect(instructions(
      { external: uri('.github/copilot-instructions.md') },
      { external: uri('.github/instructions/frontend/react.instructions.md') },
      { external: uri('AGENTS.md') },
      { external: uri('CLAUDE.md') },
      { external: uri('.claude/rules/testing.md') },
    )).toEqual(['copilot-instructions.md', 'react.instructions.md', 'AGENTS.md', 'CLAUDE.md', 'testing.md']);
  });

  it('does not count prompt files, custom agents or similarly named files as instructions', () => {
    expect(instructions(
      { external: uri('.github/prompts/fix.prompt.md') },
      { external: uri('.github/agents/reviewer.agent.md') },
      { external: uri('docs/subagents.md') },
      { external: uri('notes/my-claude.md') },
      { external: uri('GEMINI.md') },
      { external: uri('.claude/settings.json') },
      { external: uri('src/app.ts') },
    )).toEqual([]);
  });

  it('reads Windows paths, ignores URI queries and lists each file once', () => {
    expect(instructions(
      { fsPath: 'c:\\repo\\.github\\copilot-instructions.md' },
      { fsPath: 'c:\\repo\\.claude\\rules\\style.md' },
      { external: `${uri('AGENTS.md')}?vscodeLinkType=instructions` },
      { external: uri('AGENTS.md') },
    )).toEqual(['copilot-instructions.md', 'style.md', 'AGENTS.md']);
  });
});
