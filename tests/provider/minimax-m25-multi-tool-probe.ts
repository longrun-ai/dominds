import { ChatMessage, LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { generatorsRegistry } from '../../main/llm/gen/registry';
import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';

type Args = Readonly<{
  provider: string;
  model: string | null;
}>;

function parseArgs(argv: ReadonlyArray<string>): Args {
  let provider = 'minimaxi.com-coding-plan';
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
        'Usage: pnpm -C tests exec tsx --tsconfig tsconfig.json provider/minimax-m25-multi-tool-probe.ts -- [--provider <provider>] [--model <model>]',
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
    id: 'multi-tool-probe',
    name: 'Multi Tool Probe',
    provider: args.provider,
    model,
    model_params: { anthropic: { temperature: 0 } },
  });

  const funcTools: FuncTool[] = [
    {
      type: 'func',
      name: 'tool_a',
      description: 'Echo tool A payload.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      call: async () => {
        throw new Error('tool_a should not execute in probe');
      },
    },
    {
      type: 'func',
      name: 'tool_b',
      description: 'Echo tool B payload.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      call: async () => {
        throw new Error('tool_b should not execute in probe');
      },
    },
  ];

  const systemPrompt =
    'You are a deterministic test assistant. When asked, emit both tool calls in one assistant response.';
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'probe-user-1',
      grammar: 'markdown',
      content:
        'In a single assistant response, call both tool_a(value="A") and tool_b(value="B"), then stop. Do not output prose.',
    },
  ];

  const calls: Array<{ id: string; name: string; args: string }> = [];
  const chunks: string[] = [];
  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async (chunk: string) => {
      chunks.push(chunk);
    },
    sayingFinish: async () => {},
    funcCall: async (callId: string, name: string, argsJson: string) => {
      calls.push({ id: callId, name, args: argsJson });
    },
    streamError: async () => {},
  };

  const startedAt = Date.now();
  await gen.genToReceiver(
    providerCfg,
    agent,
    systemPrompt,
    funcTools,
    {
      dialogSelfId: 'tests/provider/minimax-m25-multi-tool-probe',
      dialogRootId: 'tests/provider/minimax-m25-multi-tool-probe',
    },
    context,
    receiver,
    1,
  );
  const elapsedMs = Date.now() - startedAt;

  console.log(
    JSON.stringify({
      provider: args.provider,
      model,
      apiType: providerCfg.apiType,
      elapsedMs,
      funcCallCount: calls.length,
      funcCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      sayingText: chunks.join(''),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
