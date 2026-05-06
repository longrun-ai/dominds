import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { generatorsRegistry } from '../../main/llm/gen/registry';
import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';

type Args = Readonly<{
  models: string[];
  reasoningModel: string | null;
}>;

type SmokeResult = {
  model: string;
  content: {
    ok: boolean;
    elapsedMs: number;
    sayingText: string;
    thinkingChars: number;
    streamErrors: string[];
    error?: string;
  };
  tool: {
    ok: boolean;
    elapsedMs: number;
    callCount: number;
    calls: Array<{ id: string; name: string; args: string }>;
    sayingText: string;
    thinkingChars: number;
    streamErrors: string[];
    error?: string;
  };
};

type ReasoningResult = {
  model: string;
  ok: boolean;
  elapsedMs: number;
  sayingText: string;
  thinkingChars: number;
  streamErrors: string[];
  error?: string;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  const models: string[] = [];
  let reasoningModel: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--model') {
      const next = argv[i + 1];
      if (!next || next.trim() === '') throw new Error('Missing value for --model');
      models.push(next.trim());
      i += 1;
      continue;
    }
    if (arg === '--reasoning-model') {
      const next = argv[i + 1];
      if (!next || next.trim() === '') throw new Error('Missing value for --reasoning-model');
      reasoningModel = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: pnpm -C tests exec tsx provider/volcengine-coding-plan-live-smoke.ts -- [--model <model> ...] [--reasoning-model <model>]',
      );
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return { models, reasoningModel };
}

function buildReceiver(capture: {
  sayingChunks: string[];
  thinkingChars: number;
  streamErrors: string[];
  calls: Array<{ id: string; name: string; args: string }>;
}): LlmStreamReceiver {
  return {
    thinkingStart: async () => {},
    thinkingChunk: async (chunk) => {
      capture.thinkingChars += chunk.length;
    },
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async (chunk) => {
      capture.sayingChunks.push(chunk);
    },
    sayingFinish: async () => {},
    funcCall: async (id, name, args) => {
      capture.calls.push({ id, name, args });
    },
    streamError: async (detail) => {
      capture.streamErrors.push(detail);
    },
  };
}

function getGen(provider: ProviderConfig) {
  const gen = generatorsRegistry.get(provider.apiType);
  if (!gen) throw new Error(`generator '${provider.apiType}' not registered`);
  return gen;
}

function contentContext(model: string): ChatMessage[] {
  return [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: `volc-content-${model}`,
      grammar: 'markdown',
      content: 'Reply with exactly: OK',
    },
  ];
}

function toolContext(model: string): ChatMessage[] {
  return [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 2,
      msgId: `volc-tool-${model}`,
      grammar: 'markdown',
      content: `Call tool_echo with value="${model}". Do not output prose.`,
    },
  ];
}

function reasoningContext(model: string): ChatMessage[] {
  return [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 3,
      msgId: `volc-reasoning-${model}`,
      grammar: 'markdown',
      content: 'Think briefly, then answer exactly: DONE',
    },
  ];
}

function echoTool(): FuncTool {
  return {
    type: 'func',
    name: 'tool_echo',
    description: 'Echo a short string value.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    call: async () => {
      throw new Error('tool_echo should not execute in live smoke');
    },
  };
}

async function runContent(
  provider: ProviderConfig,
  model: string,
): Promise<SmokeResult['content']> {
  const capture = { sayingChunks: [], thinkingChars: 0, streamErrors: [], calls: [] };
  const startedAt = Date.now();
  try {
    await getGen(provider).genToReceiver(
      provider,
      new Team.Member({
        id: 'volc-live-smoke',
        name: 'Volc Live Smoke',
        provider: 'volcano-engine-coding-plan',
        model,
        model_params: {
          'openai-compatible': { temperature: 0, thinking: false, parallel_tool_calls: false },
        },
      }),
      'You are a concise test assistant.',
      [],
      {
        dialogSelfId: 'tests/provider/volcengine-coding-plan-live-smoke',
        dialogRootId: 'tests/provider/volcengine-coding-plan-live-smoke',
        providerKey: 'volcano-engine-coding-plan',
        modelKey: model,
      },
      contentContext(model),
      buildReceiver(capture),
      1,
    );
    const sayingText = capture.sayingChunks.join('');
    return {
      ok: sayingText.trim().length > 0 && capture.streamErrors.length === 0,
      elapsedMs: Date.now() - startedAt,
      sayingText,
      thinkingChars: capture.thinkingChars,
      streamErrors: capture.streamErrors,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      sayingText: capture.sayingChunks.join(''),
      thinkingChars: capture.thinkingChars,
      streamErrors: capture.streamErrors,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runTool(provider: ProviderConfig, model: string): Promise<SmokeResult['tool']> {
  const capture = { sayingChunks: [], thinkingChars: 0, streamErrors: [], calls: [] };
  const startedAt = Date.now();
  try {
    await getGen(provider).genToReceiver(
      provider,
      new Team.Member({
        id: 'volc-live-smoke',
        name: 'Volc Live Smoke',
        provider: 'volcano-engine-coding-plan',
        model,
        model_params: {
          'openai-compatible': { temperature: 0, thinking: false, parallel_tool_calls: false },
        },
      }),
      'You are a deterministic test assistant. Use tools exactly when requested.',
      [echoTool()],
      {
        dialogSelfId: 'tests/provider/volcengine-coding-plan-live-smoke',
        dialogRootId: 'tests/provider/volcengine-coding-plan-live-smoke',
        providerKey: 'volcano-engine-coding-plan',
        modelKey: model,
      },
      toolContext(model),
      buildReceiver(capture),
      2,
    );
    return {
      ok:
        capture.calls.length === 1 &&
        capture.calls[0]?.name === 'tool_echo' &&
        capture.streamErrors.length === 0,
      elapsedMs: Date.now() - startedAt,
      callCount: capture.calls.length,
      calls: capture.calls,
      sayingText: capture.sayingChunks.join(''),
      thinkingChars: capture.thinkingChars,
      streamErrors: capture.streamErrors,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      callCount: capture.calls.length,
      calls: capture.calls,
      sayingText: capture.sayingChunks.join(''),
      thinkingChars: capture.thinkingChars,
      streamErrors: capture.streamErrors,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runReasoning(provider: ProviderConfig, model: string): Promise<ReasoningResult> {
  const capture = { sayingChunks: [], thinkingChars: 0, streamErrors: [], calls: [] };
  const startedAt = Date.now();
  try {
    await getGen(provider).genToReceiver(
      provider,
      new Team.Member({
        id: 'volc-live-smoke',
        name: 'Volc Live Smoke',
        provider: 'volcano-engine-coding-plan',
        model,
        model_params: {
          'openai-compatible': { temperature: 0, thinking: true, parallel_tool_calls: false },
        },
      }),
      'You are a concise test assistant.',
      [],
      {
        dialogSelfId: 'tests/provider/volcengine-coding-plan-live-smoke',
        dialogRootId: 'tests/provider/volcengine-coding-plan-live-smoke',
        providerKey: 'volcano-engine-coding-plan',
        modelKey: model,
      },
      reasoningContext(model),
      buildReceiver(capture),
      3,
    );
    return {
      model,
      ok: capture.sayingChunks.join('').trim().length > 0 && capture.streamErrors.length === 0,
      elapsedMs: Date.now() - startedAt,
      sayingText: capture.sayingChunks.join(''),
      thinkingChars: capture.thinkingChars,
      streamErrors: capture.streamErrors,
    };
  } catch (error: unknown) {
    return {
      model,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      sayingText: capture.sayingChunks.join(''),
      thinkingChars: capture.thinkingChars,
      streamErrors: capture.streamErrors,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await LlmConfig.load();
  const providerCfg = cfg.getProvider('volcano-engine-coding-plan');
  if (!providerCfg) throw new Error('provider volcano-engine-coding-plan not found');
  const models = args.models.length > 0 ? args.models : Object.keys(providerCfg.models);
  for (const model of models) {
    if (!Object.prototype.hasOwnProperty.call(providerCfg.models, model)) {
      throw new Error(`model '${model}' is not configured for volcano-engine-coding-plan`);
    }
  }

  const results: SmokeResult[] = [];
  for (const model of models) {
    console.error(`live smoke: ${model} content`);
    const content = await runContent(providerCfg, model);
    console.error(`live smoke: ${model} tool`);
    const tool = await runTool(providerCfg, model);
    results.push({ model, content, tool });
    console.log(JSON.stringify({ model, content, tool }));
  }

  let reasoning: ReasoningResult | undefined;
  if (args.reasoningModel !== null) {
    if (!Object.prototype.hasOwnProperty.call(providerCfg.models, args.reasoningModel)) {
      throw new Error(
        `reasoning model '${args.reasoningModel}' is not configured for volcano-engine-coding-plan`,
      );
    }
    console.error(`live smoke: ${args.reasoningModel} reasoning`);
    reasoning = await runReasoning(providerCfg, args.reasoningModel);
    console.log(JSON.stringify({ reasoning }));
  }

  const failed = results.filter((item) => !item.content.ok || !item.tool.ok);
  if (reasoning !== undefined && !reasoning.ok) {
    failed.push({
      model: reasoning.model,
      content: {
        ok: true,
        elapsedMs: 0,
        sayingText: '',
        thinkingChars: 0,
        streamErrors: [],
      },
      tool: {
        ok: false,
        elapsedMs: reasoning.elapsedMs,
        callCount: 0,
        calls: [],
        sayingText: reasoning.sayingText,
        thinkingChars: reasoning.thinkingChars,
        streamErrors: reasoning.streamErrors,
        error: reasoning.error,
      },
    });
  }
  if (failed.length > 0) {
    console.error(`live smoke failures: ${failed.map((item) => item.model).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
