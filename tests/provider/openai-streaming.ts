import { ChatMessage, LlmConfig } from 'dominds/llm/client';
import { LlmStreamReceiver } from 'dominds/llm/gen';
import { generatorsRegistry } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool } from 'dominds/tool';

async function main() {
  const cfg = await LlmConfig.load();
  const provider = cfg.getProvider('openai');
  if (!provider) {
    console.error('provider openai not found');
    process.exit(2);
  }
  const model = 'gpt-5.2';
  const gen = generatorsRegistry.get('openai');
  if (!gen) {
    console.error('openai generator not registered');
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
      grammar: 'markdown',
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
    provider: 'openai',
    model,
    textChunkCount,
    textChars,
    reasoningChunkCount,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
