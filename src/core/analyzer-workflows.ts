/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Workflow optimization analyzer -- clusters repeated similar prompts */

import { DateFilter, WorkflowCluster, WorkflowOptimizationData } from './types';
import { AnalyzerBase } from './analyzer-base';
import { isHarnessInjectedContext, toDateStr } from './helpers';

/** Minimum prompt length to consider for clustering (skip trivial messages) */
const MIN_PROMPT_LEN = 15;
/** Minimum occurrences to qualify as a cluster */
const MIN_OCCURRENCES = 3;
/** Similarity threshold (0-1). Higher = stricter matching */
const _SIMILARITY_THRESHOLD = 0.55;
/** Max clusters to return */
const MAX_CLUSTERS = 200;
/** Estimated minutes saved per repetition if a skill handled it */
const MINS_PER_REPETITION = 2;

interface PromptRecord {
  text: string;
  normalized: string;
  tokens: string[];
  sessionId: string;
  workspaceName: string;
  harness: string;
  timestamp: number | null;
  isCanceled: boolean;
  turnIndex: number; // position within session
  sessionLength: number;
}

/**
 * Normalize a prompt for comparison: lowercase, collapse whitespace,
 * strip file paths, numbers, and quoted strings.
 */
function normalizePrompt(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/`[^`]*`/g, ' CODE ')         // inline code
    .replaceAll(/"[^"]*"/g, ' STR ')           // quoted strings
    .replaceAll(/'[^']*'/g, ' STR ')
    .replaceAll(/\/[\w./-]+/g, ' PATH ')       // file paths
    .replaceAll(/\d+/g, ' NUM ')              // numbers
    .replaceAll(/[^a-z\s]/g, ' ')             // strip punctuation
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Check if text is likely a system/bot message or noise rather than a user prompt */
function isNoise(text: string): boolean {
  const t = text.trim();
  // Harness-injected session-start context (e.g. Codex AGENTS.md / environment context)
  if (isHarnessInjectedContext(t)) return true;
  // Decorative separators/borders
  if (/^[═─━=\-_*]{10,}/.test(t)) return true;
  // System auth/notification messages
  if (/^system\b/i.test(t)) return true;
  // Extremely long pasted content (not a prompt)
  if (t.length > 2000) return true;
  // Standard agent actions (continue, try again, yes/no confirmations)
  const lower = t.toLowerCase();
  if (/^@?\w*\s*(continue|try again|yes|no|cancel|abort|stop|retry)\s*[:?!.]*\s*("?continue to iterate\??"?)?$/i.test(t)) return true;
  if (lower === 'y' || lower === 'n' || lower === 'yes' || lower === 'no') return true;
  if (/^(@\w+\s+)?continue:?\s*("?continue to iterate\??"?|to iterate|$)/i.test(t)) return true;
  if (/^(try again|retry):?\s*$/i.test(t)) return true;
  // Catch any prompt that is purely "continue to iterate" with surrounding noise
  if (/continue to iterate/i.test(lower) && t.length < 80) return true;
  // Very short confirmations (under 5 chars, no real content)
  if (t.length <= 3 && /^[ynYN.!?]+$/.test(t)) return true;
  return false;
}

function tokenize(normalized: string): string[] {
  // stop words that don't contribute to intent similarity
  const stop = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'it', 'its', 'this', 'that', 'my',
    'me', 'i', 'we', 'you', 'they', 'he', 'she', 'num', 'str', 'code',
    'path', 'and', 'or', 'but', 'not', 'if', 'then', 'so', 'just',
    'please', 'also', 'make', 'sure', 'want', 'need', 'like',
  ]);
  return normalized.split(' ').filter(w => w.length > 1 && !stop.has(w));
}

/** Pick the most representative prompt from a cluster (closest to centroid) */
function pickCanonical(records: PromptRecord[]): string {
  // Pick the shortest-but-meaningful prompt as the canonical label
  const sorted = [...records].sort((a, b) => a.text.length - b.text.length);
  // Skip very short ones that might be abbreviations
  const candidate = sorted.find(r => r.text.length >= 20) || sorted[0];
  return candidate.text;
}

/** Build a suggested skill markdown for a cluster */
function draftSkill(cluster: { label: string; records: PromptRecord[] }): string {
  const topExamples = cluster.records.slice(0, 3).map(r => r.text.slice(0, 120));
  return [
    `# Skill: ${cluster.label}`,
    '',
    '## When to use',
    `Triggered when the user asks to: ${cluster.label}`,
    '',
    '## Steps',
    '1. [describe the first action the AI should take]',
    '2. [describe the second action]',
    '3. [verify the result]',
    '',
    '## Example prompts',
    ...topExamples.map(ex => `- "${ex}"`),
  ].join('\n');
}

export class WorkflowAnalyzer extends AnalyzerBase {
  getWorkflowOptimization(f?: DateFilter): WorkflowOptimizationData {
    const sessions = this.filteredSessions(f);

    // 1. Collect all prompts with metadata
    const records: PromptRecord[] = [];
    for (const s of sessions) {
      for (let i = 0; i < s.requests.length; i++) {
        const r = s.requests[i];
        const text = r.messageText.trim();
        if (text.length < MIN_PROMPT_LEN) continue;
        if (isNoise(text)) continue;
        const normalized = normalizePrompt(text);
        const tokens = tokenize(normalized);
        if (tokens.length < 2) continue; // too generic after normalization
        records.push({
          text,
          normalized,
          tokens,
          sessionId: s.sessionId,
          workspaceName: s.workspaceName,
          harness: s.harness,
          timestamp: r.timestamp,
          isCanceled: r.isCanceled,
          turnIndex: i,
          sessionLength: s.requests.length,
        });
      }
    }

    // 2. Fast O(n) fingerprint-based clustering
    // Each record gets a fingerprint = sorted first 4 tokens joined.
    // Records with matching fingerprints are grouped together.
    const buckets = new Map<string, PromptRecord[]>();

    for (const rec of records) {
      const sorted = [...rec.tokens].sort();
      // Use first 4 tokens as fingerprint (captures core intent)
      const fp = sorted.slice(0, 4).join('|');
      let bucket = buckets.get(fp);
      if (!bucket) { bucket = []; buckets.set(fp, bucket); }
      bucket.push(rec);
    }

    // 3. Filter to clusters with enough occurrences & sort by count
    const qualified = [...buckets.values()]
      .filter(c => c.length >= MIN_OCCURRENCES)
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_CLUSTERS)
      .map(members => ({ leader: members[0], members }));

    // 4. Build result objects
    const clusters: WorkflowCluster[] = qualified.map((c, idx) => {
      const members = c.members;
      const canonical = pickCanonical(members);
      const label = canonical.length > 80 ? canonical.slice(0, 77) + '...' : canonical;
      const uniqueSessions = new Set(members.map(m => m.sessionId));
      const uniqueWs = [...new Set(members.map(m => m.workspaceName))];
      const uniqueHarnesses = [...new Set(members.map(m => m.harness))];
      const timestamps = members.map(m => m.timestamp).filter((t): t is number => t !== null);
      const cancelCount = members.filter(m => m.isCanceled).length;

      // Average "correction turns": how many times the same session has a member in this cluster
      const sessionCounts = new Map<string, number>();
      for (const m of members) {
        sessionCounts.set(m.sessionId, (sessionCounts.get(m.sessionId) || 0) + 1);
      }
      const sessionsWithMultiple = [...sessionCounts.values()].filter(v => v > 1);
      const avgCorrectionTurns = sessionsWithMultiple.length > 0
        ? sessionsWithMultiple.reduce((a, b) => a + b, 0) / sessionsWithMultiple.length
        : 0;

      // Pick diverse examples
      const seen = new Set<string>();
      const examples: string[] = [];
      for (const m of members) {
        const short = m.text.slice(0, 150);
        if (!seen.has(m.normalized) && examples.length < 5) {
          seen.add(m.normalized);
          examples.push(short);
        }
      }

      return {
        id: `wf-${idx}`,
        label,
        canonicalPrompt: canonical,
        occurrences: members.length,
        sessions: uniqueSessions.size,
        workspaces: uniqueWs,
        harnesses: uniqueHarnesses,
        avgCorrectionTurns: Math.round(avgCorrectionTurns * 10) / 10,
        totalTurns: members.length,
        cancelRate: members.length > 0 ? Math.round((cancelCount / members.length) * 100) : 0,
        firstSeen: timestamps.length > 0 ? toDateStr(Math.min(...timestamps)) : null,
        lastSeen: timestamps.length > 0 ? toDateStr(Math.max(...timestamps)) : null,
        examples,
        skillDraft: draftSkill({ label, records: members }),
      };
    });

    // 5. Estimated time saved
    const totalRepetitions = clusters.reduce((s, c) => s + c.occurrences, 0);
    const estimatedTimeSavedMins = totalRepetitions * MINS_PER_REPETITION;

    // 6. Top workspaces by cluster involvement
    const wsClusters = new Map<string, Set<string>>();
    for (const c of clusters) {
      for (const ws of c.workspaces) {
        if (!wsClusters.has(ws)) wsClusters.set(ws, new Set());
        wsClusters.get(ws)!.add(c.id);
      }
    }
    const topWorkspaces = [...wsClusters.entries()]
      .map(([name, ids]) => ({ name, clusters: ids.size }))
      .sort((a, b) => b.clusters - a.clusters)
      .slice(0, 10);

    return {
      clusters,
      totalRepetitions,
      estimatedTimeSavedMins,
      topWorkspaces,
    };
  }
}
