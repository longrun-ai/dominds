import { ChatMessage, LlmConfig, type ProviderConfig } from 'dominds/llm/client';
import { LlmStreamReceiver } from 'dominds/llm/gen';
import { generatorsRegistry } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool } from 'dominds/tool';

type Args = Readonly<{
  provider: string;
  model: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let provider = 'minimaxi.com-coding-plan';
  let model: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--provider') {
      const next = argv[i + 1];
      if (!next || next.trim().length === 0) {
        throw new Error('Missing value for --provider');
      }
      provider = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--model') {
      const next = argv[i + 1];
      if (!next || next.trim().length === 0) {
        throw new Error('Missing value for --model');
      }
      model = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: pnpm -C tests run minimax-json-response -- [--provider <provider>] [--model <model>]',
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

function validateResponseShape(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('json_response validation failed: output is not a JSON object');
  }

  const requiredKeys = ['game', 'year', 'ok', 'traits', 'score'];
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`json_response validation failed: missing required field '${key}'`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await LlmConfig.load();
  const provider = cfg.getProvider(args.provider);
  if (!provider) {
    console.error(`provider '${args.provider}' not found`);
    process.exit(2);
  }

  const model = pickModel(provider, args.model);
  const gen = generatorsRegistry.get(provider.apiType);
  if (!gen) {
    console.error(`generator '${provider.apiType}' not registered`);
    process.exit(2);
  }

  const agent = new Team.Member({
    id: 'json-tester',
    name: 'JSON Tester',
    provider: args.provider,
    model,
    model_params: {
      json_response: true,
    },
  });

  const systemPrompt =
    'You are a strict JSON emitter. Return exactly one JSON object and nothing else.';
  const funcTools: FuncTool[] = [];
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'minimax-json-response',
      grammar: 'markdown',
      content: 'Return EXACTLY one JSON object with keys: game, year, ok, traits, score.',
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

  await gen.genToReceiver(provider, agent, systemPrompt, funcTools, context, receiver, 1);

  const elapsedMs = Date.now() - start;
  const raw = chunks.join('').trim();
  if (raw.length === 0) {
    throw new Error('json_response validation failed: empty saying output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`json_response validation failed: output is not parseable JSON (${msg})`);
  }

  validateResponseShape(parsed);
  const parsedKeys = isRecord(parsed) ? Object.keys(parsed).sort() : [];

  console.log(
    JSON.stringify({
      provider: args.provider,
      model,
      apiType: provider.apiType,
      elapsedMs,
      rawChars: raw.length,
      funcCallCount,
      parsedKeys,
    }),
  );
  console.log('✓ MiniMax json_response compliance test passed');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
