import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import YAML from 'yaml';

import type {
  DialogLatestFile,
  MainDialogMetadataFile,
  PendingSideDialogStateRecord,
} from '@longrun-ai/kernel/types/storage';
import { toRootGenerationAnchor } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID, type DialogStore, MainDialog } from '../../main/dialog';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';
import {
  applyPrimingScriptsToDialog,
  saveDialogCourseAsIndividualPrimingScript,
} from '../../main/priming';
import { materializeReminder, type Reminder } from '../../main/tool';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-priming-reminders-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function writeLatest(dialogId: DialogID, currentCourse: number): Promise<void> {
  const latest: DialogLatestFile = {
    currentCourse,
    lastModified: formatUnifiedTimestamp(new Date()),
    status: 'active',
    displayState: { kind: 'idle_waiting_user' },
  };
  await DialogPersistence.mutateDialogLatest(dialogId, () => ({ kind: 'replace', next: latest }));
}

function parseTopLevelFrontmatter(markdown: string): Record<string, unknown> {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('priming markdown missing top-level frontmatter');
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error('priming markdown frontmatter is not terminated');
  }
  const parsed = YAML.parse(normalized.slice(4, end)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('priming markdown top-level frontmatter must be an object');
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const primingSlug = `priming-reminders-${path.basename(process.cwd())}`;
    const sourceId = new DialogID('11/22/priming-source');
    const sourceMeta: MainDialogMetadataFile = {
      id: sourceId.selfId,
      agentId: 'rtws',
      taskDocPath: 'plans/demo.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-03-09T02:00:00.000Z')),
    };
    await DialogPersistence.saveDialogMetadata(sourceId, sourceMeta);
    await writeLatest(sourceId, 1);

    const ts = formatUnifiedTimestamp(new Date('2026-03-09T02:01:00.000Z'));
    await DialogPersistence.appendEvent(sourceId, 1, {
      ts,
      type: 'gen_start_record',
      genseq: 1,
    });
    await DialogPersistence.appendEvent(sourceId, 1, {
      ts,
      type: 'human_text_record',
      genseq: 1,
      msgId: 'msg-1',
      content: 'bootstrap the environment',
      grammar: 'markdown',
      origin: 'user',
    });
    await DialogPersistence.appendEvent(sourceId, 1, {
      ts,
      type: 'agent_words_record',
      genseq: 1,
      content: 'starting probe',
    });
    await DialogPersistence.appendEvent(sourceId, 1, {
      ts,
      type: 'gen_finish_record',
      genseq: 1,
    });

    const sourceReminder: Reminder = materializeReminder({
      content: 'Remember to keep deployment notes in sync.',
      meta: {
        source: 'priming-test',
        sticky: true,
      },
      echoback: false,
    });
    await DialogPersistence._saveReminderState(sourceId, [sourceReminder], 'running');

    const pendingRecord: PendingSideDialogStateRecord = {
      sideDialogId: 'sub-pending-1',
      createdAt: ts,
      callName: 'tellaskSessionless',
      mentionList: ['@scribe'],
      tellaskContent: 'Investigate the environment',
      targetAgentId: 'scribe',
      callId: 'call-pending-1',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'B',
    };
    await DialogPersistence.savePendingSideDialogs(
      sourceId,
      [pendingRecord],
      toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      'running',
    );

    const saved = await saveDialogCourseAsIndividualPrimingScript({
      dialogId: sourceId,
      status: 'running',
      course: 1,
      slug: primingSlug,
    });

    const savedMarkdown = await fs.readFile(saved.path, 'utf-8');
    const frontmatter = parseTopLevelFrontmatter(savedMarkdown);
    assert.ok(Array.isArray(frontmatter['reminders']), 'priming frontmatter must export reminders');
    assert.equal(
      savedMarkdown.includes('pendingSideDialogs'),
      false,
      'priming markdown must not export pending runtime state',
    );

    const replayId = new DialogID('11/22/priming-replay');
    const replayStore: DialogStore = new DiskFileDialogStore(replayId);
    const replayDialog = new MainDialog(replayStore, 'plans/demo.tsk', replayId, 'rtws');
    replayDialog.setPersistenceStatus('running');
    await DialogPersistence.saveDialogMetadata(replayId, {
      id: replayId.selfId,
      agentId: 'rtws',
      taskDocPath: 'plans/demo.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-03-09T02:02:00.000Z')),
    });
    await writeLatest(replayId, 1);

    await applyPrimingScriptsToDialog({
      dialog: replayDialog,
      agentId: 'rtws',
      status: 'running',
      priming: {
        scriptRefs: [saved.script.ref],
        showInUi: true,
      },
    });

    assert.equal(replayDialog.reminders.length, 1, 'replayed dialog must restore reminder state');
    assert.equal(replayDialog.reminders[0]?.content, sourceReminder.content);
    assert.deepEqual(replayDialog.reminders[0]?.meta, sourceReminder.meta);
    assert.equal(replayDialog.reminders[0]?.echoback, false);

    const persistedReminders = await DialogPersistence.loadReminderState(replayId, 'running');
    assert.equal(
      persistedReminders.length,
      1,
      'replayed priming must persist restored reminder state to reminders.json',
    );
    assert.equal(persistedReminders[0]?.content, sourceReminder.content);
    assert.deepEqual(persistedReminders[0]?.meta, sourceReminder.meta);
    assert.equal(persistedReminders[0]?.echoback, false);

    const persistedPending = await DialogPersistence.loadPendingSideDialogs(replayId, 'running');
    assert.deepEqual(
      persistedPending,
      [],
      'replayed priming must keep pending runtime state dropped',
    );

    const replayedEvents = await DialogPersistence.readCourseEvents(replayId, 1, 'running');
    assert.equal(replayedEvents[0]?.type, 'reminders_reconciled_record');
    assert.equal(
      replayedEvents.some((event) => event.type === 'pending_sideDialogs_reconciled_record'),
      false,
      'replayed priming must not append pending runtime state records',
    );
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
