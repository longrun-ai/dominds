import assert from 'node:assert/strict';
import { recordDialogEvents } from '../helpers/dialog-events';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { emitThinkingEvents } from '../../main/llm/kernel-driver/events';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

function isThinkingChunkEvent(
  event: TypedDialogEvent,
): event is Extract<TypedDialogEvent, { type: 'thinking_chunk_evt' }> {
  return event.type === 'thinking_chunk_evt';
}

function isThinkingFinishEvent(
  event: TypedDialogEvent,
): event is Extract<TypedDialogEvent, { type: 'thinking_finish_evt' }> {
  return event.type === 'thinking_finish_evt';
}

function parseReplayPacket(payload: string): TypedDialogEvent {
  return JSON.parse(payload) as TypedDialogEvent;
}

function isThinkingEvent(
  event: TypedDialogEvent,
): event is Extract<
  TypedDialogEvent,
  { type: 'thinking_start_evt' | 'thinking_chunk_evt' | 'thinking_finish_evt' }
> {
  return (
    event.type === 'thinking_start_evt' ||
    event.type === 'thinking_chunk_evt' ||
    event.type === 'thinking_finish_evt'
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    const dlg = await createMainDialog('tester');
    const reasoning: ReasoningPayload = {
      summary: [],
      encrypted_content: 'encrypted-reasoning-payload',
      metadata: {
        itemId: 'rs_123',
        itemType: 'reasoning',
        status: 'completed',
      },
    };
    const liveSubChan = recordDialogEvents(dlg);

    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { displayState: { kind: 'proceeding' } },
    }));
    await dlg.notifyGeneratingStart();
    await emitThinkingEvents(dlg, '', reasoning);

    const liveEvents = (await liveSubChan.finish())
      .filter(isThinkingEvent)
      .filter((event) => event.genseq === dlg.activeGenSeq && event.course === dlg.currentCourse);
    assert.equal(
      liveEvents.filter((event) => event.type === 'thinking_start_evt').length,
      1,
      'expected encrypted-only reasoning to emit one live thinking_start_evt',
    );
    assert.equal(
      liveEvents.filter(isThinkingChunkEvent).length,
      0,
      'expected encrypted-only reasoning to skip live thinking_chunk_evt',
    );
    assert.deepEqual(
      liveEvents.map((event) => event.type),
      ['thinking_start_evt', 'thinking_finish_evt'],
    );
    const liveFinishEvents = liveEvents.filter(isThinkingFinishEvent);
    assert.equal(
      liveFinishEvents.length,
      1,
      'expected encrypted-only reasoning to emit one live thinking_finish_evt',
    );
    assert.equal(
      liveFinishEvents[0]?.reasoning?.encrypted_content,
      reasoning.encrypted_content,
      'expected live thinking_finish_evt to carry encrypted_content',
    );
    assert.deepEqual(
      liveFinishEvents[0]?.reasoning?.metadata,
      reasoning.metadata,
      'expected live thinking_finish_evt to carry reasoning metadata',
    );

    const persistedEvents = await DialogPersistence.loadCourseEvents(
      dlg.id,
      dlg.currentCourse,
      dlg.status,
    );
    const persistedThoughts = persistedEvents.filter(
      (event): event is Extract<typeof event, { type: 'agent_thought_record' }> =>
        event.type === 'agent_thought_record' && event.genseq === dlg.activeGenSeq,
    );
    assert.equal(
      persistedThoughts.length,
      1,
      'expected encrypted-only reasoning to persist exactly one agent_thought_record',
    );
    assert.equal(
      persistedThoughts[0]?.content,
      '',
      'expected encrypted-only reasoning to persist empty visible content',
    );
    assert.equal(
      persistedThoughts[0]?.reasoning?.encrypted_content,
      reasoning.encrypted_content,
      'expected persisted reasoning to preserve encrypted_content',
    );
    assert.deepEqual(
      persistedThoughts[0]?.reasoning?.metadata,
      reasoning.metadata,
      'expected persisted reasoning to preserve metadata',
    );

    const replayedPackets: TypedDialogEvent[] = [];
    const replayWs = {
      readyState: 1,
      send(payload: string): void {
        replayedPackets.push(parseReplayPacket(payload));
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

    const replayedThinkingEvents = replayedPackets
      .filter(isThinkingEvent)
      .filter((event) => event.genseq === dlg.activeGenSeq && event.course === dlg.currentCourse);
    assert.equal(
      replayedThinkingEvents.filter((event) => event.type === 'thinking_start_evt').length,
      1,
      'expected replay to emit one thinking_start_evt for encrypted-only reasoning',
    );
    assert.equal(
      replayedThinkingEvents.filter(isThinkingChunkEvent).length,
      0,
      'expected replay to skip thinking_chunk_evt for encrypted-only reasoning',
    );
    assert.deepEqual(
      replayedThinkingEvents.map((event) => event.type),
      ['thinking_start_evt', 'thinking_finish_evt'],
    );
    const replayedFinishEvents = replayedThinkingEvents.filter(isThinkingFinishEvent);
    assert.equal(
      replayedFinishEvents.length,
      1,
      'expected replay to emit one thinking_finish_evt for encrypted-only reasoning',
    );
    assert.equal(
      replayedFinishEvents[0]?.reasoning?.encrypted_content,
      reasoning.encrypted_content,
      'expected replayed thinking_finish_evt to carry encrypted_content',
    );
    assert.deepEqual(
      replayedFinishEvents[0]?.reasoning?.metadata,
      reasoning.metadata,
      'expected replayed thinking_finish_evt to carry metadata',
    );

    const emptyBoundaryDlg = await createMainDialog('tester');
    const emptyBoundarySubChan = recordDialogEvents(emptyBoundaryDlg);
    await DialogPersistence.mutateDialogLatest(emptyBoundaryDlg.id, () => ({
      kind: 'patch',
      patch: { displayState: { kind: 'proceeding' } },
    }));
    await emptyBoundaryDlg.notifyGeneratingStart();
    await emptyBoundaryDlg.thinkingStart();
    await emptyBoundaryDlg.thinkingFinish();

    const liveEmptyBoundaryEvents = (await emptyBoundarySubChan.finish())
      .filter(isThinkingEvent)
      .filter(
        (event) =>
          event.genseq === emptyBoundaryDlg.activeGenSeq &&
          event.course === emptyBoundaryDlg.currentCourse,
      );
    assert.equal(
      liveEmptyBoundaryEvents.filter((event) => event.type === 'thinking_start_evt').length,
      1,
      'expected explicit empty thinking boundary to emit one live thinking_start_evt',
    );
    assert.equal(
      liveEmptyBoundaryEvents.filter(isThinkingChunkEvent).length,
      0,
      'expected explicit empty thinking boundary to skip live thinking_chunk_evt',
    );
    assert.equal(
      liveEmptyBoundaryEvents.filter(isThinkingFinishEvent).length,
      1,
      'expected explicit empty thinking boundary to emit one live thinking_finish_evt',
    );

    assert.deepEqual(
      liveEmptyBoundaryEvents.map((event) => event.type),
      ['thinking_start_evt', 'thinking_finish_evt'],
    );
    const emptyBoundaryPersistedEvents = await DialogPersistence.loadCourseEvents(
      emptyBoundaryDlg.id,
      emptyBoundaryDlg.currentCourse,
      emptyBoundaryDlg.status,
    );
    const persistedEmptyBoundaryThoughts = emptyBoundaryPersistedEvents.filter(
      (event): event is Extract<typeof event, { type: 'agent_thought_record' }> =>
        event.type === 'agent_thought_record' && event.genseq === emptyBoundaryDlg.activeGenSeq,
    );
    assert.equal(
      persistedEmptyBoundaryThoughts.length,
      1,
      'expected explicit empty thinking boundary to persist one empty agent_thought_record',
    );
    assert.equal(
      persistedEmptyBoundaryThoughts[0]?.content,
      '',
      'expected explicit empty thinking boundary to persist empty content',
    );
    assert.equal(
      persistedEmptyBoundaryThoughts[0]?.reasoning,
      undefined,
      'expected explicit empty thinking boundary to persist no synthetic reasoning payload',
    );

    const emptyBoundaryReplayPackets: TypedDialogEvent[] = [];
    const emptyBoundaryReplayWs = {
      readyState: 1,
      send(payload: string): void {
        emptyBoundaryReplayPackets.push(parseReplayPacket(payload));
      },
    } as unknown as import('ws').WebSocket;
    await new DiskFileDialogStore(emptyBoundaryDlg.id).sendDialogEventsDirectly(
      emptyBoundaryReplayWs,
      emptyBoundaryDlg,
      emptyBoundaryDlg.currentCourse,
      emptyBoundaryDlg.currentCourse,
      emptyBoundaryDlg.status,
    );
    const replayedEmptyBoundaryEvents = emptyBoundaryReplayPackets
      .filter(isThinkingEvent)
      .filter(
        (event) =>
          event.genseq === emptyBoundaryDlg.activeGenSeq &&
          event.course === emptyBoundaryDlg.currentCourse,
      );
    assert.equal(
      replayedEmptyBoundaryEvents.filter((event) => event.type === 'thinking_start_evt').length,
      1,
      'expected explicit empty thinking boundary replay to emit one thinking_start_evt',
    );
    assert.equal(
      replayedEmptyBoundaryEvents.filter(isThinkingChunkEvent).length,
      0,
      'expected explicit empty thinking boundary replay to skip thinking_chunk_evt',
    );
    assert.equal(
      replayedEmptyBoundaryEvents.filter(isThinkingFinishEvent).length,
      1,
      'expected explicit empty thinking boundary replay to emit one thinking_finish_evt',
    );

    assert.deepEqual(
      replayedEmptyBoundaryEvents.map((event) => event.type),
      ['thinking_start_evt', 'thinking_finish_evt'],
    );
    const synthesizedEmptyDlg = await createMainDialog('tester');
    await DialogPersistence.mutateDialogLatest(synthesizedEmptyDlg.id, () => ({
      kind: 'patch',
      patch: { displayState: { kind: 'proceeding' } },
    }));
    await synthesizedEmptyDlg.notifyGeneratingStart();
    const synthesizedLive = recordDialogEvents(synthesizedEmptyDlg);
    await emitThinkingEvents(synthesizedEmptyDlg, '', undefined);
    assert.deepEqual((await synthesizedLive.finish()).filter(isThinkingEvent), []);
    const synthesizedEvents = await DialogPersistence.loadCourseEvents(
      synthesizedEmptyDlg.id,
      synthesizedEmptyDlg.currentCourse,
      synthesizedEmptyDlg.status,
    );
    assert.equal(
      synthesizedEvents.some((event) => event.type === 'agent_thought_record'),
      false,
      'expected helper empty content without reasoning to avoid synthesizing agent_thought_record',
    );
  });

  console.log('persistence thinking reasoning replay event: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`persistence thinking reasoning replay event: FAIL\n${message}`);
  process.exit(1);
});
