import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';

import { requireRecordingGlobalDialogEventRecorder } from '../../main/bootstrap/global-dialog-event-broadcaster';
import { setDialogDisplayState } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { messageProvider } from '../helpers/message-provider';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeStandardMinds,
} from '../kernel-driver/helpers';

async function metadataPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await metadataPaths(full)));
    else if (entry.isFile() && entry.name === 'dialog.yaml') paths.push(full);
  }
  return paths;
}

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-typeb-dedupe';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    const recorder = requireRecordingGlobalDialogEventRecorder('typeb-dedupe');
    const eventOffset = recorder.snapshot().length;
    const sessionSlug = 'dupe-session';
    const bodies = ['assignment-data-1', 'assignment-data-2', 'fresh-assignment-data-3'];
    const triggers = ['user-input-data-a', 'user-input-data-b'];
    const calls = ['dupe-typeb-call-1', 'dupe-typeb-call-2', 'dupe-typeb-call-3'];
    const workerIds: string[] = [];
    const workerRequests: Array<{
      id: string;
      genseq: number;
      assignmentBodies: string[];
      context: unknown;
    }> = [];
    const callerRequests: unknown[] = [];
    const sent = new Set<string>();
    const repliedObligations = new Set<string>();
    const consumed = new Map<string, () => void>();
    const deliveries = new Map(
      calls.slice(1).map((id) => [id, new Promise<void>((resolve) => consumed.set(id, resolve))]),
    );
    const provider = messageProvider(apiType, async ({ request, agent, context, genseq }) => {
      const call = (id: string, name: string, args: Record<string, unknown>) => ({
        type: 'func_call_msg' as const,
        role: 'assistant' as const,
        genseq,
        id,
        name,
        arguments: JSON.stringify(args),
      });
      if (request.dialogSelfId === root.id.selfId) {
        callerRequests.push({ genseq, context });
        const phase = context.some(
          (message) =>
            message.type === 'prompting_msg' &&
            message.role === 'user' &&
            message.content === triggers[1],
        )
          ? triggers[1]
          : triggers[0];
        if (!sent.has(phase)) {
          sent.add(phase);
          const indices = phase === triggers[0] ? [0, 1] : [2];
          return {
            messages: indices.map((index) =>
              call(calls[index], 'tellask', {
                targetAgentId: 'pangu',
                sessionSlug,
                tellaskContent: bodies[index],
              }),
            ),
            usage: { kind: 'unavailable' },
          };
        }
        for (const result of context.filter((message) => message.type === 'tellask_result_msg')) {
          if (result.callId === calls[1] || result.callId === calls[2]) {
            assert.equal(result.status, 'completed');
            const index = result.callId === calls[1] ? 0 : 1;
            assert.ok(result.content.includes(`worker-reply-data-${index}`));
            consumed.get(result.callId)?.();
          }
        }
        return {
          messages: [
            { type: 'saying_msg', role: 'assistant', genseq, content: `caller-output-${phase}` },
          ],
          usage: { kind: 'unavailable' },
        };
      }
      assert.equal(agent.id, 'pangu');
      const id = request.dialogSelfId;
      if (!workerIds.includes(id)) workerIds.push(id);
      const index = workerIds.indexOf(id);
      assert.ok(index < 2);
      // Given payloads can reach the reused worker in separate scheduling turns.
      const assignmentBodies = bodies.filter((body) =>
        context.some((message) => 'content' in message && message.content.includes(body)),
      );
      assert.ok(assignmentBodies.length > 0);
      workerRequests.push({ id, genseq, assignmentBodies, context });
      const side = root.lookupDialog(id);
      assert.ok(side);
      const obligation = await DialogPersistence.loadActiveTellaskReplyObligation(
        side.id,
        side.status,
      );
      const key = obligation ? `${id}:${obligation.targetCallId}` : undefined;
      const shouldReply = key !== undefined && !repliedObligations.has(key);
      if (key && shouldReply) repliedObligations.add(key);
      return {
        messages: shouldReply
          ? [
              call(`worker-reply-${id}-${genseq}`, 'replyTellask', {
                replyContent: `worker-reply-data-${index}`,
              }),
            ]
          : [
              {
                type: 'saying_msg',
                role: 'assistant',
                genseq,
                content: `worker-idle-data-${index}`,
              },
            ],
        usage: { kind: 'unavailable' },
      };
    });
    registerLlmGenerator(provider);
    try {
      await driveDialogStream(root, makeUserPrompt(triggers[0], 'typeb-first-input'), true);
      await deliveries.get(calls[1]);
      await root.withLock(async () => undefined);
      provider.assertNoErrors();
      const first = root.lookupSideDialog('pangu', sessionSlug);
      assert.ok(first);
      await first.withLock(async () => undefined);
      assert.deepEqual(
        await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status),
        [],
      );
      const firstEvents = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
      const routedCalls = firstEvents.filter((event) => event.type === 'tellask_callee_record');
      assert.deepEqual(routedCalls.map((event) => event.callId).sort(), calls.slice(0, 2).sort());
      assert.ok(routedCalls.every((event) => event.calleeDialogId === first.id.selfId));
      assert.equal(new Set(routedCalls.map((event) => event.genseq)).size, 1);
      assert.equal(
        firstEvents.filter((event) => event.type === 'agent_words_record').at(-1)?.content,
        `caller-output-${triggers[0]}`,
      );
      // Scope: registry replacement under a durable dead marker after completed delivery.
      // The WebSocket user-declaration/cancellation pipeline has its own broader contract.
      await setDialogDisplayState(first.id, {
        kind: 'dead',
        reason: { kind: 'declared_by_user' },
      });
      await driveDialogStream(root, makeUserPrompt(triggers[1], 'typeb-second-input'), true);
      await deliveries.get(calls[2]);
      await root.withLock(async () => undefined);
      provider.assertNoErrors();
      const second = root.lookupSideDialog('pangu', sessionSlug);
      assert.ok(second);
      await second.withLock(async () => undefined);
      assert.notEqual(second.id.selfId, first.id.selfId);
      assert.deepEqual(workerIds, [first.id.selfId, second.id.selfId]);
      assert.ok(
        workerRequests.some(
          (request) =>
            request.id === first.id.selfId && request.assignmentBodies.includes(bodies[1]),
        ),
      );
      const freshRequests = workerRequests.filter((request) => request.id === second.id.selfId);
      assert.ok(freshRequests.length > 0);
      assert.ok(
        freshRequests.every(
          (request) =>
            request.assignmentBodies.includes(bodies[2]) &&
            !request.assignmentBodies.includes(bodies[0]) &&
            !request.assignmentBodies.includes(bodies[1]),
        ),
      );
      assert.equal(
        (await DialogPersistence.loadDialogLatest(first.id, first.status))?.executionMarker?.kind,
        'dead',
      );
      assert.deepEqual(
        await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status),
        [],
      );
      const events = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
      assert.equal(
        events.filter((event) => event.type === 'agent_words_record').at(-1)?.content,
        `caller-output-${triggers[1]}`,
      );
      for (const [callId, side] of [
        [calls[1], first],
        [calls[2], second],
      ] as const) {
        const results = events
          .filter((event) => event.type === 'tellask_result_record')
          .filter((event) => event.callId === callId);
        assert.equal(results.length, 1);
        assert.equal(results[0].status, 'completed');
        assert.equal(results[0].route?.calleeDialogId, side.id.selfId);
      }
      const sideRoot = path.join(rtws, '.dialogs', 'run', root.id.rootId, 'sideDialogs');
      const metadata: unknown[] = [];
      for (const file of await metadataPaths(sideRoot))
        metadata.push(yaml.parse(await fs.readFile(file, 'utf8')));
      assert.deepEqual(
        metadata
          .map((value) => {
            assert.ok(
              typeof value === 'object' &&
                value !== null &&
                'agentId' in value &&
                'sessionSlug' in value &&
                'id' in value,
            );
            assert.equal(value.agentId, 'pangu');
            assert.equal(value.sessionSlug, sessionSlug);
            return value.id;
          })
          .sort(),
        [first.id.selfId, second.id.selfId].sort(),
      );
      const registry: unknown = yaml.parse(
        await fs.readFile(
          path.join(rtws, '.dialogs', 'run', root.id.rootId, 'registry.yaml'),
          'utf8',
        ),
      );
      assert.ok(typeof registry === 'object' && registry !== null && 'entries' in registry);
      assert.ok(Array.isArray(registry.entries));
      assert.deepEqual(
        registry.entries.map((entry: unknown) => {
          assert.ok(
            typeof entry === 'object' &&
              entry !== null &&
              'agentId' in entry &&
              'sessionSlug' in entry &&
              'sideDialogId' in entry,
          );
          return {
            agentId: entry.agentId,
            sessionSlug: entry.sessionSlug,
            sideDialogId: entry.sideDialogId,
          };
        }),
        [{ agentId: 'pangu', sessionSlug, sideDialogId: second.id.selfId }],
      );
      const runtimeEvents = recorder.snapshot().slice(eventOffset);
      assert.deepEqual(
        runtimeEvents.filter(
          (event) => event.type === 'dlg_touched_evt' && event.sourceType === 'stream_error_evt',
        ),
        [],
      );
      await fs.writeFile(
        path.join(rtws, 'typeb-dedupe-observations.json'),
        JSON.stringify(
          {
            scope:
              'Completed same-generation registered assignments, correlated delivery, history retention and replacement under a durable dead marker; not the WebSocket cancellation pipeline or prose meaning.',
            rootId: root.id.selfId,
            workerIds,
            workerRequests,
            callerRequests,
            firstEvents,
            events,
            metadata,
            registry,
            runtimeEvents,
          },
          null,
          2,
        ),
      );
    } finally {
      globalDialogRegistry.unregister(root.id.rootId);
      unregisterLlmGenerator(apiType);
    }
  });
  console.log(
    'registered same-generation calls share one worker; completed dead session is replaced with correlated delivery: passed',
  );
}
// A pending delivery promise must not let Node exit zero before this scenario finishes.
let completed = false;
process.once('beforeExit', () => {
  if (!completed) {
    console.error('Registered-session scenario ended before its completion boundary');
    process.exitCode = 1;
  }
});
main()
  .then(() => {
    completed = true;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
