import assert from 'node:assert/strict';

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import type {
  LlmBatchResult,
  LlmGenerator,
  LlmRequestContext,
  LlmStreamReceiver,
  LlmStreamResult,
} from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const API_TYPE = 'test-empty-recovery';
const RECOVERED_TEXT = 'Recovered after the retry-stop diligence push.';
const TRIGGER_ID = 'kernel-driver-retry-recovery-diligence-push-with-keep-going-disabled';
const evidence = semanticEvidenceCollector('dominds-empty-recovery-');

class EmptyThenRecoverGen implements LlmGenerator {
  public readonly apiType = API_TYPE;

  public emptyAttempts = 0;
  public recoveryRequest?: { prompt: string; systemPrompt: string; tools: string[] };

  private readonly usage: LlmUsageStats = {
    kind: 'available',
    promptTokens: 1000,
    completionTokens: 0,
    totalTokens: 1000,
  };

  async genToReceiver(
    _providerConfig: ProviderConfig,
    _agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    _requestContext: LlmRequestContext,
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    _genseq: number,
    _abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const lastPrompt = [...context]
      .reverse()
      .find((msg): msg is Extract<ChatMessage, { type: 'prompting_msg' }> => {
        return msg.type === 'prompting_msg';
      });
    // The provider boundary observes a new input identity, not English prompt wording
    // or the runtime's uncommitted persistence buffers. Origin is checked after execution.
    if (lastPrompt && lastPrompt.msgId !== TRIGGER_ID) {
      this.recoveryRequest = {
        prompt: lastPrompt.content,
        systemPrompt,
        tools: funcTools.map((tool) => tool.name),
      };
      await receiver.sayingStart();
      await receiver.sayingChunk(RECOVERED_TEXT);
      await receiver.sayingFinish();
      // Complete through the runtime's protocol instead of leaving a required-tool round open.
      await receiver.funcCall(
        'retry-recovery-answer',
        'answerHuman',
        JSON.stringify({ answerContent: RECOVERED_TEXT }),
      );
      return { usage: this.usage, llmGenModel: 'default' };
    }

    this.emptyAttempts += 1;
    return { usage: this.usage, llmGenModel: 'default' };
  }

  async genMoreMessages(): Promise<LlmBatchResult> {
    throw new Error('EmptyThenRecoverGen only supports streaming mode');
  }
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      await writeStandardMinds(tmpRoot, {
        diligencePushMax: 0,
        providerApiType: API_TYPE,
        providerApiQuirks: ['same-context-empty-response'],
      });
      const gen = new EmptyThenRecoverGen();
      registerLlmGenerator(gen);

      try {
        const trigger = 'Hit a provider empty-response retry stop.';
        const dlg = await createMainDialog('tester');
        dlg.disableDiligencePush = false;
        dlg.diligencePushRemainingBudget = 0;

        await driveDialogStream(dlg, makeUserPrompt(trigger, TRIGGER_ID), true);

        assert.equal(gen.emptyAttempts, 5, 'expected same-context empty retry stop threshold');

        await waitFor(
          async () =>
            (await DialogPersistence.readCourseEvents(dlg.id, 1, dlg.status)).some(
              (event) => event.type === 'human_text_record' && event.origin === 'diligence_push',
            ),
          2_000,
          'the scheduled recovery round to persist its prompt',
        );
        await waitForAllDialogsUnlocked(dlg, 2_000);

        const events = await DialogPersistence.readCourseEvents(dlg.id, 1, dlg.status);
        assert.equal(
          events.filter(
            (event) => event.type === 'human_text_record' && event.origin === 'diligence_push',
          ).length,
          1,
          'the retry-stop exception schedules one recovery input',
        );
        assert.equal(dlg.diligencePushRemainingBudget, 0);
        const persistedDiligencePrompt = events
          .filter((event) => event.type === 'human_text_record')
          .find((event) => event.origin === 'diligence_push');
        assert.ok(
          persistedDiligencePrompt,
          'expected retry recovery prompt to persist with diligence_push origin',
        );
        assert.ok(
          dlg.msgs.some(
            (msg) => msg.type === 'prompting_msg' && msg.msgId === persistedDiligencePrompt.msgId,
          ),
          'the persisted recovery prompt must be supplied to the generator',
        );

        const recovered = dlg.msgs.find(
          (msg) =>
            msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === RECOVERED_TEXT,
        );
        assert.ok(recovered, 'expected the recovery prompt to drive a successful follow-up round');
        const answers = await DialogPersistence.loadAnswersToHumanState(dlg.id, dlg.status);
        assert.equal(
          answers.length,
          1,
          'the recovered round should deliver one answer to the human',
        );
        assert.equal(answers[0]?.content, RECOVERED_TEXT);
        assert.ok(gen.recoveryRequest);
        assert.equal(
          gen.recoveryRequest.prompt,
          persistedDiligencePrompt.content,
          'persisted recovery input reaches the provider with byte fidelity',
        );
        evidence.record({
          id: `empty-stop-zero-budget-${language}`,
          scenario:
            'Five real provider-boundary empty responses trigger the configured retry-stop recovery with normal diligence budget zero.',
          businessValue:
            'Allow the bounded recovery exception to obtain an actual answer while preserving the normal keep-going budget boundary.',
          context: {
            language,
            streaming: true,
            configuredDiligenceMax: 0,
            actualEmptyAttempts: gen.emptyAttempts,
            actualHumanAnswers: answers.length,
            availableTools: JSON.stringify(gen.recoveryRequest.tools),
            scope:
              'Streaming empty-response API quirk; batch and live providers are not exercised here.',
          },
          reviewQuestions: [
            'Does the actual recovery input give a useful next step after empty responses without treating normal continuation budget as unlimited?',
            'Is the recovery guidance compatible with the real request system prompt and available capabilities?',
          ],
          actualText: JSON.stringify(gen.recoveryRequest, null, 2),
        });
      } finally {
        unregisterLlmGenerator(API_TYPE);
      }
    }
  });

  await evidence.write();

  console.log('kernel-driver retry recovery diligence push with keep-going disabled: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver retry recovery diligence push with keep-going disabled: FAIL\n${message}`,
  );
  process.exit(1);
});
