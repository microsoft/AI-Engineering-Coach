/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCuriosityActivity, type CuriosityActivity, type UnclassifiedReason } from './curiosity-activity';
import type { SessionRequest } from './types';
import type { CuriosityData, CuriositySession } from './types/curiosity-types';

interface InquiryRun {
  ids: string[];
  session: CuriositySession;
  lastQuestionAt: number;
  timingComplete: boolean;
  responseEnd: number;
}
interface SequenceNode {
  children: Map<string, SequenceNode>;
  run?: InquiryRun;
}

export class InquirySequences {
  private readonly root: SequenceNode = { children: new Map() };
  private run: InquiryRun | undefined;

  add(request: SessionRequest, id: string, activity: CuriosityActivity | UnclassifiedReason,
    reference: (request: SessionRequest) => CuriositySession): void {
    if (request.curiosity?.kind === 'excluded') {
      if (request.toolsUsed.length || request.editedFiles.length) this.finish();
      return;
    }
    if (request.curiosity?.kind !== 'analyzed' || !isCuriosityActivity(activity) || request.isCanceled
      || request.endState === 'errored' || request.endState === 'pending') {
      this.finish();
      return;
    }
    const timestamp = request.timestamp!;
    if (activity === 'action' || this.run && timestamp - this.run.lastQuestionAt > 86_400_000) this.finish();
    if (activity === 'action') return;
    this.run ??= { ids: [], session: reference(request), lastQuestionAt: timestamp, timingComplete: true, responseEnd: 0 };
    this.run.ids.push(id);
    this.run.lastQuestionAt = timestamp;
    const elapsed = request.totalElapsed;
    if (elapsed == null || !Number.isFinite(elapsed) || elapsed <= 0) this.run.timingComplete = false;
    else this.run.responseEnd = Math.max(this.run.responseEnd, timestamp + elapsed);
  }

  finish(): void {
    if (this.run && this.run.ids.length >= 2) {
      let node = this.root;
      for (const id of this.run.ids) {
        const child = node.children.get(id) ?? { children: new Map<string, SequenceNode>() };
        node.children.set(id, child);
        node = child;
      }
      node.run = this.run;
    }
    this.run = undefined;
  }

  summary(): CuriosityData['chains'] {
    const runs: InquiryRun[] = [];
    const pending = [this.root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.children.size) for (const child of node.children.values()) pending.push(child);
      else if (node.run) runs.push(node.run);
    }
    // Keep deterministic tie order without treating serialized text as a sequence.
    const sorted = runs.map(run => ({ run, key: JSON.stringify(run.ids) }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(row => row.run);
    return {
      total: sorted.length,
      sustained: sorted.filter(run => run.ids.length >= 3).length,
      exchanges: new Set(sorted.flatMap(run => run.ids)).size,
      examples: sorted.sort((a, b) => b.lastQuestionAt - a.lastQuestionAt).slice(0, 8).map(run => {
        const elapsed = run.responseEnd - run.session.timestamp;
        return {
          exchanges: run.ids.length, session: run.session,
          elapsedMs: run.timingComplete && run.lastQuestionAt > run.session.timestamp && Number.isFinite(elapsed) && elapsed > 0
            ? elapsed : undefined,
        };
      }),
    };
  }
}
