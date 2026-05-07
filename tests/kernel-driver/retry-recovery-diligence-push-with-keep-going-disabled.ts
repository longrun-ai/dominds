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
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';

import { createMainDialog, makeUserPrompt, withTempRtws, writeStandardMinds } from './helpers';

const API_TYPE = 'test-empty-recovery';
const RECOVERED_TEXT = 'Recovered after the retry-stop diligence push.';

class EmptyThenRecoverGen implements LlmGenerator {
  public readonly apiType = API_TYPE;

  public emptyAttempts = 0;

  private readonly usage: LlmUsageStats = {
    kind: 'available',
    promptTokens: 1000,
    completionTokens: 0,
    totalTokens: 1000,
  };

  async genToReceiver(
    _providerConfig: ProviderConfig,
    _agent: Team.Member,
    _systemPrompt: string,
    _funcTools: FuncTool[],
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
    if (lastPrompt?.content.includes('runtime auto-continue instruction')) {
      await receiver.sayingStart();
      await receiver.sayingChunk(RECOVERED_TEXT);
      await receiver.sayingFinish();
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
    setWorkLanguage('en');
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

      await driveDialogStream(
        dlg,
        makeUserPrompt(
          trigger,
          'kernel-driver-retry-recovery-diligence-push-with-keep-going-disabled',
        ),
        true,
      );

      assert.equal(gen.emptyAttempts, 5, 'expected same-context empty retry stop threshold');

      const diligencePrompt = dlg.msgs.find(
        (msg) =>
          msg.type === 'prompting_msg' &&
          msg.role === 'user' &&
          msg.content.includes('runtime auto-continue instruction'),
      );
      assert.ok(diligencePrompt, 'expected retry recovery to insert the diligence push prompt');

      const recovered = dlg.msgs.find(
        (msg) =>
          msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === RECOVERED_TEXT,
      );
      assert.ok(recovered, 'expected the recovery prompt to drive a successful follow-up round');
    } finally {
      unregisterLlmGenerator(API_TYPE);
    }
  });

  console.log('kernel-driver retry recovery diligence push with keep-going disabled: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver retry recovery diligence push with keep-going disabled: FAIL\n${message}`,
  );
  process.exit(1);
});
