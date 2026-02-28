import { ChatMessage, LlmConfig, type ProviderConfig } from 'dominds/llm/client';
import { LlmStreamReceiver } from 'dominds/llm/gen';
import { generatorsRegistry } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool } from 'dominds/tool';

type Args = Readonly<{
  provider: string;
  model: string | null;
}>;

function parseArgs(argv: ReadonlyArray<string>): Args {
  let provider = 'minimaxi.com';
  let model: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--provider') {
      const next = argv[i + 1];
      if (!next || next.trim() === '') throw new Error('Missing value for --provider');
      provider = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--model') {
      const next = argv[i + 1];
      if (!next || next.trim() === '') throw new Error('Missing value for --model');
      model = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: pnpm -C tests run minimax-m25-turn-assembly -- [--provider <provider>] [--model <model>]',
      );
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  return { provider, model };
}

function pickModel(provider: ProviderConfig, preferred: string | null): string {
  if (preferred && Object.prototype.hasOwnProperty.call(provider.models, preferred)) {
    return preferred;
  }
  if (Object.prototype.hasOwnProperty.call(provider.models, 'MiniMax-M2.5')) {
    return 'MiniMax-M2.5';
  }
  const fallback = Object.keys(provider.models)[0];
  if (!fallback) {
    throw new Error(`Provider '${provider.name}' has no configured models`);
  }
  return fallback;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await LlmConfig.load();
  const providerCfg = cfg.getProvider(args.provider);
  if (!providerCfg) {
    console.error(`provider '${args.provider}' not found`);
    process.exit(2);
  }
  const model = pickModel(providerCfg, args.model);
  const gen = generatorsRegistry.get(providerCfg.apiType);
  if (!gen) {
    console.error(`generator '${providerCfg.apiType}' not registered`);
    process.exit(2);
  }

  const agent = new Team.Member({
    id: 'turn-assembly-tester',
    name: 'Turn Assembly Tester',
    provider: args.provider,
    model,
  });

  const funcTools: FuncTool[] = [
    {
      type: 'func',
      name: 'env_get',
      description: 'Read an environment variable.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      call: async () => {
        throw new Error('env_get should not be executed in provider compliance tests');
      },
    },
  ];

  const systemPrompt =
    'You are a deterministic assistant. If you need any tool output, ask for it via the env_get tool.';

  const context: ChatMessage[] = [
    {
      type: 'environment_msg',
      role: 'user',
      content:
        'ENV: This is a runtime-injected environment message. (Ideal future: role=environment.)',
    },
    {
      type: 'transient_guide_msg',
      role: 'assistant',
      content: 'GUIDE: Keep responses short.',
    },
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'minimax-m25-turn-assembly',
      grammar: 'markdown',
      content:
        'Call env_get(key="DOMINDS_TEST_TURN_ASSEMBLY") and then say the value you got (or "(unset)").',
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 1,
      content: 'Calling env_get now.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 1,
      id: 'call-1',
      name: 'env_get',
      arguments: JSON.stringify({ key: 'DOMINDS_TEST_TURN_ASSEMBLY' }),
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'env_get',
      content: '(unset)',
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 2,
      content: 'Value: (unset)',
    },
  ];

  const chunks: string[] = [];
  let funcCallCount = 0;
  const start = Date.now();

  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async (chunk: string) => {
      chunks.push(chunk);
    },
    sayingFinish: async () => {},
    funcCall: async () => {
      funcCallCount += 1;
    },
    streamError: async () => {},
  };

  await gen.genToReceiver(providerCfg, agent, systemPrompt, funcTools, context, receiver, 1);

  const elapsedMs = Date.now() - start;
  const raw = chunks.join('').trim();
  if (raw.length === 0) {
    throw new Error('MiniMax turn assembly probe failed: empty output');
  }
  if (funcCallCount > 0) {
    throw new Error(
      `MiniMax turn assembly probe failed: model attempted tool call during compliance run (count=${funcCallCount})`,
    );
  }

  console.log(
    JSON.stringify({
      provider: args.provider,
      model,
      apiType: providerCfg.apiType,
      elapsedMs,
      rawChars: raw.length,
      funcCallCount,
    }),
  );
  console.log('✓ MiniMax M2.5 turn assembly probe passed');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
