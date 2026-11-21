/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { evaluateExpression } from './dsl/index';

describe('context-engineering-gaps inline debug', () => {
  it('someWhere detects empty agentName', () => {
    const allReqs = [
      { harness: 'Local Agent', agentName: '', agentMode: '', toolsUsed: [], skillsUsed: [], referencedFiles: [], customInstructions: [] },
      { harness: 'Local Agent', agentName: '', agentMode: '', toolsUsed: [], skillsUsed: [], referencedFiles: [], customInstructions: [] },
    ];
    
    const result = evaluateExpression('someWhere(allReqs, "agentName", "!=", "")', { allReqs });
    console.log('someWhere agentName != "":', result);
    expect(result).toBe(0);
    
    const hasSubAgents = evaluateExpression('someWhere(allReqs, "agentName", "!=", "") AND someWhere(allReqs, "agentName", "!=", "copilot") AND someWhere(allReqs, "agentMode", "agent")', { allReqs });
    console.log('hasSubAgents:', hasSubAgents);
    
    const gap1 = evaluateExpression('hasSubAgents == 0', { hasSubAgents });
    console.log('gap1 (hasSubAgents == 0):', gap1);
    
    const hasSkills = evaluateExpression('flatCount(allReqs, "skillsUsed") > 0', { allReqs });
    console.log('hasSkills:', hasSkills);
    
    const gap2 = evaluateExpression('hasSkills == 0', { hasSkills });
    console.log('gap2 (hasSkills == 0):', gap2);
    
    const hasMcp = evaluateExpression('flatSomeWhere(allReqs, "toolsUsed", ".", "mcp_", "startsWith")', { allReqs });
    console.log('hasMcp:', hasMcp);
    
    const gap3 = evaluateExpression('hasMcp == 0', { hasMcp });
    console.log('gap3 (hasMcp == 0):', gap3);
    
    const count = 2;
    const fileRefRate = evaluateExpression('countWhere(allReqs, "referencedFiles.length", ">", 0) / count', { allReqs, count });
    console.log('fileRefRate:', fileRefRate);
    
    const gap4 = evaluateExpression('fileRefRate < 0.1', { fileRefRate });
    console.log('gap4 (fileRefRate < 0.1):', gap4);
    
    const instrReportedReqs = evaluateExpression('countWhere(allReqs, "harness", "matches", "^Local Agent")', { allReqs });
    console.log('instrReportedReqs:', instrReportedReqs);
    
    const instrRate = evaluateExpression('countWhere(allReqs, "customInstructions.length", ">", 0) / instrReportedReqs', { allReqs, instrReportedReqs });
    console.log('instrRate:', instrRate);
    
    const gap5 = evaluateExpression('instrReportedReqs > 0 AND instrRate < 0.05', { instrReportedReqs, instrRate });
    console.log('gap5 (instrReportedReqs > 0 AND instrRate < 0.05):', gap5);
    
    // Boolean arithmetic
    const gapCount = evaluateExpression('gap1 + gap2 + gap3 + gap4 + gap5', { gap1, gap2, gap3, gap4, gap5 });
    console.log('gapCount:', gapCount, typeof gapCount);
    expect(gapCount).toBe(5);
    expect(evaluateExpression('4 + (instrReportedReqs > 0)', { instrReportedReqs })).toBe(5);
    
    const check = evaluateExpression('gapCount > 0 AND count >= 30', { gapCount, count });
    console.log('check:', check);
  });

  it('leaves the custom-instructions signal out without VS Code requests', () => {
    const allReqs = [{ harness: 'Claude', customInstructions: [] }, { harness: 'GitHub Copilot CLI', customInstructions: [] }];
    const instrReportedReqs = evaluateExpression('countWhere(allReqs, "harness", "matches", "^Local Agent")', { allReqs });
    const instrRate = evaluateExpression('countWhere(allReqs, "customInstructions.length", ">", 0) / instrReportedReqs', { allReqs, instrReportedReqs });
    expect(evaluateExpression('instrReportedReqs > 0 AND instrRate < 0.05', { instrReportedReqs, instrRate })).toBe(false);
    expect(evaluateExpression('4 + (instrReportedReqs > 0)', { instrReportedReqs })).toBe(4);
  });
});
