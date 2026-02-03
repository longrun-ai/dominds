import { ChatMessage, LlmConfig, type ProviderConfig } from 'dominds/llm/client';
import type { LlmStreamReceiver } from 'dominds/llm/gen';
import { getLlmGenerator } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';

function selectModel(provider: ProviderConfig): string {
  if (provider.models['gpt-5.2-codex']) {
    return 'gpt-5.2-codex';
  }
  if (provider.models['gpt-5.2']) {
    return 'gpt-5.2';
  }
  const fallback = Object.keys(provider.models)[0];
  if (!fallback) {
    throw new Error('No models configured for codex provider');
  }
  return fallback;
}

async function main(): Promise<void> {
  const cfg = await LlmConfig.load();
  const provider = cfg.getProvider('codex');
  if (!provider) {
    console.error('provider codex not found');
    process.exit(2);
  }

  const model = selectModel(provider);
  const gen = getLlmGenerator('codex');
  if (!gen) {
    console.error('codex generator not registered');
    process.exit(2);
  }
  if (gen.apiType !== provider.apiType) {
    console.error(
      `codex provider apiType mismatch: expected ${provider.apiType}, got ${gen.apiType}`,
    );
    process.exit(2);
  }

  const agent = new Team.Member({ id: 'tester', name: 'Tester', model });
  const systemPrompt = '';
  const funcTools: [] = [];
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'codex-streaming-test',
      content: 'Say hello in 3 words.',
      grammar: 'tellask',
    },
  ];

  const start = Date.now();
  let textChunkCount = 0;
  let textChars = 0;
  let reasoningChunkCount = 0;
  let reasoningChars = 0;

  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async (chunk: string) => {
      reasoningChunkCount += 1;
      reasoningChars += chunk.length;
    },
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async (chunk: string) => {
      textChunkCount += 1;
      textChars += chunk.length;
    },
    sayingFinish: async () => {},
    funcCall: async () => {},
    streamError: async (_detail: string) => {},
  };

  await gen.genToReceiver(provider, agent, systemPrompt, funcTools, context, receiver, 1);

  const end = Date.now();

  const report = {
    provider: 'codex',
    model,
    textChunkCount,
    reasoningChunkCount,
    textChars,
    reasoningChars,
    totalMs: end - start,
  };
  console.log(JSON.stringify(report));

  if (textChunkCount === 0 && reasoningChunkCount === 0) {
    console.error('no chunks received from any stream type');
    process.exit(3);
  }

  console.log('✓ Streaming test passed: chunks flowing in real-time');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
