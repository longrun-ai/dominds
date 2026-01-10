import { ChatMessage, LlmConfig } from 'dominds/llm/client';
import { LlmStreamReceiver } from 'dominds/llm/gen';
import { generatorsRegistry } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool } from 'dominds/tool';

async function main() {
  const cfg = await LlmConfig.load();
  const provider = cfg.getProvider('minimaxi.com-coding-plan');
  if (!provider) {
    console.error('provider minimaxi.com-coding-plan not found');
    process.exit(2);
  }
  const model = 'MiniMax-M2';
  const gen = generatorsRegistry.get('anthropic');
  if (!gen) {
    console.error('anthropic generator not registered');
    process.exit(2);
  }

  const agent = new Team.Member({ id: 'tester', name: 'Tester', model });
  const systemPrompt = '';
  const funcTools: FuncTool[] = [];
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'test-user-msg',
      content: 'Say hello in 3 words.',
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
  };
  await gen.genToReceiver(provider, agent, systemPrompt, funcTools, context, receiver, 1);

  const end = Date.now();

  const report = {
    provider: 'minimaxi.com-coding-plan',
    model,
    textChunkCount,
    totalMs: end - start,
  };
  console.log(JSON.stringify(report));

  if (textChunkCount === 0 && reasoningChunkCount === 0) {
    console.error('no chunks received from any stream type');
    process.exit(3);
  }

  console.log('✓ Streaming test passed: chunks flowing in real-time');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
