import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { MockGen } from '../../main/llm/gen/mock';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { Team } from '../../main/team';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeMockDb, writeStandardMinds } from './helpers';

const evidence = semanticEvidenceCollector('dominds-mock-contract-');
function recordingReceiver() {
  const outputs: Array<{
    kind: string;
    content?: string;
    id?: string;
    name?: string;
    args?: string;
  }> = [];
  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {
      outputs.push({ kind: 'thinking-start' });
    },
    thinkingChunk: async (content) => {
      outputs.push({ kind: 'thinking', content });
    },
    thinkingFinish: async () => {},
    sayingStart: async () => {
      outputs.push({ kind: 'saying-start' });
    },
    sayingChunk: async (content) => {
      outputs.push({ kind: 'saying', content });
    },
    sayingFinish: async () => {},
    funcCall: async (id, name, args) => {
      outputs.push({ kind: 'call', id, name, args });
    },
  };
  return { receiver, outputs };
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const agent = (await Team.load()).getMember('tester');
    assert.ok(agent);
    const request = { dialogSelfId: 'mock-contract-dialog', dialogRootId: 'mock-contract-dialog' };
    const directory = path.join(rtws, 'mock-contract-data');
    await fs.mkdir(directory);
    const provider: ProviderConfig = {
      name: 'Controlled mock',
      apiType: 'mock',
      baseUrl: directory,
      apiKeyEnvVar: 'UNUSED_MOCK_KEY',
      models: { default: { name: 'Default' } },
    };
    const file = path.join(directory, 'default.yaml');
    const context: ChatMessage[] = [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 1,
        msgId: 'mock-input-data',
        grammar: 'markdown',
        content: 'unconfigured-input-data-7ad1',
      },
    ];
    const gen = new MockGen();
    for (const mode of ['stream', 'batch'] as const) {
      for (const failure of [
        'missing-file',
        'invalid-yaml',
        'invalid-entry',
        'invalid-tool',
        'invalid-call-list',
        'invalid-usage',
        'invalid-delay',
        'invalid-flag',
        'missing-response',
        'no-inferred-tool',
      ] as const) {
        const expectedCode =
          failure === 'missing-file'
            ? 'mock_database_unavailable'
            : failure === 'invalid-yaml' ||
                failure === 'invalid-entry' ||
                failure === 'invalid-tool' ||
                failure === 'invalid-call-list' ||
                failure === 'invalid-usage' ||
                failure === 'invalid-delay' ||
                failure === 'invalid-flag'
              ? 'mock_database_invalid'
              : 'mock_response_missing';
        if (failure === 'missing-file') await fs.rm(file, { force: true });
        else if (failure === 'invalid-yaml') await fs.writeFile(file, 'responses: [unterminated');
        else if (failure === 'invalid-entry')
          await fs.writeFile(file, 'responses:\n  - message: data-without-role-or-response\n');
        else if (failure === 'invalid-tool')
          await fs.writeFile(
            file,
            'responses:\n  - message: unconfigured-input-data-7ad1\n    role: user\n    response: output-before-invalid-call-data\n    funcCalls: [{name: \"\"}]\n',
          );
        else if (
          failure === 'invalid-call-list' ||
          failure === 'invalid-usage' ||
          failure === 'invalid-delay' ||
          failure === 'invalid-flag'
        ) {
          const fields = {
            'invalid-call-list':
              'invalidFuncCalls: {provider: openai-compatible, detail: invalid-container}',
            'invalid-usage': 'usage: {promptTokens: wrong-type}',
            'invalid-delay': 'delayMs: wrong-type',
            'invalid-flag': 'omitDefaultThinking: wrong-type',
          };
          await fs.writeFile(
            file,
            `responses:\n  - message: unconfigured-input-data-7ad1\n    role: user\n    response: output-before-invalid-field-data\n    ${fields[failure]}\n`,
          );
        } else await fs.writeFile(file, 'responses: []\n');
        const input =
          failure === 'no-inferred-tool'
            ? [
                {
                  type: 'saying_msg',
                  role: 'assistant',
                  genseq: 1,
                  content: 'candidate-data-8be2',
                } as const,
                {
                  type: 'prompting_msg' as const,
                  role: 'user' as const,
                  genseq: 1,
                  msgId: 'legacy-reminder-data',
                  grammar: 'markdown' as const,
                  content: '[Dominds send the Tellask reply now]\n\n`replyTellask`',
                },
              ]
            : context;
        const recording = recordingReceiver();
        let caught: unknown;
        try {
          if (mode === 'stream')
            await gen.genToReceiver(
              provider,
              agent,
              'system-data',
              [],
              request,
              input,
              recording.receiver,
              1,
            );
          else await gen.genMoreMessages(provider, agent, 'system-data', [], request, input, 1);
        } catch (error) {
          caught = error;
        }
        assert.ok(
          caught instanceof Error,
          `${mode}/${failure} rejects instead of generating a normal answer`,
        );
        assert.ok('code' in caught);
        assert.equal(caught.code, expectedCode);
        const disposition = gen.classifyFailure?.(caught);
        assert.equal(disposition?.kind, 'fatal');
        assert.equal(disposition?.code, expectedCode);
        assert.deepEqual(
          recording.outputs,
          [],
          'an invalid fixture emits no provider content or tool call',
        );
        evidence.record({
          id: `${mode}-${failure}`,
          scenario: `The mock ${mode} provider encountered ${failure}.`,
          businessValue:
            'Fail a broken local scenario before its diagnostics can be mistaken for a business answer or tool instruction.',
          context: {
            mode,
            failure,
            databasePath: file,
            structuredCode: expectedCode,
            input: JSON.stringify(input),
          },
          reviewQuestions: [
            'Does the full diagnostic accurately distinguish a fixture/database problem from an upstream business answer?',
            'Does it give enough context to repair the mock without pretending the requested work completed or implying that an unconfigured tool ran?',
          ],
          actualText: caught.message,
        });
      }
    }
    await fs.writeFile(
      file,
      'responses:\n  - message: "unconfigured-input-data-7ad1"\n    role: user\n    response: "configured-output-data-9cf3"\n    omitDefaultThinking: true\n    funcCalls:\n      - id: explicit-call-data\n        name: env_get\n        arguments: {key: EXPLICIT_MOCK_DATA}\n',
    );
    const recording = recordingReceiver();
    await gen.genToReceiver(
      provider,
      agent,
      'system-data',
      [],
      request,
      context,
      recording.receiver,
      2,
    );
    assert.equal(
      recording.outputs
        .filter((output) => output.kind === 'saying')
        .map((output) => output.content)
        .join(''),
      'configured-output-data-9cf3',
    );
    assert.deepEqual(
      recording.outputs.filter((output) => output.kind === 'call'),
      [
        {
          kind: 'call',
          id: 'explicit-call-data',
          name: 'env_get',
          args: '{"key":"EXPLICIT_MOCK_DATA"}',
        },
      ],
    );
    const batch = await gen.genMoreMessages(
      provider,
      agent,
      'system-data',
      [],
      request,
      context,
      2,
    );
    assert.equal(
      batch.messages.filter((message) => message.type === 'saying_msg')[0]?.content,
      'configured-output-data-9cf3',
    );
    assert.deepEqual(
      batch.messages
        .filter((message) => message.type === 'func_call_msg')
        .map((message) => ({ id: message.id, name: message.name, args: message.arguments })),
      [{ id: 'explicit-call-data', name: 'env_get', args: '{"key":"EXPLICIT_MOCK_DATA"}' }],
    );
    await fs.writeFile(
      file,
      'responses:\n  - message: unconfigured-input-data-7ad1\n    role: user\n    response: \"\"\n    omitDefaultThinking: true\n    streamError: injected-provider-error-data-a6d1\n',
    );
    for (const mode of ['stream', 'batch'] as const) {
      const recording = recordingReceiver();
      await assert.rejects(
        mode === 'stream'
          ? gen.genToReceiver(provider, agent, '', [], request, context, recording.receiver, 3)
          : gen.genMoreMessages(provider, agent, '', [], request, context, 3),
        (error: unknown) =>
          error instanceof Error &&
          error.message === 'injected-provider-error-data-a6d1' &&
          gen.classifyFailure(error) === undefined,
        'explicit injected provider failures remain errors for runtime failure policy',
      );
      assert.deepEqual(recording.outputs, []);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        mode === 'stream'
          ? gen.genToReceiver(
              provider,
              agent,
              '',
              [],
              request,
              context,
              recording.receiver,
              3,
              controller.signal,
            )
          : gen.genMoreMessages(provider, agent, '', [], request, context, 3, controller.signal),
      );
    }
  });
  for (const streaming of [true, false]) {
    await withTempRtws(async (rtws) => {
      await writeStandardMinds(rtws, { includePangu: true, streaming });
      await writeMockDb(rtws, []);
      const root = await createMainDialog();
      root.disableDiligencePush = true;
      const requester = await root.createSideDialog('pangu', ['@pangu'], 'requester-task-data', {
        callName: 'tellaskSessionless',
        originMemberId: root.agentId,
        askerDialogId: root.id.selfId,
        callId: `requester-${streaming}`,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        collectiveTargets: ['pangu'],
      });
      const callId = `askback-${streaming}`;
      const directive = {
        expectedReplyCallName: 'replyTellaskBack' as const,
        targetDialogId: requester.id.selfId,
        targetCallId: callId,
        tellaskContent: 'request-data-not-a-mock-entry',
      };
      await requester.persistTellaskCall(
        callId,
        'tellaskBack',
        JSON.stringify({ tellaskContent: directive.tellaskContent }),
        1,
      );
      await DialogPersistence.setActiveTellaskReplyObligation(root.id, directive);
      const recording = recordDialogEvents(root);
      await driveDialogStream(
        root,
        {
          content: directive.tellaskContent,
          msgId: `missing-fixture-${streaming}`,
          grammar: 'markdown',
          origin: 'runtime',
          tellaskReplyDirective: directive,
        },
        true,
      );
      const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(latest?.displayState?.kind, 'stopped');
      assert.equal(latest.executionMarker?.kind, 'interrupted');
      assert.deepEqual(await DialogPersistence.loadQuestions4HumanState(root.id, root.status), []);
      assert.deepEqual(
        await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
        directive,
      );
      const requesterEvents = await DialogPersistence.loadCourseEvents(
        requester.id,
        requester.currentCourse,
        requester.status,
      );
      assert.equal(
        requesterEvents.filter(
          (event) => event.type === 'tellask_result_record' && event.callId === callId,
        ).length,
        0,
        'fixture errors cannot complete an ask-back',
      );
      const events = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(events.filter((event) => event.type === 'agent_words_record').length, 0);
      assert.equal(events.filter((event) => event.type === 'func_call_record').length, 0);
      const live = await recording.finish();
      assert.equal(live.filter((event) => event.type === 'stream_error_evt').length, 1);
      evidence.record({
        id: `runtime-missing-response-${streaming ? 'stream' : 'batch'}`,
        scenario:
          'A real drive has a pending ask-back obligation but the mock database has no response.',
        businessValue:
          'Stop on a fixture failure while preserving collaboration responsibility for repair and continuation.',
        context: { streaming, obligationPreserved: true, formalResults: 0, assistantOutputs: 0 },
        reviewQuestions: [
          'Does the actual stopped display explain the fixture failure and offer accurate recovery without claiming completion?',
        ],
        actualText: JSON.stringify(latest.displayState, null, 2),
      });
    });
  }
  await evidence.write();
  console.log(
    'mock fixture errors reject and explicit responses preserve streaming/batch output: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
