/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nlp from 'compromise';
import type { CuriositySignal } from './types';

// Harnesses wrap injected context in snake_case or kebab-case tags; prose markup seldom uses them.
const WRAPPER_TAG = String.raw`[a-z][a-z\d]*(?:[_-][a-z\d]+)+|context|instructions|attachments`;
const WRAPPER = new RegExp(String.raw`<(${WRAPPER_TAG})\b[^>]*>[\s\S]*?<\/\1>`, 'gi');
const WRAPPER_MARK = new RegExp(String.raw`<\/?(?:${WRAPPER_TAG})\b[^>]*>`, 'gi');
const ROLE = /^(?:User|Human|Assistant|AI|Model|Bot|You(?: \([^)\n]*\))?):[ \t]*/gim;

/** A replayed transcript contributes only its latest user turn. */
function latestUserTurn(text: string): string {
  const roles = [...text.matchAll(ROLE)];
  const user = roles.filter(role => /^(?:user|human)/i.test(role[0])).at(-1);
  if (!user) return text;
  const next = roles.find(role => role.index > user.index);
  return text.slice(user.index + user[0].length, next?.index);
}

interface SentenceFeatures {
  question: boolean;
  repeated?: string;
}
const sentenceCache = new Map<string, SentenceFeatures>();
let sentenceCacheChars = 0;

function sentenceFeatures(text: string): SentenceFeatures {
  const cached = sentenceCache.get(text);
  if (cached) return cached;
  const sentence = nlp(text);
  const question = sentence.sentences().isQuestion().found;
  const repeated = question && text.length < 240 && sentence.terms().length >= 5
    ? sentence.text('normal').replace(/[?!.]+$/, '').trim() : undefined;
  const result = { question, repeated };
  // The parse worker owns this cache; keep scalar evidence, not NLP documents.
  while (sentenceCache.size && (sentenceCache.size >= 4096 || sentenceCacheChars + text.length > 1_000_000)) {
    const oldest = sentenceCache.keys().next().value!;
    sentenceCacheChars -= oldest.length;
    sentenceCache.delete(oldest);
  }
  sentenceCache.set(text, result);
  sentenceCacheChars += text.length;
  return result;
}

function withoutFences(text: string): string {
  let fence = '';
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

/** Native grammatical features only. Run on raw text in the parse worker. */
export function detectCuriosity(text: string): CuriositySignal {
  if (text.length > 256_000) return { kind: 'unscanned', excerpts: [] };
  const clean = withoutFences(latestUserTurn(text).replaceAll(WRAPPER, '').replaceAll(WRAPPER_MARK, ' '))
    .replaceAll(/^[ \t]*`[^`\n]*`[ \t]*$/gm, '')
    .replaceAll(/`([a-zA-Z_$][\w.$]*)`/g, '$1')
    .replaceAll(/^[ \t]*>[^\n]*|`[^`\n]*`|"[^"\n]*"|https?:\/\/[^\s<>]+/gm, ' ')
    .trim();
  if (!clean) return { kind: 'excluded', excerpts: [] };
  const sentences: string[] = [];
  nlp.tokenize(clean).sentences().forEach(sentence => { sentences.push(...sentence.text().split(/\n+/).map(s => s.trim()).filter(Boolean)); });
  if (sentences.length > 256 || sentences.some(sentence => sentence.length > 32_000)) {
    return { kind: 'unscanned', excerpts: [] };
  }
  const signal: Extract<CuriositySignal, { kind: 'analyzed' }> = {
    kind: 'analyzed',
    features: { question: { count: 0, excerpts: [] } },
    repeatedQuestions: [],
  };
  for (const text of sentences) {
    const sentence = sentenceFeatures(text);
    if (!sentence.question) continue;
    const evidence = signal.features.question;
    evidence.count++;
    if (evidence.excerpts.length < 3) evidence.excerpts.push(text.slice(0, 240));
    if (clean.length <= 500 && sentence.repeated !== undefined && signal.repeatedQuestions.length < 3) {
      signal.repeatedQuestions.push(sentence.repeated);
    }
  }
  return signal;
}
