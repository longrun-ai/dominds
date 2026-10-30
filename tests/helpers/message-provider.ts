import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import type { LlmBatchResult, LlmGenerator, LlmRequestContext } from '../../main/llm/gen';
import type { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';

export type MessageProviderRequest = Readonly<{
  provider: ProviderConfig;
  agent: Team.Member;
  systemPrompt: string;
  tools: readonly FuncTool[];
  request: LlmRequestContext;
  context: readonly ChatMessage[];
  genseq: number;
  streaming: boolean;
  abortSignal?: AbortSignal;
}>;

/** Message-only fixture boundary; provider-native metadata/side channels need their own fixtures. */
export function messageProvider(
  apiType: string,
  generate: (request: MessageProviderRequest) => LlmBatchResult | Promise<LlmBatchResult>,
): LlmGenerator & { assertNoErrors(): void } {
  let failed = false;
  let failure: unknown;
  const output = async (request: MessageProviderRequest): Promise<LlmBatchResult> => {
    const result = await generate(request);
    if (result.outputs !== undefined)
      throw new Error('This message-only fixture does not implement provider side-channel outputs');
    return result;
  };
  return {
    apiType,
    assertNoErrors() {
      if (failed) throw failure;
    },
    // An assertion or missing fixture phase must fail the scenario, not enter transport retries.
    classifyFailure(error) {
      failed = true;
      failure = error;
      return {
        kind: 'fatal',
        code: 'test_provider_failure',
        message: error instanceof Error ? error.message : String(error),
      };
    },
    async genMoreMessages(
      provider,
      agent,
      systemPrompt,
      tools,
      request,
      context,
      genseq,
      abortSignal,
    ) {
      return output({
        provider,
        agent,
        systemPrompt,
        tools,
        request,
        context,
        genseq,
        abortSignal,
        streaming: false,
      });
    },
    async genToReceiver(
      provider,
      agent,
      systemPrompt,
      tools,
      request,
      context,
      receiver,
      genseq,
      abortSignal,
    ) {
      const result = await output({
        provider,
        agent,
        systemPrompt,
        tools,
        request,
        context,
        genseq,
        abortSignal,
        streaming: true,
      });
      for (const message of result.messages) {
        if (abortSignal?.aborted) throw new Error('AbortError');
        switch (message.type) {
          case 'thinking_msg':
            await receiver.thinkingStart();
            await receiver.thinkingChunk(message.content);
            await receiver.thinkingFinish(message.reasoning, message.provider_data);
            break;
          case 'saying_msg':
            await receiver.sayingStart();
            await receiver.sayingChunk(message.content);
            await receiver.sayingFinish();
            break;
          case 'func_call_msg':
            await receiver.funcCall(message.id, message.name, message.arguments, {
              rawCallId: message.rawId,
              effectiveCallId: message.effectiveId,
            });
            break;
          default:
            throw new Error(`Unsupported controlled provider output: ${message.type}`);
        }
      }
      return { usage: result.usage, llmGenModel: result.llmGenModel };
    },
  };
}
