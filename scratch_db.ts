import { parseAntigravitySessions } from './src/core/parser-antigravity';
const sessions = parseAntigravitySessions('/Users/alex/.gemini/antigravity/conversations/');
for (const s of sessions) {
  for (const r of s.requests) {
    console.log(`Req: ${r.requestId}, model: ${r.modelId}, promptTokens: ${r.promptTokens}, completionTokens: ${r.completionTokens}`);
  }
}
