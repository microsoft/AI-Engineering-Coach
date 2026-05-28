/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileUriToPath } from '../core/helpers';
import { Analyzer } from '../core/analyzer';
import { ParseResult } from '../core/parser';
import { readFileSafe } from '../core/parser-shared';
import { Workspace } from '../core/types';
import { exportSummaryFiles } from '../summary-export-vscode';
import {
  callLlm,
  callLlmJson,
  SCHEMA_CATALOG_PICKS,
  SCHEMA_CODE_REVIEW,
  SCHEMA_CONTEXT_REVIEW,
  SCHEMA_DID_YOU_KNOW,
  SCHEMA_QUIZ,
  SCHEMA_RESOURCES,
  SCHEMA_TRIAGE,
} from './panel-llm';
import { getCatalogItems } from './panel-catalog';
import { validateDateFilter } from './panel-rpc';
import { isNumber, isOptionalString, isRecord, isString, postError, postEvent, postResponse, RequestMessage } from './panel-shared';

type CustomPanelMethodName =
  | 'createSkill'
  | 'generateSkillContent'
  | 'generateLearningQuiz'
  | 'generateLearningResources'
  | 'generateCodeComparison'
  | 'generateDidYouKnow'
  | 'exportSummary'
  | 'installSkill'
  | 'installCatalogItem'
  | 'triageSkills'
  | 'discoverCatalog'
  | 'triageCatalog'
  | 'reviewContextFiles'
  | 'getWorkspaceDeps'
  | 'getSdlcToolAnalysis'
  | 'getSdlcRepoScan'
  | 'getSdlcGitHubData';

type RequestHandler = (msg: RequestMessage) => void | Promise<void>;
type QuizDifficulty = 'easy' | 'medium' | 'hard';
type QuizRequestContext = {
  languages: string[];
  topics: string[];
  difficulty: QuizDifficulty;
  solved: number;
  failed: number;
  solvedSamples: string[];
  failedSamples: string[];
  focusSkills: string[];
  packageDeps: string[];
  customGoals: string[];
  leitnerBox: number;
  reviewTopics: string[];
};
type QuizQuestion = {
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  difficulty: string;
  topic: string;
};

const QUIZ_DIFFICULTIES: ReadonlySet<QuizDifficulty> = new Set(['easy', 'medium', 'hard']);

function getStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter(isString).slice(0, limit) : [];
}

function toText(value: unknown): string {
  if (isString(value)) return value;
  if (isNumber(value) || typeof value === 'boolean') return String(value);
  return '';
}

function getObjectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  const content = readFileSafe(filePath);
  if (!content) return undefined;
  const parsed: unknown = JSON.parse(content);
  return isRecord(parsed) ? parsed : undefined;
}

export class PanelRequestService {
  private matchesWorkspace(session: { workspaceId: string; workspaceName: string }, workspaceId?: string): boolean {
    if (!workspaceId) return true;
    return session.workspaceId === workspaceId || session.workspaceName === workspaceId;
  }

  private readonly handlers: Record<CustomPanelMethodName, RequestHandler> = {
    createSkill: this.handleCreateSkill.bind(this),
    generateSkillContent: this.handleGenerateSkillContent.bind(this),
    generateLearningQuiz: this.handleGenerateLearningQuiz.bind(this),
    generateLearningResources: this.handleGenerateLearningResources.bind(this),
    generateCodeComparison: this.handleGenerateCodeComparison.bind(this),
    generateDidYouKnow: this.handleGenerateDidYouKnow.bind(this),
    exportSummary: this.handleExportSummary.bind(this),
    installSkill: this.handleInstallSkill.bind(this),
    installCatalogItem: this.handleInstallCatalogItem.bind(this),
    triageSkills: this.handleTriageSkills.bind(this),
    discoverCatalog: this.handleDiscoverCatalog.bind(this),
    triageCatalog: this.handleTriageCatalog.bind(this),
    reviewContextFiles: this.handleReviewContextFiles.bind(this),
    getWorkspaceDeps: this.handleGetWorkspaceDeps.bind(this),
    getSdlcToolAnalysis: this.handleGetSdlcToolAnalysis.bind(this),
    getSdlcRepoScan: this.handleGetSdlcRepoScan.bind(this),
    getSdlcGitHubData: this.handleGetSdlcGitHubData.bind(this),
  };

  constructor(
    private readonly webview: vscode.Webview,
    private readonly getAnalyzer: () => Analyzer | undefined,
    private readonly getParseResult: () => ParseResult | undefined,
  ) {}

  tryHandle(msg: RequestMessage): boolean {
    const handler = this.handlers[msg.method as CustomPanelMethodName];
    if (!handler) return false;
    void Promise.resolve(handler(msg)).catch((error: unknown) => {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Internal error');
    });
    return true;
  }

  private get analyzer(): Analyzer | undefined {
    return this.getAnalyzer();
  }

  private get parseResult(): ParseResult | undefined {
    return this.getParseResult();
  }

  private getQuizRequestContext(msg: RequestMessage): QuizRequestContext {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const difficultyValue = isString(params.difficulty) && QUIZ_DIFFICULTIES.has(params.difficulty as QuizDifficulty)
      ? params.difficulty as QuizDifficulty
      : 'easy';

    return {
      languages: getStringArray(params.languages, 10),
      topics: getStringArray(params.topics, 10),
      difficulty: difficultyValue,
      solved: isNumber(params.solved) ? params.solved : 0,
      failed: isNumber(params.failed) ? params.failed : 0,
      solvedSamples: getStringArray(params.solvedSamples, 5),
      failedSamples: getStringArray(params.failedSamples, 5),
      focusSkills: getStringArray(params.focusSkills, 10),
      packageDeps: getStringArray(params.packageDeps, 30),
      customGoals: getStringArray(params.customGoals, 5),
      leitnerBox: isNumber(params.leitnerBox) ? params.leitnerBox : 0,
      reviewTopics: getStringArray(params.reviewTopics, 10),
    };
  }

  private buildQuizSystemPrompt(context: QuizRequestContext): string {
    const reviewContext = context.leitnerBox > 0
      ? `\nSPACED REPETITION (Leitner Box ${context.leitnerBox}/7):
- Box 1-2: New/recently failed topics — ask fundamental questions to build base understanding
- Box 3-4: Intermediate retention — ask application questions that require combining concepts
- Box 5-6: Good retention — ask advanced/tricky edge-case questions
- Box 7: Mastered — ask interview-level questions to validate deep understanding
Current box topics to review: ${context.reviewTopics.join(', ') || 'general'}`
      : '';

    const depsContext = context.packageDeps.length > 0
      ? `\nECOSYSTEM CONTEXT (dependencies from their project — use as context for realistic coding scenarios):
${context.packageDeps.join(', ')}
Use these to create realistic code snippets and scenarios. DO NOT ask what a package does or how to install it. Instead, write code USING these tools and ask about behavior, output, or bugs.`
      : '';

    const goalsContext = context.customGoals.length > 0
      ? `\nUSER'S CUSTOM LEARNING GOALS (prioritize these):
${context.customGoals.map(goal => `- ${goal}`).join('\n')}`
      : '';

    const focusContext = context.focusSkills.length > 0
      ? `\nSKILL POINTS INVESTED (these are the topics the dev WANTS to learn — weight questions toward these):
${context.focusSkills.map(skill => `- ${skill}`).join('\n')}`
      : '';

    const solvedContext = context.solvedSamples.length > 0
      ? `Questions they already know (avoid similar ones):\n${context.solvedSamples.map(sample => `- ${sample}`).join('\n')}`
      : '';
    const failedContext = context.failedSamples.length > 0
      ? `Questions they struggled with (create related ones to reinforce):\n${context.failedSamples.map(sample => `- ${sample}`).join('\n')}`
      : '';

    return `You are a senior developer creating realistic coding challenges that test practical knowledge within a specific tech ecosystem.

Generate exactly 3 multiple-choice questions. Each question must have exactly 4 choices with exactly one correct answer.

CRITICAL RULES — READ CAREFULLY:
- Questions must present REALISTIC CODING SCENARIOS — "What happens when you run this code?", "Which approach correctly handles X?", "What is the output of this snippet?"
- Include SHORT CODE SNIPPETS (2-6 lines) in the question whenever possible. Use the actual language syntax.
- DO NOT ask "What is the main benefit of installing @types/X" or "What does package Y do" — these are trivia, not coding challenges
- DO NOT ask about installing, configuring, or comparing packages. Ask about WRITING CODE with them.
- Good question types: debug this code, predict the output, fix the bug, choose the correct implementation, identify the error
- The developer's dependencies are context for WHAT ecosystem to quiz on, not individual packages to ask about
- Difficulty level: ${context.difficulty}
  - easy: common patterns, typical gotchas, "what does this code print?" — practical fundamentals
  - medium: subtle bugs, async edge cases, performance pitfalls, type system challenges — requires deeper understanding
  - hard: architecture trade-offs, concurrency bugs, security vulnerabilities in code — expert-level reasoning
- Explanations should teach a practical insight the developer can USE in their code, in 1-2 sentences
- The "topic" field should match one of the focus skills listed below (e.g. "Error Handling", "Async", "Type System")
${reviewContext}${depsContext}${goalsContext}${focusContext}
${solvedContext}
${failedContext}

Respond with a JSON object: {"items":[{"question":"...","choices":["A","B","C","D"],"correctIndex":0,"explanation":"...","difficulty":"easy|medium|hard","topic":"..."}]}`;
  }

  private buildQuizUserPrompt(context: QuizRequestContext): string {
    return `Developer profile:
- Languages: ${context.languages.join(', ') || 'general programming'}
- Topics of interest: ${context.topics.join(', ') || 'general software engineering'}
- Stats: ${context.solved} solved, ${context.failed} failed
- Current difficulty: ${context.difficulty}
${context.packageDeps.length > 0 ? `- Key dependencies: ${context.packageDeps.slice(0, 15).join(', ')}` : ''}
${context.focusSkills.length > 0 ? `- Skill focus areas: ${context.focusSkills.join(', ')}` : ''}

Generate 3 ${context.difficulty} interview-style questions tailored to this developer's actual stack.`;
  }

  private async handleExportSummary(msg: RequestMessage): Promise<void> {
    if (!this.analyzer) {
      postError(this.webview, msg.id, 'Dashboard data is still loading. Try again once the dashboard is ready.');
      return;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const filter = isRecord(params.filter) ? validateDateFilter(params.filter) : validateDateFilter(params);

    try {
      const result = await exportSummaryFiles(this.analyzer, filter);
      postResponse(this.webview, msg.id, result);
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Failed to export summary');
    }
  }

  private normalizeQuizQuestions(response: { items: QuizQuestion[] } | QuizQuestion[], fallbackDifficulty: QuizDifficulty): Array<{
    question: string;
    choices: string[];
    correctIndex: number;
    explanation: string;
    difficulty: QuizDifficulty;
    topic: string;
  }> {
    const questions = Array.isArray(response) ? response : response.items ?? [];
    return questions
      .filter(question =>
        typeof question.question === 'string' &&
        Array.isArray(question.choices) && question.choices.length === 4 &&
        typeof question.correctIndex === 'number' && question.correctIndex >= 0 && question.correctIndex < 4 &&
        typeof question.explanation === 'string',
      )
      .slice(0, 3)
      .map(question => ({
        question: question.question,
        choices: question.choices.map(choice => toText(choice)),
        correctIndex: question.correctIndex,
        explanation: question.explanation,
        difficulty: QUIZ_DIFFICULTIES.has(question.difficulty as QuizDifficulty) ? question.difficulty as QuizDifficulty : fallbackDifficulty,
        topic: toText(question.topic) || 'general',
      }));
  }

  private readWorkspaceDependencyLists(pkgPath: string): { dependencies: string[]; devDependencies: string[] } | undefined {
    const pkg = readJsonRecord(pkgPath);
    if (!pkg) return undefined;
    return {
      dependencies: getObjectKeys(pkg.dependencies),
      devDependencies: getObjectKeys(pkg.devDependencies),
    };
  }

  private handleCreateSkill(msg: RequestMessage): void {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const prompt = isString(params.prompt) ? params.prompt : '';
    if (!prompt) return;

    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
    }).then(
      () => postResponse(this.webview, msg.id, { ok: true }),
      () => postError(this.webview, msg.id, 'Failed to open Copilot Chat'),
    );
  }

  private async handleGenerateSkillContent(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const label = isString(params.label) ? params.label : 'skill';
    const pattern = isString(params.pattern) ? params.pattern : '';
    const occurrences = isNumber(params.occurrences) ? params.occurrences : 0;
    const sessions = isNumber(params.sessions) ? params.sessions : 0;
    const examples = Array.isArray(params.examples) ? (params.examples as string[]).slice(0, 5) : [];
    const skillDraft = isString(params.skillDraft) ? params.skillDraft : '';

    const systemPrompt = `You are an expert at writing SKILL.md files for VS Code GitHub Copilot.
A skill file is a markdown instruction file that teaches Copilot how to handle a specific repeated workflow pattern.

Generate a professional, production-ready SKILL.md file. Include:
1. YAML frontmatter with: name, description, and an applyTo glob pattern
2. A clear "## When to Use" section
3. Detailed "## Steps" with numbered instructions the AI should follow
4. A "## Guidelines" section with quality criteria

Respond with ONLY the markdown content of the SKILL.md file, nothing else.`;

    const userPrompt = `Create a SKILL.md for this workflow pattern:

Name: ${label}
Pattern: ${pattern}
Seen ${occurrences} times across ${sessions} sessions.

Example prompts from the user:
${examples.map(ex => `- "${ex}"`).join('\n')}

Starting draft:
${skillDraft}`;

    try {
      const text = await callLlm([
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ]);

      let content = text.trim();
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```$/, '');
      }

      const slug = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '');
      postResponse(this.webview, msg.id, { content, filename: `${slug}/SKILL.md` });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Generation failed');
    }
  }

  private async handleGenerateLearningQuiz(msg: RequestMessage): Promise<void> {
    const context = this.getQuizRequestContext(msg);
    const systemPrompt = this.buildQuizSystemPrompt(context);
    const userPrompt = this.buildQuizUserPrompt(context);

    try {
      const response = await callLlmJson<{ items: QuizQuestion[] }>([
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ], SCHEMA_QUIZ);

      const validated = this.normalizeQuizQuestions(response, context.difficulty);
      postResponse(this.webview, msg.id, { questions: validated });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Quiz generation failed. Please try again.');
    }
  }

  private async handleGenerateCodeComparison(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const languages = Array.isArray(params.languages) ? (params.languages as string[]).slice(0, 10) : [];
    const packageDeps = Array.isArray(params.packageDeps) ? (params.packageDeps as string[]).slice(0, 30) : [];
    const difficulty = isString(params.difficulty) ? params.difficulty : 'medium';
    const seenTopics = Array.isArray(params.seenTopics) ? (params.seenTopics as string[]).slice(0, 10) : [];

    const depsContext = packageDeps.length > 0
      ? `\nDEPENDENCIES (use these to write realistic code using libraries the developer actually works with):
${packageDeps.join(', ')}`
      : '';

    const systemPrompt = `You are a senior code reviewer generating side-by-side code comparisons for a "Code Review" training game.

Generate exactly 3 code comparison rounds. In each round, present TWO short code snippets (4-12 lines each) that accomplish the SAME task. One snippet is subtly better than the other.

CRITICAL RULES:
- Both snippets must be PLAUSIBLE, working code — no obvious syntax errors or broken logic in either
- The difference must be SUBTLE — a junior dev might not immediately see which is better
- Do NOT make it obvious with comments saying "bad" or "good"
- Both snippets should look professional at first glance
- Use real patterns, libraries, and idioms from: ${languages.join(', ') || 'general programming'}
${depsContext}

KINDS OF SUBTLE DIFFERENCES (vary across rounds):
- Time complexity: O(n) vs O(n²) hidden in a familiar pattern (e.g. includes() inside a loop vs Set lookup)
- Memory: unnecessary cloning, spreading in a hot path, intermediate allocations
- Race conditions: missing await, unhandled promise, subtle async ordering
- Error handling: swallowing errors vs proper propagation, missing edge cases
- Mutability traps: mutating shared state vs creating new references
- API misuse: deprecated or fragile API patterns vs modern idiomatic ones
- Security: subtle injection vectors, unsafe defaults, missing sanitization
- Readability: clever one-liner vs clear intent (sometimes the "clever" one IS worse)
- Off-by-one: subtle boundary errors that only matter with specific inputs
- Type safety: loose comparisons, implicit coercion, missing null checks

Difficulty: ${difficulty}
- easy: the better snippet has a slightly cleaner structure or avoids a common beginner mistake
- medium: requires understanding of runtime behavior, complexity, or subtle API differences
- hard: both look nearly identical — the difference is an edge case, a race condition, or an architectural principle

${seenTopics.length > 0 ? `Avoid these topics (already seen): ${seenTopics.join(', ')}` : ''}

Respond with a JSON object: {"items":[{"snippetA":"code string","snippetB":"code string","betterSnippet":"A or B","title":"short task description","category":"performance|safety|readability|correctness|security","explanation":"2-3 sentences explaining WHY","difficulty":"easy|medium|hard","language":"the language used"}]}`;

    const userPrompt = `Developer stack: ${languages.join(', ') || 'general programming'}
${packageDeps.length > 0 ? `Dependencies: ${packageDeps.slice(0, 15).join(', ')}` : ''}
Difficulty: ${difficulty}

Generate 3 code comparison rounds for this developer's ecosystem. Mix the categories.`;

    try {
      const response = await callLlmJson<{ items: Array<{
        snippetA: string;
        snippetB: string;
        betterSnippet: string;
        title: string;
        category: string;
        explanation: string;
        difficulty: string;
        language: string;
      }> }>([
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ], SCHEMA_CODE_REVIEW);

      const rounds = Array.isArray(response) ? response as unknown as typeof response['items'] : response.items ?? [];
      const validated = rounds
        .filter(round =>
          typeof round.snippetA === 'string' && round.snippetA.length > 0 &&
          typeof round.snippetB === 'string' && round.snippetB.length > 0 &&
          (round.betterSnippet === 'A' || round.betterSnippet === 'B') &&
          typeof round.title === 'string' &&
          typeof round.explanation === 'string',
        )
        .slice(0, 3)
        .map(round => ({
          snippetA: round.snippetA,
          snippetB: round.snippetB,
          betterSnippet: round.betterSnippet as 'A' | 'B',
          title: round.title,
          category: (['performance', 'safety', 'readability', 'correctness', 'security'].includes(round.category) ? round.category : 'readability'),
          explanation: round.explanation,
          difficulty: (['easy', 'medium', 'hard'].includes(round.difficulty) ? round.difficulty : difficulty),
          language: String(round.language || languages[0] || 'code'),
        }));

      postResponse(this.webview, msg.id, { rounds: validated });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Code comparison generation failed. Please try again.');
    }
  }

  private async handleGenerateDidYouKnow(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const languages = Array.isArray(params.languages) ? (params.languages as string[]).slice(0, 10) : [];
    const packageDeps = Array.isArray(params.packageDeps) ? (params.packageDeps as string[]).slice(0, 30) : [];
    const workspaces = Array.isArray(params.workspaces) ? (params.workspaces as string[]).slice(0, 10) : [];
    const seenFacts = Array.isArray(params.seenFacts) ? (params.seenFacts as string[]).slice(0, 20) : [];

    const depsContext = packageDeps.length > 0 ? `\nDEPENDENCIES: ${packageDeps.join(', ')}` : '';
    const projectContext = workspaces.length > 0 ? `\nACTIVE PROJECTS: ${workspaces.join(', ')}` : '';

    const systemPrompt = `You are a senior developer sharing practical "Did you know?" facts tailored to a developer's ACTUAL tech stack and projects.

Generate exactly 5 short, useful nuggets of information. These should be genuinely surprising or lesser-known facts that are directly relevant to the developer's stack.

RULES:
- Each fact must reference at least one specific dependency, language feature, or project from the developer's stack
- Facts should be ACTIONABLE — something the developer can try or apply today
- Include the project or dependency name that the fact relates to
- Mix categories: performance tricks, lesser-known APIs, common pitfalls, config shortcuts, debugging tips
- Do NOT be generic ("JavaScript is dynamically typed") — be SPECIFIC ("In your express project, did you know app.set('etag', 'strong') enables HTTP 304 responses?")
- Keep each fact to 1-2 sentences max
- The "project" field should mention which workspace project or dependency this relates to
${seenFacts.length > 0 ? `\nAvoid these (already shown): ${seenFacts.join(' | ')}` : ''}

Languages: ${languages.join(', ') || 'general'}${depsContext}${projectContext}

Respond with a JSON object: {"items":[{"fact":"...", "project":"...", "category":"performance|api|pitfall|config|debug"}]}`;

    try {
      const response = await callLlmJson<{ items: Array<{ fact: string; project: string; category: string }> }>(
        [vscode.LanguageModelChatMessage.User(systemPrompt)],
        SCHEMA_DID_YOU_KNOW,
      );
      const facts = Array.isArray(response) ? response as unknown as typeof response['items'] : response.items ?? [];
      const validated = facts
        .filter(fact => typeof fact.fact === 'string' && fact.fact.length > 0 && typeof fact.project === 'string')
        .slice(0, 5)
        .map(fact => ({
          fact: fact.fact,
          project: fact.project,
          category: (['performance', 'api', 'pitfall', 'config', 'debug'].includes(fact.category) ? fact.category : 'api'),
        }));

      postResponse(this.webview, msg.id, { facts: validated });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Did-you-know generation failed');
    }
  }

  private async handleGenerateLearningResources(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const languages = Array.isArray(params.languages) ? (params.languages as string[]).slice(0, 10) : [];
    const gaps = Array.isArray(params.gaps) ? (params.gaps as string[]).slice(0, 10) : [];
    const focusConcepts = Array.isArray(params.focusConcepts) ? (params.focusConcepts as string[]).slice(0, 10) : [];
    const packageDeps = Array.isArray(params.packageDeps) ? (params.packageDeps as string[]).slice(0, 20) : [];
    const workspaces = Array.isArray(params.workspaces) ? (params.workspaces as string[]).slice(0, 10) : [];

    const projectContext = workspaces.length > 0 ? `\nACTIVE PROJECTS: ${workspaces.join(', ')}` : '';

    const systemPrompt = `You are a senior engineering mentor recommending learning resources for a developer.

Generate exactly 6 learning resource recommendations. Each must be a REAL, verified resource that exists on the internet (official docs, well-known courses, GitHub repos with 1k+ stars, reputable tutorial sites).

RULES:
- Resources MUST be personalized to the developer's actual tech stack & dependencies listed below
- Prioritize: official documentation, well-maintained open-source repos, known tutorial platforms
- DO NOT invent fake URLs or resources. Only recommend resources you are confident exist.
- Mix resource types: docs, interactive tutorials, repos, video courses, practice platforms
- If knowledge gaps are listed, prioritize resources that address those gaps
- If focus concepts are listed, recommend resources that teach those specific concepts
- If active projects are listed, tailor resources to the frameworks and tools used in those projects
- Include a 1-sentence reason explaining why this resource is relevant to THIS developer

Developer profile:
- Languages: ${languages.join(', ') || 'general programming'}
- Key dependencies: ${packageDeps.join(', ') || 'none detected'}
- Knowledge gaps: ${gaps.join(', ') || 'none detected'}
- Focus concepts: ${focusConcepts.join(', ') || 'none selected'}${projectContext}

Respond with a JSON object: {"items":[{"title":"...","url":"https://...","type":"Language|Framework|Concept|Practice","reason":"..."}]}`;

    try {
      const response = await callLlmJson<{ items: Array<{ title: string; url: string; type: string; reason: string }> }>(
        [vscode.LanguageModelChatMessage.User(systemPrompt)],
        SCHEMA_RESOURCES,
      );
      const resources = Array.isArray(response) ? response as unknown as typeof response['items'] : response.items ?? [];
      const validated = resources
        .filter(resource => typeof resource.title === 'string' && typeof resource.url === 'string' && resource.url.startsWith('https://'))
        .slice(0, 6)
        .map(resource => ({ title: resource.title, url: resource.url, type: String(resource.type || 'Resource'), reason: String(resource.reason || '') }));

      postResponse(this.webview, msg.id, { resources: validated });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Resource generation failed', { resources: [] });
    }
  }

  private handleGetWorkspaceDeps(msg: RequestMessage): void {
    if (!this.parseResult) {
      postResponse(this.webview, msg.id, { deps: [] });
      return;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const limit = isNumber(params.limit) ? Math.min(params.limit, 20) : 10;
    const wsActivity = new Map<string, number>();
    for (const session of this.parseResult.sessions) {
      const existing = wsActivity.get(session.workspaceId) || 0;
      const ts = session.lastMessageDate || session.creationDate || 0;
      if (ts > existing) wsActivity.set(session.workspaceId, ts);
    }

    const deps: { workspace: string; dependencies: string[]; devDependencies: string[] }[] = [];
    for (const workspace of this.resolveWorkspaceRoots().sort((a, b) => (wsActivity.get(b.workspaceId) || 0) - (wsActivity.get(a.workspaceId) || 0)).slice(0, limit)) {
      const pkgPath = path.join(workspace.rootPath, 'package.json');
      try {
        const packageLists = this.readWorkspaceDependencyLists(pkgPath);
        if (!packageLists) continue;
        deps.push({
          workspace: workspace.workspaceName,
          dependencies: packageLists.dependencies,
          devDependencies: packageLists.devDependencies,
        });
      } catch {
        continue;
      }
    }

    postResponse(this.webview, msg.id, { deps });
  }

  private async handleInstallSkill(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const filename = isString(params.filename) ? params.filename : '';
    const content = isString(params.content) ? params.content : '';
    if (!filename || !content) {
      postError(this.webview, msg.id, 'Missing filename or content');
      return;
    }
    if (filename.includes('..') || filename.startsWith('/')) {
      postError(this.webview, msg.id, 'Invalid filename');
      return;
    }

    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (!homeDir) {
        postError(this.webview, msg.id, 'Cannot determine home directory');
        return;
      }
      const targetUri = vscode.Uri.file(`${homeDir}/.agents/skills/${filename}`);
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
      postResponse(this.webview, msg.id, { ok: true, path: targetUri.fsPath });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Install failed');
    }
  }

  private async handleInstallCatalogItem(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const catalogPath = isString(params.path) ? params.path : '';
    const kind = isString(params.kind) ? params.kind : 'skill';
    const title = isString(params.title) ? params.title : '';
    if (!catalogPath || catalogPath.includes('..') || catalogPath.startsWith('/') || catalogPath.startsWith('\\')) {
      postError(this.webview, msg.id, 'Invalid catalog path');
      return;
    }

    try {
      const rawUrl = `https://raw.githubusercontent.com/github/awesome-copilot/main/${catalogPath}`;
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.hostname !== 'raw.githubusercontent.com' || !parsedUrl.pathname.startsWith('/github/awesome-copilot/')) {
        postError(this.webview, msg.id, 'Invalid catalog URL');
        return;
      }
      const response = await fetch(parsedUrl.toString());
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
      const content = await response.text();

      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (!homeDir) throw new Error('Cannot determine home directory');
      const subDir = kind === 'agent' ? 'agents' : 'skills';
      const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '');
      const filename = catalogPath.split('/').pop() || `${slug}.md`;
      if (slug.includes('..') || filename.includes('..')) throw new Error('Invalid path');

      const targetUri = vscode.Uri.file(`${homeDir}/.agents/${subDir}/${slug}/${filename}`);
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
      postResponse(this.webview, msg.id, { content, filename: `${slug}/${filename}` });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Install failed');
    }
  }

  private async handleTriageSkills(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const clustersRaw = Array.isArray(params.clusters) ? params.clusters : [];
    const workspaceFilter = isString(params.workspace) ? params.workspace : undefined;

    const clusterSummaries = clustersRaw.slice(0, 200).map((cluster: unknown) => {
      const entry = cluster as Record<string, unknown>;
      return {
        id: isString(entry.id) ? entry.id : '',
        label: isString(entry.label) ? entry.label : '',
        occurrences: isNumber(entry.occurrences) ? entry.occurrences : 0,
        sessions: isNumber(entry.sessions) ? entry.sessions : 0,
        cancelRate: isNumber(entry.cancelRate) ? entry.cancelRate : 0,
        avgCorrectionTurns: isNumber(entry.avgCorrectionTurns) ? entry.avgCorrectionTurns : 0,
        workspaces: Array.isArray(entry.workspaces) ? entry.workspaces : [],
        examples: Array.isArray(entry.examples) ? (entry.examples as string[]).slice(0, 3) : [],
      };
    });

    const context = this.getUserContext();
    const systemPrompt = `You are an expert at identifying repeatable activities in a developer's AI coding assistant usage.

You will receive groups of SIMILAR prompts that a developer has sent repeatedly to their AI coding agent. Each group includes the prompt text, how many times it occurred, and example prompts showing the actual wording.

Your task is to identify which groups represent a REPEATED ACTIVITY — something the developer does over and over as part of their workflow. Examples of repeated activities:
- Parsing log files or data files
- Starting, building, or packaging an application
- Scaffolding new components or services
- Running deployments or migrations
- Generating boilerplate (tests, configs, API endpoints)
- Analyzing or transforming specific data formats

For each group, look at the EXAMPLE PROMPTS carefully. They show the actual words the developer used. Ask yourself: "Is this developer doing the same type of task repeatedly? Could a skill file automate or speed this up?"

SKIP groups that are:
- Generic coding questions ("how do I...", "what is...")
- One-off debugging ("fix this error", "why is this failing")
- Standard refactoring ("clean up", "rename", "add types")
- Conversational or vague prompts

Respond with a JSON object: {"items":[{"id":"...","verdict":"strong","reason":"one sentence","suggestedSkillName":"short-kebab-name"}]}
Include ONLY groups with verdict "strong" (max 10).`;

    const userPrompt = `Developer context:
- Languages: ${context.languages.join(', ') || 'unknown'}
- Harnesses: ${context.harnesses.join(', ') || 'unknown'}
- Common topics: ${context.topics.join(', ') || 'unknown'}
- Workspaces: ${context.workspaces.join(', ') || 'unknown'}${workspaceFilter ? `\n- Currently filtering: ${workspaceFilter}` : ''}

Here are the top ${clusterSummaries.length} groups of similar prompts this developer sends repeatedly:\n\n${JSON.stringify(clusterSummaries, null, 2)}`;

    try {
      const response = await callLlmJson<{ items: Array<{ id: string; verdict: string; reason: string; suggestedSkillName: string | null }> }>([
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ], SCHEMA_TRIAGE);
      const triaged = Array.isArray(response) ? response as unknown as typeof response['items'] : response.items ?? [];
      const validVerdicts = new Set(['strong', 'maybe', 'skip']);
      const result = triaged.map(item => ({
        id: String(item.id || ''),
        label: clusterSummaries.find(cluster => cluster.id === item.id)?.label || '',
        verdict: validVerdicts.has(item.verdict) ? item.verdict as 'strong' | 'maybe' | 'skip' : 'maybe' as const,
        reason: String(item.reason || ''),
        suggestedSkillName: item.suggestedSkillName ? String(item.suggestedSkillName) : null,
      }));

      postResponse(this.webview, msg.id, { triaged: result });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'AI triage failed');
    }
  }

  private async handleDiscoverCatalog(msg: RequestMessage): Promise<void> {
    try {
      const items = (await getCatalogItems()).map(item => ({
        ...item,
        relevanceScore: 0,
        matchReasons: [],
      }));
      postResponse(this.webview, msg.id, { items, totalScanned: items.length });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'Failed to fetch catalog');
    }
  }

  private async handleTriageCatalog(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const itemsRaw: unknown[] = Array.isArray(params.items) ? params.items : [];
    const candidates = itemsRaw.map((item: unknown) => {
      const entry = isRecord(item) ? item : {};
      return {
        id: toText(entry.id),
        kind: toText(entry.kind),
        title: toText(entry.title),
        description: toText(entry.description).slice(0, 120),
        category: toText(entry.category),
      };
    });

    const clustersRaw = Array.isArray(params.clusters) ? params.clusters : [];
    const clusterContext = clustersRaw.slice(0, 30).map((cluster: unknown) => {
      const entry = isRecord(cluster) ? cluster : {};
      return {
        label: toText(entry.label),
        occurrences: typeof entry.occurrences === 'number' ? entry.occurrences : 0,
        workspaces: Array.isArray(entry.workspaces) ? entry.workspaces : [],
        examples: getStringArray(entry.examples, 2),
      };
    });

    const context = this.getUserContext();
    const workspace = isOptionalString(params.workspace) ? params.workspace : undefined;

    const systemPrompt = `You are an expert at recommending GitHub Copilot customization files (skills, agents, instructions, hooks) for developers.

You will receive:
1. The developer's context: languages, harnesses, topics, and which workspace they are currently analyzing
2. Their TOP REPEATED WORKFLOW PATTERNS with example prompts — these show exactly what tasks the developer performs repeatedly
3. The FULL community catalog (${candidates.length} items) of skills, agents, instructions, and hooks

Your job:
1. Study the workflow patterns and example prompts carefully. These tell you EXACTLY what this developer does day-to-day.
2. Consider the specific workspace being analyzed: ${workspace ? `"${workspace}"` : 'all workspaces'}.
3. From the FULL catalog, find items that DIRECTLY help with the developer's actual repeated tasks or tech stack.
4. REJECT items that don't match. A .NET skill is useless for someone building VS Code extensions. A React skill is useless for someone writing Python CLIs.
5. For each pick, write a concrete reason referencing the developer's ACTUAL workflow patterns. Example: "You repeatedly package VS Code extensions (seen 47 times) — this skill automates VSIX packaging."

Respond with a JSON object: {"items":[{"id":"...","reason":"specific sentence referencing their actual workflow patterns"}]}
Max 5 items. If fewer genuinely match, return fewer. If NOTHING matches well, return empty items array. Do NOT pad with generic picks.`;

    const clusterSection = clusterContext.length > 0
      ? `\n\nTop repeated workflow patterns (${clusterContext.length}):\n${JSON.stringify(clusterContext, null, 2)}`
      : '';

    const userPrompt = `Developer context:
- Languages: ${context.languages.join(', ') || 'unknown'}
- Harnesses: ${context.harnesses.join(', ') || 'unknown'}
- Common topics: ${context.topics.join(', ') || 'unknown'}
- Analyzing workspace: ${workspace || 'all workspaces'}${clusterSection}

Full catalog (${candidates.length} items):
${JSON.stringify(candidates)}`;

    try {
      const response = await callLlmJson<{ items: Array<{ id: string; reason: string }> }>([
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ], SCHEMA_CATALOG_PICKS);
      const picks = Array.isArray(response) ? response as unknown as typeof response['items'] : response.items ?? [];
      const enriched = picks.map(pick => {
        const rawItem = itemsRaw.find(item => isRecord(item) && item.id === pick.id);
        const raw = isRecord(rawItem) ? rawItem : undefined;
        return {
          id: pick.id,
          kind: toText(raw?.kind),
          title: toText(raw?.title),
          description: toText(raw?.description),
          category: toText(raw?.category),
          path: toText(raw?.path),
          url: toText(raw?.url),
          relevanceScore: 100,
          matchReasons: [pick.reason],
        };
      }).filter(item => item.title);

      postResponse(this.webview, msg.id, { items: enriched });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'AI triage failed');
    }
  }

  private async handleReviewContextFiles(msg: RequestMessage): Promise<void> {
    if (!this.analyzer) {
      postError(this.webview, msg.id, 'Analyzer not ready.');
      return;
    }

    try {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const maxCount = typeof params.count === 'number' ? Math.min(Math.max(1, params.count), 20) : 5;
      const workspaceIds = Array.isArray(params.workspaceIds) ? (params.workspaceIds as string[]).slice(0, maxCount) : [];
      if (workspaceIds.length === 0) {
        postError(this.webview, msg.id, 'No workspaces specified.');
        return;
      }

      const payloads = this.analyzer.getContextReviewPayload(workspaceIds);
      postEvent(this.webview, 'reviewProgress', { phase: 'start', workspaces: payloads.map(payload => ({ id: payload.workspaceId, name: payload.workspaceName })) });
      if (payloads.length === 0) {
        postError(this.webview, msg.id, 'Could not resolve workspace roots.');
        return;
      }

      const categories = ['clarity', 'specificity', 'structure', 'completeness', 'staleness', 'redundancy', 'actionability'];
      const systemPrompt = `You are an expert at evaluating AI coding assistant context files (instruction files, CLAUDE.md, copilot-instructions.md, .prompt.md, agent definitions, skills, etc.).

You will receive workspace data including:
- The file tree structure (top 2 levels)
- README or project description
- Package/project config
- All context/instruction files with their contents

Your job is to evaluate how well the context files prepare AI coding agents to work effectively in this project.

EVALUATION CATEGORIES (score each 0-100):
1. **clarity**: Is the intent clear? Can an AI agent understand what this project is and how to contribute?
2. **specificity**: Are constraints, tech stack, coding standards, naming conventions, and architecture explicitly defined?
3. **structure**: Are files well-organized with headings, sections, and logical ordering? Is YAML frontmatter correct?
4. **completeness**: Are typical sections present? (project overview, conventions, testing strategy, deployment, dependency management, error handling patterns)
5. **staleness**: Are there references to deprecated tools, outdated patterns, or missing coverage for current project features?
6. **redundancy**: Is there duplicated or conflicting information across files?
7. **actionability**: Can the AI ACT on the instructions, or are they too vague/aspirational?

For each workspace, produce findings and scores.

Respond with a JSON object: {"items":[{
  "workspaceId": "...",
  "overallScore": 0-100,
  "categoryScores": { "clarity": 0-100, "specificity": 0-100, "structure": 0-100, "completeness": 0-100, "staleness": 0-100, "redundancy": 0-100, "actionability": 0-100 },
  "findings": [
    { "category": "...", "severity": "good|warning|critical", "file": "path.md", "finding": "what", "suggestion": "how" }
  ],
  "missingFiles": [
    { "filename": "...", "reason": "...", "impact": "high|medium|low" }
  ],
  "summary": "1-2 sentence assessment"
}]}

IMPORTANT: Keep the response concise. Maximum 4-5 findings per workspace. Short sentences. This ensures complete JSON output.
Guidelines:
- A = 80-100, B = 65-79, C = 50-64, D = 35-49, F = 0-34
- Include 3-5 findings per workspace (mix of good + issues)
- For workspaces with NO context files, grade F and suggest what to create
- Reference specific file names and line-level issues when possible
- Consider the PROJECT TYPE when evaluating (a simple CLI needs less context than a microservice)`;

      const workspaceData = payloads.map(payload => {
        const contextSection = payload.contextFiles.length > 0
          ? payload.contextFiles.map(file => {
            const content = file.content || '(empty)';
            const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(truncated)' : content;
            return `--- ${file.path} (${file.lines} lines) ---\n${truncated}`;
          }).join('\n\n')
          : '(No context files found)';

        return `
=== Workspace: ${payload.workspaceName} (id: ${payload.workspaceId}, harness: ${payload.harness}) ===

File tree:
${payload.fileTree || '(not available)'}

${payload.readmeSnippet ? `README:\n${payload.readmeSnippet}\n` : ''}${payload.packageSnippet ? `Project config:\n${payload.packageSnippet}\n` : ''}Context files:
${contextSection}`;
      }).join('\n\n');

      const userPrompt = `Review these ${payloads.length} workspace(s):\n${workspaceData}`;
      const response = await callLlmJson<{ items: Array<Record<string, unknown>> }>([
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ], SCHEMA_CONTEXT_REVIEW);
      const rawItems = Array.isArray(response) ? response as unknown as typeof response['items'] : response.items ?? [];
      const validCategories = new Set(categories);

      const results = rawItems.map(item => {
        const categoryScoresRaw = (item.categoryScores || {}) as Record<string, number>;
        const categoryScores: Record<string, number> = {};
        for (const category of categories) {
          categoryScores[category] = typeof categoryScoresRaw[category] === 'number'
            ? Math.min(100, Math.max(0, categoryScoresRaw[category]))
            : 0;
        }

        const findings = Array.isArray(item.findings)
          ? (item.findings as Array<Record<string, unknown>>).map(finding => {
            const category = toText(finding.category);
            const severity = toText(finding.severity);
            return {
              category: validCategories.has(category) ? category : 'clarity',
              severity: ['good', 'warning', 'critical'].includes(severity) ? severity : 'warning',
              file: toText(finding.file),
              finding: toText(finding.finding),
              suggestion: toText(finding.suggestion),
            };
          })
          : [];

        const workspaceId = toText(item.workspaceId);
        const workspace = payloads.find(payload => payload.workspaceId === workspaceId);
        const overallGrade = toText(item.overallGrade);
        return {
          workspaceId,
          workspaceName: workspace?.workspaceName || workspaceId,
          overallGrade: ['A', 'B', 'C', 'D', 'F'].includes(overallGrade) ? overallGrade : 'C',
          overallScore: typeof item.overallScore === 'number' ? Math.min(100, Math.max(0, item.overallScore)) : 0,
          categoryScores,
          findings,
          summary: toText(item.summary),
        };
      });

      postResponse(this.webview, msg.id, { reviews: results });
    } catch (error: unknown) {
      postError(this.webview, msg.id, error instanceof Error ? error.message : 'AI review failed');
    }
  }

  private getUserContext(): { languages: string[]; harnesses: string[]; topics: string[]; workspaces: string[] } {
    if (!this.parseResult) {
      return { languages: [], harnesses: [], topics: [], workspaces: [] };
    }

    const sessions = this.parseResult.sessions;
    const langCounts = new Map<string, number>();
    for (const session of sessions) {
      for (const request of session.requests) {
        for (const block of [...request.aiCode, ...request.userCode]) {
          if (block.language && block.language !== 'unknown' && block.language !== 'text') {
            langCounts.set(block.language, (langCounts.get(block.language) || 0) + block.loc);
          }
        }
      }
    }

    const languages = Array.from(langCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(entry => entry[0]);
    const harnesses = Array.from(new Set(sessions.map(session => session.harness))).filter(Boolean);
    const workspaces = Array.from(new Set(sessions.map(session => session.workspaceName))).filter(Boolean).slice(0, 10);

    const topicCounts = new Map<string, number>();
    const topicKeywords = [
      'test', 'deploy', 'docker', 'kubernetes', 'ci', 'cd', 'api', 'auth', 'database',
      'migration', 'refactor', 'debug', 'security', 'performance', 'accessibility',
      'react', 'vue', 'angular', 'node', 'python', 'rust', 'go', 'java', 'swift',
      'terraform', 'bicep', 'azure', 'aws', 'gcp', 'nextjs', 'django', 'flask',
      'express', 'fastapi', 'graphql', 'rest', 'grpc', 'mongodb', 'postgres', 'redis',
      'webpack', 'vite', 'eslint', 'prettier', '.net', 'csharp', 'blazor',
    ];
    for (const session of sessions) {
      for (const request of session.requests) {
        const lower = request.messageText.toLowerCase();
        for (const keyword of topicKeywords) {
          if (lower.includes(keyword)) {
            topicCounts.set(keyword, (topicCounts.get(keyword) || 0) + 1);
          }
        }
      }
    }

    const topics = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(entry => entry[0]);

    return { languages, harnesses, topics, workspaces };
  }

  private resolveWorkspaceRoot(workspace: Workspace): string | null {
    const wsJson = path.join(workspace.path, 'workspace.json');
    try {
      const data = readJsonRecord(wsJson);
      if (data) {
        const raw = isString(data.folder) ? data.folder : isString(data.workspace) ? data.workspace : '';
        const decoded = fileUriToPath(raw).replace(/\/+$/, '');
        if (decoded && fs.existsSync(decoded)) return decoded;
      }
    } catch {
      // Ignore and fall through.
    }

    const wsYaml = path.join(workspace.path, 'workspace.yaml');
    try {
      const yamlText = fs.readFileSync(wsYaml, 'utf-8');
      const folderMatch = yamlText.match(/folder:\s*['"]?([^'"\n]+)/);
      if (folderMatch) {
        const decoded = fileUriToPath(folderMatch[1]).replace(/\/+$/, '');
        if (fs.existsSync(decoded)) return decoded;
      }
    } catch {
      // Ignore and fall through.
    }

    if (fs.existsSync(path.join(workspace.path, 'package.json'))) {
      return workspace.path;
    }

    return null;
  }

  private resolveWorkspaceRoots(): Array<{ workspaceId: string; workspaceName: string; rootPath: string }> {
    if (!this.parseResult) return [];

    const roots: Array<{ workspaceId: string; workspaceName: string; rootPath: string }> = [];
    for (const [, workspace] of this.parseResult.workspaces) {
      const rootPath = this.resolveWorkspaceRoot(workspace);
      if (rootPath) {
        roots.push({ workspaceId: workspace.id, workspaceName: workspace.name, rootPath });
      }
    }
    return roots;
  }

  private hasFile(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  private readDirectoryEntries(dirPath: string, include: (entry: string) => boolean, mapEntry: (entry: string) => string = entry => entry): string[] {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
      return fs.readdirSync(dirPath).filter(include).map(mapEntry);
    } catch {
      return [];
    }
  }

  private getGitHubRemote(rootPath: string): string | null {
    try {
      const configPath = path.join(rootPath, '.git', 'config');
      const gitConfig = fs.readFileSync(configPath, 'utf-8');
      const remoteMatch = gitConfig.match(/url\s*=\s*(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s.]+)/);
      return remoteMatch ? remoteMatch[1].replace(/\.git$/, '') : null;
    } catch {
      return null;
    }
  }

  private getRepoContextFiles(rootPath: string): string[] {
    const contextFiles = this.readDirectoryEntries(
      path.join(rootPath, '.github', 'agents'),
      entry => entry.endsWith('.yml') || entry.endsWith('.yaml') || entry.endsWith('.md'),
      entry => `agents/${entry}`,
    );

    if (this.hasFile(path.join(rootPath, '.github', 'copilot-setup-steps.yml'))) {
      contextFiles.push('copilot-setup-steps.yml');
    }
    if (this.hasFile(path.join(rootPath, '.github', 'copilot-instructions.md'))) {
      contextFiles.push('copilot-instructions.md');
    }

    return contextFiles;
  }

  private getRepoWorkflows(rootPath: string): string[] {
    return this.readDirectoryEntries(
      path.join(rootPath, '.github', 'workflows'),
      entry => entry.endsWith('.yml') || entry.endsWith('.yaml'),
    );
  }

  private getRepoAgenticWorkflows(rootPath: string): string[] {
    return this.readDirectoryEntries(
      path.join(rootPath, '.github', 'aw'),
      entry => entry.endsWith('.yml') || entry.endsWith('.yaml') || entry.endsWith('.md'),
    );
  }

  private scanWorkspaceRepo(workspace: { workspaceName: string; rootPath: string }): {
    workspace: string;
    remote: string | null;
    contextFiles: string[];
    workflows: string[];
    agenticWorkflows: string[];
  } {
    return {
      workspace: workspace.workspaceName,
      remote: this.getGitHubRemote(workspace.rootPath),
      contextFiles: this.getRepoContextFiles(workspace.rootPath),
      workflows: this.getRepoWorkflows(workspace.rootPath),
      agenticWorkflows: this.getRepoAgenticWorkflows(workspace.rootPath),
    };
  }

  private async getGitHubAccessToken(requestAuth: boolean): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo', 'read:org'], { createIfNone: requestAuth });
      return session?.accessToken;
    } catch {
      return undefined;
    }
  }

  private isCopilotLogin(login: string | undefined): boolean {
    return login?.toLowerCase()?.includes('copilot') === true ||
      login === 'github-actions[bot]' ||
      login?.startsWith('copilot-swe-agent') === true;
  }

  private async fetchCopilotPrStats(owner: string, repo: string, headers: Record<string, string>): Promise<{
    total: number;
    assignedToCopilot: number;
    reviewedByCopilot: number;
  }> {
    const stats = { total: 0, assignedToCopilot: 0, reviewedByCopilot: 0 };
    try {
      const prResponse = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=50&sort=updated&direction=desc`,
        { headers },
      );
      if (!prResponse.ok) return stats;

      const prs = await prResponse.json() as Array<{
        user?: { login?: string };
        assignees?: Array<{ login?: string }>;
        requested_reviewers?: Array<{ login?: string }>;
      }>;
      stats.total = prs.length;
      for (const pr of prs) {
        const isCopilotAuthor = this.isCopilotLogin(pr.user?.login);
        const isCopilotAssignee = pr.assignees?.some(assignee => this.isCopilotLogin(assignee.login)) === true;
        if (isCopilotAuthor || isCopilotAssignee) stats.assignedToCopilot++;

        const isCopilotReviewer = pr.requested_reviewers?.some(reviewer => this.isCopilotLogin(reviewer.login)) === true;
        if (isCopilotReviewer) stats.reviewedByCopilot++;
      }
    } catch {
      // Ignore GitHub API failures.
    }
    return stats;
  }

  private async fetchGitHubCount(url: string, headers: Record<string, string>): Promise<number | null> {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) return null;
      const data = await response.json() as { total_count?: number } | Array<unknown>;
      if (Array.isArray(data)) return data.length;
      return isRecord(data) && isNumber(data.total_count) ? data.total_count : 0;
    } catch {
      return null;
    }
  }

  private async fetchCollaboratorStats(owner: string, repo: string, headers: Record<string, string>): Promise<Array<{ total: number; withCopilot: number }>> {
    try {
      const collabResponse = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators?per_page=100`,
        { headers },
      );
      if (!collabResponse.ok) return [];
      const collaborators = await collabResponse.json() as Array<{ login?: string }>;
      return [{ total: collaborators.length, withCopilot: 0 }];
    } catch {
      return [];
    }
  }

  private handleGetSdlcToolAnalysis(msg: RequestMessage): void {
    if (!this.parseResult) {
      postResponse(this.webview, msg.id, { mcpServers: [], toolCounts: {} });
      return;
    }

    const sdlcServerMap: Record<string, { label: string; category: string }> = {
      'github': { label: 'GitHub', category: 'Source Control' },
      'atlassian': { label: 'Atlassian (Jira/Confluence)', category: 'Project Management' },
      'jira': { label: 'Jira', category: 'Project Management' },
      'azure-devops': { label: 'Azure DevOps', category: 'DevOps' },
      'azuredevops': { label: 'Azure DevOps', category: 'DevOps' },
      'azure_mcp': { label: 'Azure', category: 'Cloud' },
      'linear': { label: 'Linear', category: 'Project Management' },
      'slack': { label: 'Slack', category: 'Communication' },
      'sentry': { label: 'Sentry', category: 'Error Tracking' },
      'datadog': { label: 'Datadog', category: 'Monitoring' },
      'playwright': { label: 'Playwright', category: 'Testing' },
      'docker': { label: 'Docker', category: 'Containers' },
      'kubernetes': { label: 'Kubernetes', category: 'Containers' },
      'postgres': { label: 'PostgreSQL', category: 'Database' },
      'mysql': { label: 'MySQL', category: 'Database' },
      'supabase': { label: 'Supabase', category: 'Backend' },
      'vercel': { label: 'Vercel', category: 'Deployment' },
      'netlify': { label: 'Netlify', category: 'Deployment' },
      'figma': { label: 'Figma', category: 'Design' },
      'notion': { label: 'Notion', category: 'Documentation' },
      'confluence': { label: 'Confluence', category: 'Documentation' },
      'grafana': { label: 'Grafana', category: 'Monitoring' },
      'pagerduty': { label: 'PagerDuty', category: 'Incident Management' },
      'snyk': { label: 'Snyk', category: 'Security' },
      'sonarqube': { label: 'SonarQube', category: 'Code Quality' },
      'circleci': { label: 'CircleCI', category: 'CI/CD' },
      'jenkins': { label: 'Jenkins', category: 'CI/CD' },
      'terraform': { label: 'Terraform', category: 'Infrastructure' },
      'pulumi': { label: 'Pulumi', category: 'Infrastructure' },
      'mslearnmcp': { label: 'Microsoft Learn', category: 'Documentation' },
    };

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const filter = params.filter ? validateDateFilter(params.filter as Record<string, unknown>) : undefined;

    const mcpServerCounts = new Map<string, number>();
    const filteredSessions = this.parseResult.sessions.filter(session => {
      if (!this.matchesWorkspace(session, filter?.workspaceId)) return false;
      if (filter?.harness && session.harness !== filter.harness) return false;
      return true;
    });

    for (const session of filteredSessions) {
      for (const request of session.requests) {
        for (const tool of request.toolsUsed) {
          if (!tool.startsWith('mcp_')) continue;
          const rest = tool.slice(4);
          const underscoreIdx = rest.indexOf('_');
          const serverId = underscoreIdx > 0 ? rest.slice(0, underscoreIdx) : rest;
          mcpServerCounts.set(serverId, (mcpServerCounts.get(serverId) || 0) + 1);
        }
      }
    }

    const mcpServers = Array.from(mcpServerCounts.entries()).map(([serverId, toolCalls]) => {
      const info = sdlcServerMap[serverId];
      return {
        id: serverId,
        label: info?.label || serverId,
        category: info?.category || 'Other',
        toolCalls,
        isSdlcRelevant: !!info,
      };
    }).sort((a, b) => b.toolCalls - a.toolCalls);

    postResponse(this.webview, msg.id, { mcpServers });
  }

  private handleGetSdlcRepoScan(msg: RequestMessage): void {
    const roots = this.resolveWorkspaceRoots();
    const wsActivity = new Map<string, number>();
    if (this.parseResult) {
      for (const session of this.parseResult.sessions) {
        const existing = wsActivity.get(session.workspaceId) || 0;
        const ts = session.lastMessageDate || session.creationDate || 0;
        if (ts > existing) wsActivity.set(session.workspaceId, ts);
      }
    }

    const sortedRoots = roots.sort((a, b) => (wsActivity.get(b.workspaceId) || 0) - (wsActivity.get(a.workspaceId) || 0));
    const repos = sortedRoots.map(workspace => this.scanWorkspaceRepo(workspace));
    postResponse(this.webview, msg.id, { repos });
  }

  private async handleGetSdlcGitHubData(msg: RequestMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const owner = isString(params.owner) ? params.owner : '';
    const repo = isString(params.repo) ? params.repo : '';
    if (!owner || !repo) {
      postError(this.webview, msg.id, 'Missing owner/repo');
      return;
    }

    const token = await this.getGitHubAccessToken(params.requestAuth === true);
    if (!token) {
      postResponse(this.webview, msg.id, {
        authRequired: true,
        error: 'GitHub authentication required. Sign in to see PR and agent data.',
      });
      return;
    }

    if (owner === '_auth_') {
      postResponse(this.webview, msg.id, { authRequired: false });
      return;
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const previewHeaders: Record<string, string> = {
      ...headers,
      'X-GitHub-Api-Version': '2026-03-10',
    };

    const results = {
      copilotPrs: await this.fetchCopilotPrStats(owner, repo, headers),
      codingAgentRuns: await this.fetchGitHubCount(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/copilot/coding-agent/runs?per_page=100`,
        previewHeaders,
      ),
      agentTasks: await this.fetchGitHubCount(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/agent-tasks?per_page=100`,
        previewHeaders,
      ),
      collaborators: await this.fetchCollaboratorStats(owner, repo, headers),
    };

    postResponse(this.webview, msg.id, results);
  }
}
