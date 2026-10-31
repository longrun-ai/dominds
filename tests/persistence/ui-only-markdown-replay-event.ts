import { toRootCourseNumber, toRootGenerationSeqNumber } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';

import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    const dlg = await createMainDialog('tester');

    await dlg.persistUiOnlyMarkdown('Budget exhausted. Please continue manually.', 1);
    await DialogPersistence.appendEvent(
      dlg.id,
      dlg.currentCourse,
      {
        ts: '2026-05-10 00:23:15',
        type: 'tellask_anchor_record',
        anchorRole: 'assignment',
        callId: 'tellask:11',
        genseq: 93,
        rootCourse: toRootCourseNumber(6),
        rootGenseq: toRootGenerationSeqNumber(0),
      },
      dlg.status,
    );

    const replayedPackets: unknown[] = [];
    const replayWs = {
      readyState: 1,
      send(payload: string): void {
        replayedPackets.push(JSON.parse(payload));
      },
    } as unknown as import('ws').WebSocket;

    const replayStore = new DiskFileDialogStore(dlg.id);
    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...data: unknown[]): void => {
      warnLines.push(data.map(String).join(' '));
    };
    try {
      await replayStore.sendDialogEventsDirectly(
        replayWs,
        dlg,
        dlg.currentCourse,
        dlg.currentCourse,
        dlg.status,
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      replayedPackets.filter((packet) => {
        if (typeof packet !== 'object' || packet === null) return false;
        const evt = packet as { type?: unknown; content?: unknown };
        return (
          evt.type === 'ui_only_markdown_evt' &&
          evt.content === 'Budget exhausted. Please continue manually.'
        );
      }).length,
      1,
      'expected ui_only_markdown_record replay to emit exactly one ui_only_markdown_evt',
    );

    assert.equal(
      replayedPackets.filter((packet) => {
        if (typeof packet !== 'object' || packet === null) return false;
        const evt = packet as { type?: unknown };
        return (
          evt.type === 'markdown_start_evt' ||
          evt.type === 'markdown_chunk_evt' ||
          evt.type === 'markdown_finish_evt'
        );
      }).length,
      0,
      'expected ui_only_markdown_record replay to stop emitting generic markdown stream events',
    );

    assert.deepEqual(
      warnLines,
      [],
      'replaying the supported metadata anchor must not produce warnings',
    );
  });

  console.log('persistence ui-only-markdown replay event: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`persistence ui-only-markdown replay event: FAIL\n${message}`);
  process.exit(1);
});
