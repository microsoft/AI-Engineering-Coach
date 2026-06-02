/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* SDLC Section -- Agentic SDLC tracking, MCP servers, GitHub APIs, workflow detection */

import { DateFilter, WorkType, WORK_TYPES, WORK_TYPE_COLORS } from '../core/types';
import { rpc, COLORS } from './shared';
import { html, render, LoadingScreen, type ComponentChildren } from './render';
import { SVG } from './svg-icons';

/* ── Types ────────────────────────────────────────────────────────── */

interface McpServer {
  id: string;
  label: string;
  category: string;
  toolCalls: number;
  isSdlcRelevant: boolean;
}

interface RepoScan {
  workspace: string;
  remote: string | null;
  contextFiles: string[];
  workflows: string[];
  agenticWorkflows: string[];
}



/* ── Helpers ──────────────────────────────────────────────────────── */

function classifyWorkType(msg: string): WorkType {
  const patterns: [RegExp, WorkType][] = [
    [/\b(fix|bug|error|issue|crash|exception|debug|problem|broken|fail|wrong)\b/i, 'bug fix'],
    [/\b(refactor|rename|extract|move|cleanup|simplify|restructure|reorganize)\b/i, 'refactor'],
    [/\b(review|pr|pull request|code review|comment on|feedback|approve)\b/i, 'code review'],
    [/\b(test|spec|expect|assert|mock|stub|coverage|vitest|jest|pytest|unittest)\b/i, 'test'],
    [/\b(doc|readme|comment|explain|jsdoc|typedoc|docstring|swagger|openapi)\b/i, 'docs'],
    [/\b(style|css|scss|sass|theme|layout|padding|margin|font|color|design|ui)\b/i, 'style'],
    [/\b(config|setup|install|dependency|package|ci|cd|pipeline|deploy|docker|k8s|terraform|bicep|env|yaml|yml)\b/i, 'config'],
    [/\b(add|create|implement|build|feature|new|scaffold|generate|develop)\b/i, 'feature'],
  ];
  for (const [re, wt] of patterns) { if (re.test(msg)) return wt; }
  return 'other';
}

function getDiversityBonus(diverse: number): number {
  if (diverse >= 5) return 10;
  if (diverse >= 3) return 5;
  return 0;
}

function getMcpBonus(mcpCount: number): number {
  if (mcpCount >= 3) return 15;
  if (mcpCount >= 1) return 10;
  return 0;
}

function getPhaseScore(dist: Record<WorkType, number>, total: number, mcpCount: number, hasAw: boolean, hasWorkflows: boolean, hasContext: boolean): { label: string; score: number; color: string } {
  if (total === 0) return { label: 'No data', score: 0, color: COLORS.muted };
  const reviewBonus = (dist['code review'] ?? 0) > 0 ? 15 : 0;
  const testBonus = (dist['test'] ?? 0) > 0 ? 15 : 0;
  const docsBonus = (dist['docs'] ?? 0) > 0 ? 10 : 0;
  const configBonus = (dist['config'] ?? 0) > 0 ? 10 : 0;
  const diverse = Object.values(dist).filter(v => v > 0).length;
  const score = reviewBonus
    + testBonus
    + docsBonus
    + configBonus
    + getDiversityBonus(diverse)
    + getMcpBonus(mcpCount)
    + (hasAw ? 15 : 0)
    + (hasWorkflows ? 10 : 0)
    + (hasContext ? 10 : 0);
  const color = score >= 70 ? COLORS.green : score >= 40 ? COLORS.yellow : COLORS.red;
  const label = score >= 70 ? 'Excellent' : score >= 40 ? 'Good' : 'Needs Improvement';
  return { label, score, color };
}

/* ── Render ───────────────────────────────────────────────────────── */

export async function renderSdlc(container: HTMLElement, filter: DateFilter): Promise<void> {
  render(html`<${LoadingScreen} message="Analyzing SDLC patterns..." />`, container);

  // Parallel data fetching
  const [sessions, toolAnalysis, repoScan] = await Promise.all([
    rpc<{ total: number; sessions: { sessionId: string; workspaceName: string; requestCount: number; firstMessage: string; creationDate: number | null; lastMessageDate: number | null }[] }>('getSessions', { page: 1, pageSize: 500, filter: filter as Record<string, unknown> }),
    rpc<{ mcpServers: McpServer[] }>('getSdlcToolAnalysis', { filter: filter as Record<string, unknown> }),
    rpc<{ repos: RepoScan[] }>('getSdlcRepoScan', {}),
  ]);

  // Classify work types from session first messages
  const workTypeDistribution: Record<WorkType, number> = {} as Record<WorkType, number>;
  for (const wt of WORK_TYPES) workTypeDistribution[wt] = 0;

  for (const s of sessions.sessions) {
    if (!s.firstMessage) continue;
    const wt = classifyWorkType(s.firstMessage);
    workTypeDistribution[wt]++;
  }
  const classifiedTotal = Object.values(workTypeDistribution).reduce((a, b) => a + b, 0);

  // MCP server analysis — only show SDLC-relevant servers
  const mcpServers = (toolAnalysis.mcpServers || []).filter(s => s.isSdlcRelevant);

  // Repo scan results — top 20, repos with agentic workflows first, then most recently active
  const allRepos = repoScan.repos || [];
  const reposWithAw = allRepos.filter(r => r.agenticWorkflows.length > 0);
  const reposWithoutAw = allRepos.filter(r => r.agenticWorkflows.length === 0);
  const repos = [...reposWithAw, ...reposWithoutAw].slice(0, 20);

  // Aggregate counts
  const awCount = allRepos.filter(r => r.agenticWorkflows.length > 0).length;
  const wfCount = allRepos.filter(r => r.workflows.length > 0).length;
  const ctxCount = allRepos.filter(r => r.contextFiles.length > 0).length;

  const finalScore = getPhaseScore(
    workTypeDistribution, sessions.total, mcpServers.length,
    awCount > 0, wfCount > 0, ctxCount > 0
  );

  const recs = generateRecommendations(workTypeDistribution, classifiedTotal, mcpServers, awCount, wfCount, ctxCount);

  render(html`
    <div class="sdlc-page">
      <!-- Header -->
      <div class="sdlc-hero">
        <div class="sdlc-hero-left">
          <div class="sdlc-hero-icon">${SVG.refresh}</div>
          <div>
            <h2 class="sdlc-hero-title">Agentic SDLC</h2>
            <p class="sdlc-hero-sub">How well are you using AI agents across the software development lifecycle?</p>
          </div>
        </div>
        <div class="sdlc-hero-right">
          <div class="sdlc-score-ring" style=${'--score:' + finalScore.score + ';--score-color:' + finalScore.color}>
            <div class="sdlc-score-val">${finalScore.score}</div>
          </div>
          <div class="sdlc-score-label">${finalScore.label}</div>
        </div>
      </div>

      <!-- Stats row -->
      <div class="sdlc-stats">
        <div class="sdlc-stat"><div class="sdlc-stat-val">${sessions.total}</div><div class="sdlc-stat-lbl">Total Sessions</div></div>
        <div class="sdlc-stat"><div class="sdlc-stat-val" style=${'color:' + COLORS.blue}>${mcpServers.length}</div><div class="sdlc-stat-lbl">MCP Servers</div></div>
        <div class="sdlc-stat"><div class="sdlc-stat-val" style=${'color:' + COLORS.green}>${awCount}</div><div class="sdlc-stat-lbl">Agentic Workflows</div></div>
        <div class="sdlc-stat"><div class="sdlc-stat-val" style=${'color:' + COLORS.blue}>${wfCount}</div><div class="sdlc-stat-lbl">CI/CD Workflows</div></div>
        <div class="sdlc-stat"><div class="sdlc-stat-val" style=${'color:' + COLORS.purple}>${ctxCount}</div><div class="sdlc-stat-lbl">Context Configs</div></div>
      </div>

      <div class="sdlc-columns">
        <!-- Main content -->
        <div class="sdlc-main">
          <!-- MCP Server Integration -->
          <div class="sdlc-section">
            <h3 class="sdlc-section-title">${SVG.globe} MCP Server Integration</h3>
            ${mcpServers.length === 0
              ? html`<div class="sdlc-empty">No SDLC MCP servers detected in your sessions. Add tools like GitHub, Atlassian, or Azure DevOps MCP servers to your setup.</div>`
              : html`<div class="sdlc-mcp-grid">
                  ${mcpServers.map(s => html`
                    <div class="sdlc-mcp-card sdlc-mcp-relevant">
                      <div class="sdlc-mcp-top">
                        <span class="sdlc-mcp-name">${s.label}</span>
                        <span class="sdlc-mcp-badge">${s.category}</span>
                      </div>
                      <div class="sdlc-mcp-calls">${s.toolCalls} tool calls</div>
                    </div>`)}
                </div>`
            }
          </div>

          <!-- Work Type Distribution -->
          <div class="sdlc-section">
            <h3 class="sdlc-section-title">${SVG.barChart} Work Type Distribution</h3>
            <div class="sdlc-phase-grid">
              ${WORK_TYPES.filter(wt => wt !== 'other').map(wt => {
                const count = workTypeDistribution[wt];
                const pct = classifiedTotal > 0 ? (count / classifiedTotal * 100) : 0;
                return html`
                <div class="sdlc-phase-card">
                  <div class="sdlc-phase-top">
                    <span class="sdlc-phase-dot" style=${'background:' + WORK_TYPE_COLORS[wt]}></span>
                    <span class="sdlc-phase-name">${wt}</span>
                    <span class="sdlc-phase-count">${count}</span>
                  </div>
                  <div class="sdlc-phase-bar">
                    <div class="sdlc-phase-bar-fill" style=${'width:' + pct + '%;background:' + WORK_TYPE_COLORS[wt]}></div>
                  </div>
                  <div class="sdlc-phase-pct">${pct.toFixed(1)}%</div>
                </div>`;
              })}
            </div>
          </div>
        </div>

        <!-- Sidebar -->
        <div class="sdlc-sidebar">
          <!-- GitHub Config per Repo -->
          <div class="sdlc-section">
            <h3 class="sdlc-section-title">${SVG.robot} GitHub Configuration</h3>
            ${repos.length === 0
              ? html`<div class="sdlc-empty">No workspace repos resolved. Open projects in VS Code to scan.</div>`
              : html`<div class="sdlc-ghaw-list">
                  ${repos.map(r => {
                    const hasAny = r.agenticWorkflows.length > 0 || r.workflows.length > 0 || r.contextFiles.length > 0;
                    return html`
                    <div class=${'sdlc-ghaw-item' + (hasAny ? ' sdlc-ghaw-active' : '')}>
                      <div class="sdlc-ghaw-info">
                        <div class="sdlc-ghaw-name">${r.workspace}</div>
                        ${r.agenticWorkflows.length > 0 && html`<div class="sdlc-ghaw-detail sdlc-ghaw-aw">${SVG.bolt} <strong>Agentic Workflows</strong> (.github/aw): ${r.agenticWorkflows.join(', ')}</div>`}
                        ${r.workflows.length > 0 && html`<div class="sdlc-ghaw-detail sdlc-ghaw-wf">${SVG.gear} <strong>Workflows</strong> (.github/workflows): ${r.workflows.join(', ')}</div>`}
                        ${r.contextFiles.length > 0 && html`<div class="sdlc-ghaw-detail sdlc-ghaw-ctx">${SVG.pencilDoc} <strong>Context Files</strong>: ${r.contextFiles.join(', ')}</div>`}
                        ${!hasAny && html`<div class="sdlc-ghaw-detail">No .github/ config found</div>`}
                      </div>
                    </div>`;
                  })}
                </div>`
            }
          </div>

          <!-- Recommendations -->
          <div class="sdlc-section">
            <h3 class="sdlc-section-title">${SVG.lightbulb} Recommendations</h3>
            <div class="sdlc-rec-list">
              ${recs.map(r => html`
                <div class="sdlc-rec-item">
                  <span class="sdlc-rec-icon">${r.icon}</span>
                  <div>
                    <div class="sdlc-rec-title">${r.title}</div>
                    <div class="sdlc-rec-desc">${r.description}</div>
                  </div>
                </div>`)}
            </div>
          </div>
        </div>
      </div>
    </div>
  `, container);
}

/* ── Recommendations ──────────────────────────────────────────────── */

function generateRecommendations(
  dist: Record<WorkType, number>, total: number,
  mcpServers: McpServer[], awCount: number, wfCount: number, ctxCount: number,
): { icon: ComponentChildren; title: string; description: string }[] {
  const recs: { icon: ComponentChildren; title: string; description: string }[] = [];
  if (total === 0) return [{ icon: SVG.lightbulb, title: 'Start using AI', description: 'Begin using an AI coding assistant to see SDLC insights.' }];

  const reviewPct = (dist['code review'] ?? 0) / total * 100;
  if (reviewPct < 5) {
    recs.push({ icon: SVG.warning, title: 'Add AI Reviews', description: 'Less than 5% of sessions involve code review. Use your AI agent as a reviewer for PRs.' });
  }

  const testPct = (dist['test'] ?? 0) / total * 100;
  if (testPct < 10) {
    recs.push({ icon: SVG.warning, title: 'More AI Testing', description: 'Low test session ratio. Ask your AI assistant to write tests alongside features.' });
  }

  if (mcpServers.length === 0) {
    recs.push({ icon: SVG.globe, title: 'Add SDLC MCP Servers', description: 'Connect GitHub, Atlassian, or Azure DevOps MCP servers for deeper integration.' });
  }

  if (awCount === 0) {
    recs.push({ icon: SVG.bolt, title: 'Enable Agentic Workflows', description: 'Set up Agentic Workflows in .github/aw/ for automated agent-driven tasks.' });
  }

  if (ctxCount === 0) {
    recs.push({ icon: SVG.pencilDoc, title: 'Add Context Files', description: 'Create instruction files (e.g. .github/agents/ or CLAUDE.md) to give your AI project-specific guidance.' });
  }

  if (wfCount === 0) {
    recs.push({ icon: SVG.gear, title: 'Add CI/CD Workflows', description: 'Set up GitHub Actions in .github/workflows/ for automated testing and deployment.' });
  }

  if (recs.length === 0) {
    recs.push({ icon: SVG.checkCircle, title: 'Well-integrated SDLC', description: 'You are using AI agents across multiple phases with MCP integration. Keep it up!' });
  }

  return recs.slice(0, 5);
}
