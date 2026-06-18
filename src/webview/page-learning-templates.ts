/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CachedResource, CodeComparisonRound, DidYouKnowFact, LearningState, QuizQuestion } from './page-learning-state';
import { html, type ComponentChildren } from './render';
import { COLORS } from './shared';
import { SVG } from './svg-icons';

const DYK_CAT_ICONS: Record<string, ComponentChildren> = {
  performance: SVG.zap,
  api: SVG.code,
  pitfall: SVG.warning,
  config: SVG.gear,
  debug: SVG.microscope,
};

export function renderResourcesHtml(resources: CachedResource[]): ComponentChildren {
  if (resources.length === 0) return html`<span class="text-muted" style="font-size:11px">No resources generated.</span>`;
  return resources.map(resource => html`
    <a href=${resource.url} class="learn-resource-link" target="_blank" title=${resource.reason}>
      ${SVG.externalLink} ${resource.title}
    </a>`);
}

export function renderCodeReviewRound(rounds: CodeComparisonRound[], index: number, state: LearningState): ComponentChildren {
  if (index >= rounds.length) {
    const pct = state.codeReviewTotal > 0 ? Math.round((state.codeReviewCorrect / state.codeReviewTotal) * 100) : 0;
    return html`
      <div class="learn-cr-done">
        <p><strong>Round complete!</strong> You picked the better code ${state.codeReviewCorrect} out of ${state.codeReviewTotal} times (${pct}%).</p>
        <button class="btn btn-primary btn-sm" id="cr-more-btn">${SVG.refresh} New Round</button>
      </div>`;
  }

  const round = rounds[index];
  const catColors: Record<string, string> = {
    performance: COLORS.yellow, safety: COLORS.red, readability: COLORS.blue,
    correctness: COLORS.green, security: COLORS.red,
  };
  const catColor = catColors[round.category] ?? COLORS.blue;

  return html`
    <div class="learn-cr-round" data-index=${String(index)}>
      <div class="learn-cr-meta">
        <span class="learn-cr-cat" style=${`background:${catColor}20;color:${catColor}`}>${round.category}</span>
        <span class=${`learn-cr-diff learn-quiz-diff-${round.difficulty}`}>${round.difficulty}</span>
        <span class="learn-quiz-num">${index + 1}/${rounds.length}</span>
      </div>
      <p class="learn-cr-title">${round.title}</p>
      <div class="learn-cr-pair">
        <div class="learn-cr-snippet" data-pick="A">
          <div class="learn-cr-snippet-label">A</div>
          <pre><code>${round.snippetA}</code></pre>
        </div>
        <div class="learn-cr-vs">VS</div>
        <div class="learn-cr-snippet" data-pick="B">
          <div class="learn-cr-snippet-label">B</div>
          <pre><code>${round.snippetB}</code></pre>
        </div>
      </div>
      <p class="learn-cr-prompt">Which one isn't slop?</p>
      <div class="learn-cr-feedback" id="cr-feedback" style="display:none"></div>
    </div>`;
}

export function renderDidYouKnowHtml(facts: DidYouKnowFact[]): ComponentChildren {
  if (facts.length === 0) return html`<span class="text-muted" style="font-size:11px">No facts generated.</span>`;
  return facts.map(fact => {
    const icon = DYK_CAT_ICONS[fact.category] ?? SVG.lightbulb;
    return html`<div class="learn-dyk-item">
      <div class="learn-dyk-icon">${icon}</div>
      <div class="learn-dyk-body">
        <div class="learn-dyk-fact">${fact.fact}</div>
        <div class="learn-dyk-project">${fact.project}</div>
      </div>
    </div>`;
  });
}

export function renderQuiz(questions: QuizQuestion[], index: number): ComponentChildren {
  if (index >= questions.length) {
    return html`
      <div class="learn-quiz-done">
        <span class="learn-quiz-done-icon">${SVG.checkCircle}</span>
        <p>Round complete!</p>
        <button class="btn btn-primary btn-sm" id="quiz-more-btn">More Challenges</button>
      </div>`;
  }

  const question = questions[index];
  return html`
    <div class="learn-quiz-card" key=${index} data-index=${String(index)}>
      <div class="learn-quiz-meta">
        <span class=${`learn-quiz-diff learn-quiz-diff-${question.difficulty}`}>${question.difficulty}</span>
        <span class="learn-quiz-topic">${question.topic}</span>
        <span class="learn-quiz-num">${index + 1}/${questions.length}</span>
      </div>
      <div class="learn-quiz-question">${question.question}</div>
      <div class="learn-quiz-choices">
        ${question.choices.map((choice, i) => html`<button class="learn-quiz-choice" data-choice=${String(i)}>${choice}</button>`)}
      </div>
      <div class="learn-quiz-actions">
        <button class="btn btn-secondary btn-sm learn-quiz-skip">${SVG.arrowRight} Skip</button>
      </div>
      <div class="learn-quiz-feedback" id="quiz-feedback" style="display:none"></div>
    </div>`;
}