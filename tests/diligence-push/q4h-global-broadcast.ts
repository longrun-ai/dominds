#!/usr/bin/env tsx

import '../../main/tools/builtins';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
  requireRecordingGlobalDialogEventRecorder,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID, RootDialog } from '../../main/dialog';
import { postDialogEvent, postDialogEventById } from '../../main/evt-registry';
import { DiskFileDialogStore } from '../../main/persistence';

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dominds-q4h-bcast-'));
  process.chdir(tmpBase);

  try {
    const dlgId = new DialogID('dlg-q4h-bcast-test');
    const store = new DiskFileDialogStore(dlgId);
    const dlg = new RootDialog(store, 'task.md', dlgId, 'tester');

    installRecordingGlobalDialogEventBroadcaster({
      label: 'tests/q4h-global-broadcast',
    });
    const recorder = requireRecordingGlobalDialogEventRecorder('q4h-global-broadcast');
    recorder.clear();

    postDialogEvent(dlg, {
      type: 'dlg_display_state_evt',
      displayState: { kind: 'idle_waiting_user' },
    });

    postDialogEvent(dlg, {
      type: 'new_q4h_asked',
      question: {
        id: 'q1',
        selfId: dlgId.selfId,
        tellaskContent: 'Please confirm.',
        askedAt: '2026-01-29 00:00:00',
        callId: 'call-q1',
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
      mentionList: ['@coder'],
      tellaskContent: 'Please investigate.',
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
        displayState: { kind: 'idle_waiting_user' },
        sessionSlug: 'sess-1',
        assignmentFromSup: {
          mentionList: ['@coder'],
          tellaskContent: 'Please investigate.',
          originMemberId: 'tester',
          callerDialogId: dlgId.selfId,
          callId: 'call-1',
        },
      },
    });

    const received: readonly TypedDialogEvent[] = recorder.snapshot();
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
      'dlg_display_state_evt',
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
    clearInstalledGlobalDialogEventBroadcaster();
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`global dialog event broadcast: FAIL\n${message}`);
  process.exit(1);
});
