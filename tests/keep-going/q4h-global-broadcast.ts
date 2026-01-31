#!/usr/bin/env tsx

import 'dominds/tools/builtins';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DialogID, RootDialog } from 'dominds/dialog';
import { postDialogEvent, postDialogEventById, setQ4HBroadcaster } from 'dominds/evt-registry';
import { DiskFileDialogStore } from 'dominds/persistence';
import type { TypedDialogEvent } from 'dominds/shared/types/dialog';

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dominds-q4h-bcast-'));
  process.chdir(tmpBase);

  try {
    const dlgId = new DialogID('dlg-q4h-bcast-test');
    const store = new DiskFileDialogStore(dlgId);
    const dlg = new RootDialog(store, 'task.md', dlgId, 'tester');

    const received: TypedDialogEvent[] = [];
    setQ4HBroadcaster((evt) => {
      received.push(evt);
    });

    postDialogEvent(dlg, {
      type: 'dlg_run_state_evt',
      runState: { kind: 'idle_waiting_user' },
    });

    postDialogEvent(dlg, {
      type: 'new_q4h_asked',
      question: {
        id: 'q1',
        kind: 'keep_going_budget_exhausted',
        selfId: dlgId.selfId,
        headLine: '@human',
        bodyContent: 'Please confirm.',
        askedAt: '2026-01-29 00:00:00',
        callSiteRef: { course: 1, messageIndex: 1 },
        rootId: dlgId.rootId,
        agentId: 'tester',
        taskDocPath: 'task.md',
      },
    });

    postDialogEventById(dlgId, {
      type: 'q4h_answered',
      questionId: 'q1',
      selfId: dlgId.selfId,
    });

    if (received.length !== 2) {
      throw new Error(`Expected 2 broadcast Q4H events, got ${received.length}`);
    }
    if (received[0].type !== 'new_q4h_asked') {
      throw new Error(`Expected first event new_q4h_asked, got ${received[0].type}`);
    }
    if (received[1].type !== 'q4h_answered') {
      throw new Error(`Expected second event q4h_answered, got ${received[1].type}`);
    }
    if (received[0].dialog.selfId !== dlgId.selfId || received[0].dialog.rootId !== dlgId.rootId) {
      throw new Error('Expected typed dialog context on broadcast event');
    }

    console.log('q4h global broadcast: PASS');
  } finally {
    setQ4HBroadcaster(null);
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`q4h global broadcast: FAIL\n${message}`);
  process.exit(1);
});
