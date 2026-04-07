import assert from 'node:assert/strict';

import { DiskFileDialogStore } from '../../main/persistence';

import { createRootDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    const dlg = await createRootDialog('tester');

    await dlg.persistUiOnlyMarkdown('Budget exhausted. Please continue manually.', 1);

    const replayedPackets: unknown[] = [];
    const replayWs = {
      readyState: 1,
      send(payload: string): void {
        replayedPackets.push(JSON.parse(payload));
      },
    } as unknown as import('ws').WebSocket;

    const replayStore = new DiskFileDialogStore(dlg.id);
    await replayStore.sendDialogEventsDirectly(
      replayWs,
      dlg,
      dlg.currentCourse,
      dlg.currentCourse,
      dlg.status,
    );

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
  });

  console.log('persistence ui-only-markdown replay event: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`persistence ui-only-markdown replay event: FAIL\n${message}`);
  process.exit(1);
});
