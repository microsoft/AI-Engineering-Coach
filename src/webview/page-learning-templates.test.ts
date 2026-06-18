/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'preact-render-to-string';
import { h, Fragment } from 'preact';
import type { ComponentChildren } from 'preact';

/** Serialize VNodes (or arrays of VNodes) to an HTML string for assertion. */
function toHtml(vnode: ComponentChildren): string {
  if (vnode == null) return '';
  if (Array.isArray(vnode)) return renderToString(h(Fragment, null, ...vnode));
  return renderToString(vnode as Parameters<typeof renderToString>[0]);
}

vi.mock('./shared', () => ({
  COLORS: { blue: '#58a6ff', green: '#3fb950', red: '#f85149', yellow: '#d29922' },
}));

vi.mock('./svg-icons', () => ({
  SVG: {
    arrowRight: '<svg data-icon="arrow-right"></svg>',
    checkCircle: '<svg data-icon="check-circle"></svg>',
    code: '<svg data-icon="code"></svg>',
    externalLink: '<svg data-icon="external-link"></svg>',
    gear: '<svg data-icon="gear"></svg>',
    lightbulb: '<svg data-icon="lightbulb"></svg>',
    microscope: '<svg data-icon="microscope"></svg>',
    refresh: '<svg data-icon="refresh"></svg>',
    warning: '<svg data-icon="warning"></svg>',
    zap: '<svg data-icon="zap"></svg>',
  },
}));

type TemplatesModule = typeof import('./page-learning-templates');

let templates: TemplatesModule;

beforeAll(async () => {
  templates = await import('./page-learning-templates');
});

describe('page-learning-templates', () => {
  it('renders escaped resource links', () => {
    const result = toHtml(templates.renderResourcesHtml([
      {
        title: 'TypeScript <Guide>',
        url: 'https://example.com/docs',
        type: 'Docs',
        reason: 'Use "strict" mode',
      },
    ]));

    expect(result).toContain('TypeScript &lt;Guide>');
    expect(result).toContain('https://example.com/docs');
    expect(result).toContain('Use &quot;strict&quot; mode');
  });

  it('renders the code-review completion state', () => {
    const result = toHtml(templates.renderCodeReviewRound([], 1, {
      codeReviewCorrect: 3,
      codeReviewTotal: 4,
    } as never));

    expect(result).toContain('Round complete!');
    expect(result).toContain('3 out of 4');
    expect(result).toContain('75%');
  });

  it('renders quiz choices and navigation affordances', () => {
    const result = toHtml(templates.renderQuiz([
      {
        question: 'What happens?',
        choices: ['A', 'B', 'C', 'D'],
        correctIndex: 1,
        explanation: 'Because.',
        difficulty: 'medium',
        topic: 'Async',
      },
    ], 0));

    expect(result).toContain('What happens?');
    expect(result).toContain('data-choice="3"');
    expect(result).toContain('learn-quiz-skip');
  });

  it('keys quiz cards by question index to avoid stale DOM reuse', () => {
    const vnode = templates.renderQuiz([
      { question: 'Q1', choices: ['A', 'B'], correctIndex: 0, explanation: '', difficulty: 'easy', topic: 'x' },
    ] as never, 0) as { key?: unknown };

    expect(vnode.key).toBe(0);
  });
});