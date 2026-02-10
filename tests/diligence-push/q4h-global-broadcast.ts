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
        selfId: dlgId.selfId,
        tellaskHead: '@human',
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

    postDialogEvent(dlg, {
      type: 'subdialog_created_evt',
      course: 1,
      parentDialog: {
        selfId: dlgId.selfId,
        rootId: dlgId.rootId,
      },
      subDialog: {
        selfId: 'sub-1',
        rootId: dlgId.rootId,
      },
      targetAgentId: 'coder',
      tellaskHead: '@coder',
      tellaskBody: 'Please investigate.',
      subDialogNode: {
        selfId: 'sub-1',
        rootId: dlgId.rootId,
        supdialogId: dlgId.selfId,
        agentId: 'coder',
        taskDocPath: 'task.md',
        status: 'running',
        currentCourse: 1,
        createdAt: '2026-01-29 00:00:01',
        lastModified: '2026-01-29 00:00:01',
        runState: { kind: 'idle_waiting_user' },
        tellaskSession: 'sess-1',
        assignmentFromSup: {
          tellaskHead: '@coder',
          tellaskBody: 'Please investigate.',
          originMemberId: 'tester',
          callerDialogId: dlgId.selfId,
          callId: 'call-1',
        },
      },
    });

    const q4hAskedEvents = received.filter((evt) => evt.type === 'new_q4h_asked');
    const q4hAnsweredEvents = received.filter((evt) => evt.type === 'q4h_answered');
    const subdialogCreatedEvents = received.filter((evt) => evt.type === 'subdialog_created_evt');
    const touchedEvents = received.filter((evt) => evt.type === 'dlg_touched_evt');

    if (q4hAskedEvents.length !== 1) {
      throw new Error(`Expected 1 new_q4h_asked event, got ${q4hAskedEvents.length}`);
    }
    if (q4hAnsweredEvents.length !== 1) {
      throw new Error(`Expected 1 q4h_answered event, got ${q4hAnsweredEvents.length}`);
    }
    if (subdialogCreatedEvents.length !== 1) {
      throw new Error(
        `Expected 1 subdialog_created_evt event, got ${subdialogCreatedEvents.length}`,
      );
    }
    if (touchedEvents.length !== 4) {
      throw new Error(`Expected 4 dlg_touched_evt events, got ${touchedEvents.length}`);
    }

    const asked = q4hAskedEvents[0]!;
    const subCreated = subdialogCreatedEvents[0]!;
    if (asked.dialog.selfId !== dlgId.selfId || asked.dialog.rootId !== dlgId.rootId) {
      throw new Error('Expected typed dialog context on new_q4h_asked broadcast');
    }
    if (subCreated.dialog.selfId !== dlgId.selfId || subCreated.dialog.rootId !== dlgId.rootId) {
      throw new Error('Expected typed dialog context on subdialog_created_evt broadcast');
    }

    const touchedSourceTypes = new Set(
      touchedEvents.map((evt) => (evt.type === 'dlg_touched_evt' ? evt.sourceType : 'unexpected')),
    );
    const expectedTouchedSources = new Set([
      'dlg_run_state_evt',
      'new_q4h_asked',
      'q4h_answered',
      'subdialog_created_evt',
    ]);
    if (touchedSourceTypes.size !== expectedTouchedSources.size) {
      throw new Error(
        `Unexpected dlg_touched_evt sourceType set size: got ${touchedSourceTypes.size}, expected ${expectedTouchedSources.size}`,
      );
    }
    for (const sourceType of expectedTouchedSources) {
      if (!touchedSourceTypes.has(sourceType)) {
        throw new Error(`Missing dlg_touched_evt sourceType: ${sourceType}`);
      }
    }

    console.log('global dialog event broadcast: PASS');
  } finally {
    setQ4HBroadcaster(null);
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`global dialog event broadcast: FAIL\n${message}`);
  process.exit(1);
});
