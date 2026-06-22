/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Recommendations + anti-pattern detection analytics */

import { Session, SessionRequest, DateFilter, RecommendationResult, AntiPatternData, PracticeGroup, GroupScore, ProjectOverviewData, ProjectOverviewItem } from './types';
import { toDateStr, normalizeModel, modelMultiplier } from './helpers';
import { LONG_SESSION_REQS } from './constants';
import { AnalyzerBase } from './analyzer-base';
import {
  computeWeeklyTrend, computeWeeklyScores,
} from './detectors';
import { getDetectorGroupCounts, runDetectors } from './detector-registry';

function scoreToStatus(score: number): 'good' | 'needs-improvement' | 'critical' {
  return score >= 70 ? 'good' : score >= 40 ? 'needs-improvement' : 'critical';
}

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  cs: 'c#', cpp: 'c++', c: 'c', h: 'c', hpp: 'c++', swift: 'swift',
  kt: 'kotlin', scala: 'scala', php: 'php', dart: 'dart', lua: 'lua',
  r: 'r', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte',
  md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  tf: 'terraform', bicep: 'bicep', dockerfile: 'docker',
};

function extToLang(ext: string): string | null {
  return EXT_LANG_MAP[ext] || null;
}

export class PatternsAnalyzer extends AnalyzerBase {

  getRecommendations(f?: DateFilter): RecommendationResult[] {
    const reqs = this.filter(f);
    const sessions = this.filteredSessions(f);
    if (reqs.length === 0) return [];

    return [
      this.checkModelDiversity(reqs),
      this.checkModelTaskAlignment(reqs),
      this.checkPlanningUsage(reqs),
      this.checkSessionLengthHygiene(sessions),
      this.checkSlashCommandAdoption(reqs),
      this.checkFeatureBreadth(reqs),
      this.checkParallelism(sessions),
      this.checkCancellationRate(reqs),
      this.checkToolDiversity(reqs),
      this.checkResponseEfficiency(reqs),
      this.checkFileContextUsage(reqs),
      this.checkSessionSizeDistribution(sessions),
    ];
  }

  private checkModelDiversity(reqs: SessionRequest[]): RecommendationResult {
    const models = new Set(reqs.map(r => normalizeModel(r.modelId || '')).filter(Boolean));
    const count = models.size;
    const score = count >= 4 ? 100 : count >= 3 ? 80 : count >= 2 ? 50 : 20;
    return {
      checkId: 'model-switch', name: 'Model Diversity', category: 'Efficiency',
      score, status: scoreToStatus(score),
      finding: `Using ${count} model(s): ${Array.from(models).join(', ')}`,
      recommendation: count < 3 ? 'Try lighter models (gpt-4.1-mini, gemini-flash) for simple tasks to save premium requests.' : 'Good model diversity.',
    };
  }

  private checkModelTaskAlignment(reqs: SessionRequest[]): RecommendationResult {
    let aligned = 0, total = 0;
    for (const r of reqs) {
      if (!r.modelId) continue;
      total++;
      const model = normalizeModel(r.modelId);
      const isHeavy = modelMultiplier(model) >= 1;
      const isSimple = r.messageLength < 100 && r.aiCode.length === 0;
      if (isSimple && !isHeavy) aligned++;
      else if (!isSimple) aligned++;
    }
    const score = total > 0 ? Math.round((aligned / total) * 100) : 50;
    return {
      checkId: 'model-task-align', name: 'Model-Task Alignment', category: 'Efficiency',
      score, status: scoreToStatus(score),
      finding: `${aligned}/${total} requests use an appropriately-sized model for the task.`,
      recommendation: score < 70 ? 'Use lightweight models for simple questions and heavy models for complex coding tasks.' : 'Good alignment between model size and task complexity.',
    };
  }

  private checkPlanningUsage(reqs: SessionRequest[]): RecommendationResult {
    const planningReqs = reqs.filter(r =>
      r.agentMode.includes('plan') ||
      r.messageText.toLowerCase().includes('plan') ||
      r.slashCommand === 'plan'
    );
    const ratio = reqs.length > 0 ? planningReqs.length / reqs.length : 0;
    const score = ratio > 0.1 ? 100 : ratio > 0.05 ? 70 : ratio > 0 ? 40 : 10;
    return {
      checkId: 'planning-mode', name: 'Planning-First Usage', category: 'Strategy',
      score, status: scoreToStatus(score),
      finding: `${planningReqs.length} of ${reqs.length} requests involve planning (${(ratio * 100).toFixed(1)}%).`,
      recommendation: score < 70 ? 'Use planning mode before large tasks to help Copilot understand the big picture.' : 'Good use of planning.',
    };
  }

  private checkSessionLengthHygiene(sessions: Session[]): RecommendationResult {
    const longSessions = sessions.filter(s => s.requestCount > LONG_SESSION_REQS);
    const ratio = sessions.length > 0 ? longSessions.length / sessions.length : 0;
    const score = ratio < 0.1 ? 100 : ratio < 0.3 ? 60 : 20;
    return {
      checkId: 'context-flush', name: 'Session Length Hygiene', category: 'Context',
      score, status: scoreToStatus(score),
      finding: `${longSessions.length} of ${sessions.length} sessions exceed ${LONG_SESSION_REQS} requests.`,
      recommendation: score < 70 ? 'Start new sessions periodically to avoid context window pollution. Long sessions degrade response quality.' : 'Good session hygiene.',
    };
  }

  private checkSlashCommandAdoption(reqs: SessionRequest[]): RecommendationResult {
    const withSlash = reqs.filter(r => r.slashCommand).length;
    const ratio = reqs.length > 0 ? withSlash / reqs.length : 0;
    const score = ratio > 0.15 ? 100 : ratio > 0.05 ? 60 : ratio > 0 ? 30 : 10;
    return {
      checkId: 'slash-commands', name: 'Slash Command Adoption', category: 'Features',
      score, status: scoreToStatus(score),
      finding: `${withSlash} of ${reqs.length} requests use slash commands (${(ratio * 100).toFixed(1)}%).`,
      recommendation: score < 70 ? 'Try /fix, /explain, /tests, /doc to get more targeted responses.' : 'Good slash command usage.',
    };
  }

  private checkFeatureBreadth(reqs: SessionRequest[]): RecommendationResult {
    const features = new Set<string>();
    for (const r of reqs) {
      if (r.agentName) features.add('agent:' + r.agentName);
      if (r.slashCommand) features.add('slash:' + r.slashCommand);
      if (r.toolsUsed.length > 0) features.add('tools');
      if (r.editedFiles.length > 0) features.add('edits');
      if (r.referencedFiles.length > 0) features.add('file-refs');
      if (r.customInstructions.length > 0) features.add('custom-instructions');
      if (r.skillsUsed.length > 0) features.add('skills');
    }
    const count = features.size;
    const score = count >= 8 ? 100 : count >= 5 ? 70 : count >= 3 ? 40 : 15;
    return {
      checkId: 'feature-usage', name: 'Feature Breadth', category: 'Features',
      score, status: scoreToStatus(score),
      finding: `Using ${count} distinct Copilot features.`,
      recommendation: score < 70 ? 'Explore more features: agents, slash commands, file references, custom instructions, skills.' : 'Great feature breadth.',
    };
  }

  private checkParallelism(sessions: Session[]): RecommendationResult {
    const daySessionCounts = new Map<string, number>();
    for (const s of sessions) {
      const ts = s.lastMessageDate || s.creationDate;
      if (ts == null) continue;
      const d = toDateStr(ts);
      daySessionCounts.set(d, (daySessionCounts.get(d) || 0) + 1);
    }
    const avgParallel = daySessionCounts.size > 0
      ? Array.from(daySessionCounts.values()).reduce((a, b) => a + b, 0) / daySessionCounts.size : 0;
    const score = avgParallel >= 3 ? 100 : avgParallel >= 2 ? 70 : avgParallel >= 1.5 ? 40 : 20;
    return {
      checkId: 'parallelism', name: 'Parallelism', category: 'Productivity',
      score, status: scoreToStatus(score),
      finding: `Average ${avgParallel.toFixed(1)} concurrent sessions per active day.`,
      recommendation: score < 70 ? 'Try running multiple Copilot sessions to keep work moving while waiting for responses.' : 'Good parallel session usage.',
    };
  }

  private checkCancellationRate(reqs: SessionRequest[]): RecommendationResult {
    const cancelled = reqs.filter(r => r.isCanceled).length;
    const ratio = reqs.length > 0 ? cancelled / reqs.length : 0;
    const score = ratio < 0.05 ? 100 : ratio < 0.15 ? 60 : 20;
    return {
      checkId: 'cancellation', name: 'Cancellation Rate', category: 'Efficiency',
      score, status: scoreToStatus(score),
      finding: `${cancelled} of ${reqs.length} requests were cancelled (${(ratio * 100).toFixed(1)}%).`,
      recommendation: score < 70 ? 'High cancellation may indicate unclear prompts. Try being more specific in your requests.' : 'Low cancellation rate, good prompt clarity.',
    };
  }

  private checkToolDiversity(reqs: SessionRequest[]): RecommendationResult {
    const tools = new Set<string>();
    for (const r of reqs) for (const t of r.toolsUsed) tools.add(t);
    const count = tools.size;
    const score = count >= 8 ? 100 : count >= 5 ? 70 : count >= 3 ? 40 : count > 0 ? 20 : 10;
    return {
      checkId: 'tool-diversity', name: 'Tool Diversity', category: 'Features',
      score, status: scoreToStatus(score),
      finding: `Using ${count} distinct tools: ${Array.from(tools).slice(0, 5).join(', ')}${count > 5 ? '...' : ''}.`,
      recommendation: score < 70 ? 'Explore more tools in agentic mode: terminal, file search, web search, etc.' : 'Good tool diversity.',
    };
  }

  private checkResponseEfficiency(reqs: SessionRequest[]): RecommendationResult {
    const withTiming = reqs.filter(r => r.totalElapsed != null && r.totalElapsed > 0);
    const avgTime = withTiming.length > 0
      ? withTiming.reduce((s, r) => s + r.totalElapsed!, 0) / withTiming.length : 0;
    const avgSec = avgTime / 1000;
    const score = avgSec < 10 ? 100 : avgSec < 30 ? 70 : avgSec < 60 ? 40 : 20;
    return {
      checkId: 'response-time', name: 'Response Efficiency', category: 'Performance',
      score, status: scoreToStatus(score),
      finding: `Average response time: ${avgSec.toFixed(1)}s (${withTiming.length} timed requests).`,
      recommendation: score < 70 ? 'Long responses may indicate overly broad prompts. Break complex tasks into smaller requests.' : 'Good response times.',
    };
  }

  private checkFileContextUsage(reqs: SessionRequest[]): RecommendationResult {
    const withRefs = reqs.filter(r => r.referencedFiles.length > 0 || r.variableKinds['file'] > 0).length;
    const ratio = reqs.length > 0 ? withRefs / reqs.length : 0;
    const score = ratio > 0.3 ? 100 : ratio > 0.15 ? 70 : ratio > 0.05 ? 40 : 10;
    return {
      checkId: 'file-refs', name: 'File Context Usage', category: 'Context',
      score, status: scoreToStatus(score),
      finding: `${withRefs} of ${reqs.length} requests include file context (${(ratio * 100).toFixed(1)}%).`,
      recommendation: score < 70 ? 'Reference files with #file to give Copilot better context about your codebase.' : 'Good use of file context.',
    };
  }

  private checkSessionSizeDistribution(sessions: Session[]): RecommendationResult {
    const sizes = sessions.map(s => s.requestCount);
    const avg = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    const singleReq = sizes.filter(s => s === 1).length;
    const ratio = sizes.length > 0 ? singleReq / sizes.length : 0;
    const score = avg >= 3 && avg <= 15 && ratio < 0.3 ? 100
      : avg >= 2 && avg <= 25 ? 60 : 30;
    return {
      checkId: 'session-length', name: 'Session Size Distribution', category: 'Context',
      score, status: scoreToStatus(score),
      finding: `Average ${avg.toFixed(1)} requests/session. ${singleReq} single-request sessions (${(ratio * 100).toFixed(1)}%).`,
      recommendation: score < 70 ? 'Many single-request sessions? Consider using follow-up questions to refine responses.' : 'Healthy session size distribution.',
    };
  }

  /** Public access to filtered requests (for rule editor). */
  getFilteredRequests(f?: DateFilter): SessionRequest[] { return this.filter(f); }
  /** Public access to filtered sessions (for rule editor). */
  getFilteredSessions(f?: DateFilter): Session[] { return this.filteredSessions(f); }

  getAntiPatterns(f?: DateFilter): AntiPatternData {
    const reqs = this.filter(f);
    const sessions = this.filteredSessions(f);

    // Enrich requests with session context by object identity, not requestId.
    // Codex requestIds are not guaranteed to be unique across sessions.
    const sessionByRequest = new Map<SessionRequest, Session>();
    for (const s of sessions) {
      for (const r of s.requests) {
        sessionByRequest.set(r, s);
      }
    }

    const enrichedReqs: SessionRequest[] = [];
    for (const r of reqs) {
      const s = sessionByRequest.get(r);
      if (!s) continue;
      const enriched = r as SessionRequest & { sessionId: string; workspaceName: string };
      enriched.sessionId = s.sessionId;
      enriched.workspaceName = s.workspaceName;
      enrichedReqs.push(enriched);
    }

    const skipIdeDetectors = !!(f?.harness && !f.harness.startsWith('Local Agent') && f.harness !== 'Xcode');
    const patterns = runDetectors(enrichedReqs, sessions, skipIdeDetectors);
    return this.buildAntiPatternResult(patterns, enrichedReqs, skipIdeDetectors);
  }

  private buildAntiPatternResult(patterns: import('./types').AntiPattern[], reqs: SessionRequest[], skipIdeDetectors: boolean): AntiPatternData {
    const groupOrder: Record<string, number> = { 'prompt-quality': 0, 'session-hygiene': 1, 'code-review': 2, 'tool-mastery': 3 };
    patterns.sort((a, b) => (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9) || b.occurrences - a.occurrences);

    const weeklyTrend = computeWeeklyTrend(reqs);
    const weeklyScores = computeWeeklyScores(reqs);
    const totalOccurrences = patterns.reduce((s, p) => s + p.occurrences, 0);

    // Compute per-group health scores (0-100)
    // Score = 100 minus a penalty per detected pattern, scaled by severity and capped per-pattern
    const allGroups: PracticeGroup[] = ['prompt-quality', 'session-hygiene', 'code-review', 'tool-mastery'];
    const sevPenalty: Record<string, number> = { high: 12, medium: 7, low: 3 };

    // Count how many possible detectors exist per group (for baseline)
    const groupDetectorCount = getDetectorGroupCounts(skipIdeDetectors);

    const groupScores: GroupScore[] = allGroups.map(group => {
      const gPatterns = patterns.filter(p => p.group === group);
      const maxDetectors = groupDetectorCount[group] || 8;

      // Penalty: each detected pattern costs points based on severity
      let penalty = 0;
      for (const p of gPatterns) {
        penalty += sevPenalty[p.severity] || 5;
      }
      const maxPenalty = maxDetectors * 12;
      const score = Math.max(0, Math.round(100 * (1 - penalty / maxPenalty)));

      // Week-over-Week and Month-over-Month as percentage change
      const series = weeklyScores.series.find(s => s.group === group);
      let wowPct = 0;
      let momPct = 0;
      if (series && series.scores.length >= 2) {
        const last = series.scores[series.scores.length - 1];
        const prev = series.scores[series.scores.length - 2];
        wowPct = prev > 0 ? Math.round(((last - prev) / prev) * 100) : 0;
      }
      if (series && series.scores.length >= 5) {
        const recentMonth = series.scores.slice(-4);
        const prevMonth = series.scores.slice(-8, -4);
        if (prevMonth.length > 0) {
          const avgRecent = recentMonth.reduce((a, b) => a + b, 0) / recentMonth.length;
          const avgPrev = prevMonth.reduce((a, b) => a + b, 0) / prevMonth.length;
          momPct = avgPrev > 0 ? Math.round(((avgRecent - avgPrev) / avgPrev) * 100) : 0;
        }
      }

      const topIssue = gPatterns.length > 0 ? gPatterns[0].suggestion : null;

      // Build specific improvement messages
      const improvements: string[] = [];

      // Score trend improvements
      if (wowPct > 5) {
        improvements.push(`Score improved ${wowPct}% this week.`);
      }
      if (momPct > 5) {
        improvements.push(`Score up ${momPct}% compared to last month.`);
      }

      // If no patterns detected, that's a strong positive
      if (gPatterns.length === 0) {
        improvements.push('All checks passing -- no anti-patterns detected.');
      }

      return { group, score, wowPct, momPct, topIssue, improvements, patternCount: gPatterns.length };
    });

    return { patterns, totalOccurrences, weeklyTrend, groupScores, weeklyScores };
  }

  getProjectOverview(f?: DateFilter): ProjectOverviewData {
    const sessions = this.filteredSessions(f);
    const projects = Array.from(this.groupWorkspaceRequests(sessions, f).entries())
      .map(([workspaceName, data]) => this.buildProjectOverviewItem(workspaceName, data))
      .filter((project): project is ProjectOverviewItem => project !== null)
      .sort((a, b) => b.estimatedHours - a.estimatedHours)
      .slice(0, 20);
    return { projects };
  }

  private groupWorkspaceRequests(
    sessions: Session[],
    f?: DateFilter,
  ): Map<string, { id: string; sessions: Session[]; reqs: SessionRequest[] }> {
    const wsMap = new Map<string, { id: string; sessions: Session[]; reqs: SessionRequest[] }>();
    for (const session of sessions) {
      if (!wsMap.has(session.workspaceName)) {
        wsMap.set(session.workspaceName, { id: session.workspaceId, sessions: [], reqs: [] });
      }
      const entry = wsMap.get(session.workspaceName)!;
      entry.sessions.push(session);
      for (const request of session.requests) {
        if (request.timestamp == null) continue;
        if (f?.fromDate && toDateStr(request.timestamp) < f.fromDate) continue;
        if (f?.toDate && toDateStr(request.timestamp) > f.toDate) continue;
        entry.reqs.push(request);
      }
    }
    return wsMap;
  }

  private buildProjectOverviewItem(
    workspaceName: string,
    data: { id: string; sessions: Session[]; reqs: SessionRequest[] },
  ): ProjectOverviewItem | null {
    if (data.reqs.length === 0) return null;
    return {
      workspaceName,
      workspaceId: data.id,
      totalRequests: data.reqs.length,
      estimatedHours: this.estimateProjectHours(data.reqs),
      languages: this.getProjectLanguages(data.reqs),
      timePattern: this.getProjectTimePattern(data.reqs),
      topFiles: this.getTopProjectFiles(data.reqs),
      estimatedLoc: this.getEstimatedProjectLoc(data.reqs),
      gitPath: data.sessions[0]?.location || null,
    };
  }

  private getProjectLanguages(reqs: SessionRequest[]): string[] {
    const langCounts = new Map<string, number>();
    for (const request of reqs) {
      for (const codeBlock of [...request.aiCode, ...request.userCode]) {
        if (!codeBlock.language) continue;
        const language = codeBlock.language.toLowerCase();
        langCounts.set(language, (langCounts.get(language) || 0) + codeBlock.loc);
      }
      for (const file of request.editedFiles) {
        const ext = file.split('.').pop()?.toLowerCase();
        if (!ext) continue;
        const language = extToLang(ext);
        if (language) langCounts.set(language, (langCounts.get(language) || 0) + 1);
      }
    }
    return Array.from(langCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([language]) => language);
  }

  private estimateProjectHours(reqs: SessionRequest[]): number {
    const dayGroups = new Map<string, number[]>();
    for (const request of reqs) {
      if (!request.timestamp) continue;
      const dayKey = toDateStr(request.timestamp);
      if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
      dayGroups.get(dayKey)!.push(request.timestamp);
    }

    let totalMinutes = 0;
    for (const timestamps of dayGroups.values()) {
      timestamps.sort((a, b) => a - b);
      if (timestamps.length === 1) {
        totalMinutes += 5;
        continue;
      }
      const spanMs = timestamps[timestamps.length - 1] - timestamps[0];
      totalMinutes += Math.min(spanMs / 60000, 12 * 60);
    }
    return Math.round(totalMinutes / 60 * 10) / 10;
  }

  private getProjectTimePattern(reqs: SessionRequest[]): string {
    let weekendCount = 0;
    let eveningCount = 0;
    let morningCount = 0;
    for (const request of reqs) {
      if (!request.timestamp) continue;
      const date = new Date(request.timestamp);
      const dayOfWeek = date.getDay();
      const hour = date.getHours();
      if (dayOfWeek === 0 || dayOfWeek === 6) weekendCount++;
      if (hour >= 18 || hour < 6) eveningCount++;
      if (hour >= 6 && hour < 12) morningCount++;
    }

    const total = reqs.length;
    let timePattern = weekendCount / total > 0.4
      ? 'mostly weekends'
      : weekendCount / total > 0.2
        ? 'weekends + weekdays'
        : 'mostly weekdays';
    if (eveningCount / total > 0.4) timePattern += ', evenings';
    else if (morningCount / total > 0.4) timePattern += ', mornings';
    return timePattern;
  }

  private getTopProjectFiles(reqs: SessionRequest[]): string[] {
    const fileCounts = new Map<string, number>();
    for (const request of reqs) {
      for (const file of request.editedFiles) {
        const short = file.split('/').slice(-2).join('/');
        fileCounts.set(short, (fileCounts.get(short) || 0) + 1);
      }
    }
    return Array.from(fileCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([file]) => file);
  }

  private getEstimatedProjectLoc(reqs: SessionRequest[]): number {
    let estimatedLoc = 0;
    for (const request of reqs) {
      estimatedLoc += request.aiCode.reduce((sum, block) => sum + block.loc, 0);
      const editLocs = this.editLocIndex.get(request.requestId);
      if (editLocs) {
        for (const loc of editLocs.values()) estimatedLoc += loc;
      }
    }
    return estimatedLoc;
  }
}
