import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { generatorsRegistry } from '../../main/llm/gen/registry';
import { Team } from '../../main/team';
import type { FuncTool, JsonObject } from '../../main/tool';

export const LIVE_PREREQUISITE_EXIT = 77;
export type LiveSelection = {
  providerKey: string;
  provider: ProviderConfig;
  models: string[];
  reasoningModel?: string;
  generator: NonNullable<ReturnType<typeof generatorsRegistry.get>>;
};
export function skipLiveProbe(code: string, detail: string) {
  console.log(JSON.stringify({ status: 'skipped', code, detail, providerRequestAttempted: false }));
  process.exitCode = LIVE_PREREQUISITE_EXIT;
}
/** An explicit live run names its target. No auth refresh, provider request or fallback occurs here. */
export async function selectLiveProvider(
  defaultProvider: string,
  options: { multipleModels?: boolean; reasoning?: boolean } = {},
): Promise<LiveSelection | undefined> {
  let providerKey = defaultProvider;
  const models: string[] = [];
  let reasoningModel: string | undefined;
  let enabled = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--' || arg === '--semantic') continue;
    if (arg === '--live') {
      enabled = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Run this probe through tests/cli.ts with --live --provider <configured-id> --model <configured-id>. Repeat --model only for a probe that reports each selected model. --reasoning-model selects the separate reasoning target where supported. Missing live prerequisites are skipped, never passing vendor coverage.',
      );
      return;
    }
    if (arg !== '--provider' && arg !== '--model' && arg !== '--reasoning-model')
      throw new Error('Unknown live-probe option: ' + arg);
    const value = args[++index];
    if (!value || value.startsWith('--') || !value.trim())
      throw new Error('Missing value for ' + arg);
    if (arg === '--provider') providerKey = value;
    else if (arg === '--model') models.push(value);
    else reasoningModel = value;
  }
  if (!enabled) {
    skipLiveProbe(
      'live_opt_in_required',
      'No request was sent. Select the intended live provider/model explicitly and pass --live.',
    );
    return;
  }
  if (!models.length) {
    skipLiveProbe(
      'model_selection_required',
      'No request was sent. Pass --model for each intended configured model; probes do not select an arbitrary fallback or every model.',
    );
    return;
  }
  if (models.length > 1 && !options.multipleModels)
    throw new Error('This probe accepts exactly one --model');
  if (reasoningModel && !options.reasoning)
    throw new Error('This probe does not accept --reasoning-model');
  const provider = (await LlmConfig.load()).getProvider(providerKey);
  if (!provider) throw new Error('Unknown configured provider: ' + providerKey);
  for (const model of [...models, ...(reasoningModel ? [reasoningModel] : [])]) {
    if (!Object.hasOwn(provider.models, model))
      throw new Error('Unknown configured model ' + model + ' for provider ' + providerKey);
  }
  const generator = generatorsRegistry.get(provider.apiType);
  if (!generator) throw new Error('No generator for configured API type: ' + provider.apiType);
  if (provider.apiType === 'codex') {
    const raw = process.env[provider.apiKeyEnvVar] || '~/.codex';
    const home = raw.startsWith('~') ? (process.env.HOME || os.homedir()) + raw.slice(1) : raw;
    try {
      await fs.access(path.join(home, 'auth.json'), constants.R_OK);
    } catch (error: unknown) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'EACCES')
        )
      )
        throw error;
      skipLiveProbe(
        'managed_auth_file_unavailable',
        'No request was sent. The configured Codex home needs a readable managed OAuth auth.json; an API-key variable alone is insufficient.',
      );
      return;
    }
    // Readability is not authentication or policy acceptance; the real wrapper remains authoritative.
  } else if (!process.env[provider.apiKeyEnvVar]) {
    skipLiveProbe(
      'credential_unavailable',
      'No request was sent. Missing configured credential variable: ' + provider.apiKeyEnvVar,
    );
    return;
  }
  return { providerKey, provider, models, reasoningModel, generator };
}
/** Preserve complete supplied inputs and observed responses; this never judges natural-language meaning. */
export async function writeLiveReport(probe: string, results: readonly unknown[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-live-provider-'));
  await fs.writeFile(
    path.join(directory, 'observations.json'),
    JSON.stringify(
      {
        probe,
        semanticAcceptance: 'not-assessed',
        scope:
          'Provider/generator observations only. Transport or supplied-data checks do not establish task meaning, tool execution, persistence, browser delivery, reasoning quality or latency guarantees.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      artifact: 'live-provider-observations',
      path: path.join(directory, 'observations.json'),
    }),
  );
  console.log('Natural-language meaning has not been accepted by this report.');
}

export type LiveCapture = {
  events: string[];
  thinkingChunks: string[];
  sayingChunks: string[];
  messages: ChatMessage[];
  calls: Array<{ id: string; name: string; args: string }>;
  errors: string[];
  sideOutputs: Array<{ kind: string; value: unknown }>;
};
/** Observe the real generator boundary, preserving data needed for a subsequent history request. */
export function liveCapture(genseq: number) {
  const capture: LiveCapture = {
    events: [],
    thinkingChunks: [],
    sayingChunks: [],
    messages: [],
    calls: [],
    errors: [],
    sideOutputs: [],
  };
  let thinking = false;
  let saying = false;
  let thinkingText = '';
  let sayingText = '';
  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {
      assert.equal(thinking, false);
      thinking = true;
      thinkingText = '';
      capture.events.push('thinkingStart');
    },
    thinkingChunk: async (chunk) => {
      assert.equal(thinking, true);
      thinkingText += chunk;
      capture.thinkingChunks.push(chunk);
    },
    thinkingFinish: async (reasoning, providerData) => {
      assert.equal(thinking, true);
      thinking = false;
      capture.events.push('thinkingFinish');
      if (thinkingText.length || reasoning !== undefined || providerData !== undefined)
        capture.messages.push({
          type: 'thinking_msg',
          role: 'assistant',
          genseq,
          content: thinkingText,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(providerData !== undefined ? { provider_data: providerData } : {}),
        });
    },
    sayingStart: async () => {
      assert.equal(saying, false);
      saying = true;
      sayingText = '';
      capture.events.push('sayingStart');
    },
    sayingChunk: async (chunk) => {
      assert.equal(saying, true);
      sayingText += chunk;
      capture.sayingChunks.push(chunk);
    },
    sayingFinish: async () => {
      assert.equal(saying, true);
      saying = false;
      capture.events.push('sayingFinish');
      if (sayingText.length)
        capture.messages.push({
          type: 'saying_msg',
          role: 'assistant',
          genseq,
          content: sayingText,
        });
    },
    funcCall: async (id, name, args, ids) => {
      capture.events.push('funcCall');
      capture.calls.push({ id, name, args });
      capture.messages.push({
        type: 'func_call_msg',
        role: 'assistant',
        genseq,
        id,
        name,
        arguments: args,
        ...(ids?.rawCallId !== undefined ? { rawId: ids.rawCallId } : {}),
        ...(ids?.effectiveCallId !== undefined ? { effectiveId: ids.effectiveCallId } : {}),
      });
    },
    streamError: async (detail) => {
      capture.events.push('streamError');
      capture.errors.push(detail);
    },
    answering: async (content) => {
      capture.sideOutputs.push({ kind: 'answering', value: content });
    },
    invalidFuncCall: async (call) => {
      capture.sideOutputs.push({ kind: 'invalid_func_call', value: call });
    },
    nativeToolCall: async (call) => {
      capture.sideOutputs.push({ kind: 'native_tool_call', value: call });
    },
    webSearchCall: async (call) => {
      capture.sideOutputs.push({ kind: 'web_search_call', value: call });
    },
    toolResultImageIngest: async (value) => {
      capture.sideOutputs.push({ kind: 'tool_result_image_ingest', value });
    },
    userImageIngest: async (value) => {
      capture.sideOutputs.push({ kind: 'user_image_ingest', value });
    },
  };
  return {
    capture,
    receiver,
    assertComplete() {
      assert.equal(thinking, false);
      assert.equal(saying, false);
      assert.deepEqual(capture.errors, []);
    },
  };
}

/** Shared by the three legacy streaming entry points; only connectivity/data lifecycle is checked. */
export async function runLiveStream(defaultProvider: string) {
  const selected = await selectLiveProvider(defaultProvider);
  if (!selected) return;
  const model = selected.models[0]!;
  const prompt =
    'Send a short connectivity response. This request does not evaluate writing quality.';
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'live-connectivity-input',
      grammar: 'markdown',
      content: prompt,
    },
  ];
  const observed = liveCapture(1);
  const started = Date.now();
  let status = 'failed';
  let error: string | undefined;
  let result: unknown;
  try {
    result = await selected.generator.genToReceiver(
      selected.provider,
      new Team.Member({
        id: 'live-connectivity',
        name: 'Live connectivity probe',
        provider: selected.providerKey,
        model,
        ...(selected.provider.apiType === 'codex'
          ? { model_params: { codex: { web_search: 'disabled' } } }
          : {}),
      }),
      '',
      [],
      {
        dialogSelfId: 'live-connectivity',
        dialogRootId: 'live-connectivity',
        providerKey: selected.providerKey,
        modelKey: model,
        toolUseRequirement: 'none',
      },
      context,
      observed.receiver,
      1,
    );
    observed.assertComplete();
    assert.equal(observed.capture.calls.length, 0);
    assert.equal(observed.capture.sideOutputs.length, 0);
    assert.ok(
      observed.capture.thinkingChunks.join('').length +
        observed.capture.sayingChunks.join('').length >
        0,
      'The completed stream must contain actual payload data',
    );
    status = 'passed';
  } catch (failure: unknown) {
    error = failure instanceof Error ? failure.message : String(failure);
    process.exitCode = 1;
  }
  await writeLiveReport(path.basename(process.argv[1] || 'stream'), [
    {
      provider: selected.providerKey,
      model,
      apiType: selected.provider.apiType,
      status,
      error,
      elapsedMs: Date.now() - started,
      systemPrompt: '',
      context,
      result,
      capture: observed.capture,
      scope:
        'Actual native generator stream and supplied no-tool policy only; payload presence and balanced callback lifetimes do not judge prose or prove real-time arrival.',
    },
  ]);
  console.log(
    JSON.stringify({ status, scope: 'stream-transport', semanticAcceptance: 'not-assessed' }),
  );
}

/** Preserve the five original opaque command/PID payloads through both native request modes. */
export async function runLiveToolPayloads(mode: 'batch' | 'stream') {
  const selected = await selectLiveProvider(mode === 'stream' ? 'codex' : 'openai');
  if (!selected) return;
  if (mode === 'batch' && selected.provider.apiType === 'codex') {
    skipLiveProbe(
      'unsupported_request_mode',
      'No request was sent. The Codex generator supports streaming only; use stream-func-call for this provider.',
    );
    return;
  }
  const model = selected.models[0]!;
  const agent = new Team.Member({
    id: 'live-tool-payload',
    name: 'Live tool payload probe',
    provider: selected.providerKey,
    model,
    ...(selected.provider.apiType === 'codex'
      ? { model_params: { codex: { web_search: 'disabled' } } }
      : {}),
  });
  const tools: FuncTool[] = [
    {
      type: 'func',
      name: 'shell_cmd',
      description:
        'Capture the supplied opaque command payload; this probe does not execute commands.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
      call: async () => {
        throw new Error('A live payload probe must never execute a command');
      },
    },
    {
      type: 'func',
      name: 'stop_daemon',
      description: 'Capture the supplied opaque PID payload; this probe does not stop any process.',
      parameters: {
        type: 'object',
        properties: { pid: { type: 'integer' } },
        required: ['pid'],
        additionalProperties: false,
      },
      call: async () => {
        throw new Error('A live payload probe must never stop a process');
      },
    },
  ];
  const given: Array<{ id: string; name: string; args: JsonObject }> = [
    { id: 'listing-payload', name: 'shell_cmd', args: { command: 'ls -la' } },
    { id: 'find-payload', name: 'shell_cmd', args: { command: 'find . -name "*.ts"' } },
    {
      id: 'grep-payload',
      name: 'shell_cmd',
      args: { command: 'grep -r "shell_cmd" . --include="*.ts"' },
    },
    {
      id: 'daemon-payload',
      name: 'shell_cmd',
      args: { command: 'echo "test" > /tmp/test.txt && tail -f /tmp/test.txt' },
    },
    { id: 'pid-payload', name: 'stop_daemon', args: { pid: 12345 } },
  ];
  const results: unknown[] = [];
  let failed = 0;
  for (const [index, input] of given.entries()) {
    const genseq = index + 1;
    const systemPrompt =
      'Return the provided tool-call payload through the tool interface. These are opaque fixture values; no tool is executed.';
    const context: ChatMessage[] = [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq,
        msgId: 'live-payload-' + input.id,
        grammar: 'markdown',
        content:
          'Call ' +
          input.name +
          ' once with exactly this supplied JSON object as arguments: ' +
          JSON.stringify(input.args),
      },
    ];
    const observed = liveCapture(genseq);
    const started = Date.now();
    let response: unknown;
    let status = 'failed';
    let error: string | undefined;
    try {
      const request = {
        dialogSelfId: 'live-payload-' + input.id,
        dialogRootId: 'live-payload-' + input.id,
        providerKey: selected.providerKey,
        modelKey: model,
        toolUseRequirement: 'required' as const,
      };
      let calls: Array<{ id: string; name: string; args: string }>;
      if (mode === 'stream') {
        response = await selected.generator.genToReceiver(
          selected.provider,
          agent,
          systemPrompt,
          tools,
          request,
          context,
          observed.receiver,
          genseq,
        );
        observed.assertComplete();
        assert.equal(observed.capture.sideOutputs.length, 0);
        calls = observed.capture.calls;
      } else {
        const batch = await selected.generator.genMoreMessages(
          selected.provider,
          agent,
          systemPrompt,
          tools,
          request,
          context,
          genseq,
        );
        response = batch;
        assert.equal((batch.outputs ?? []).filter((row) => row.kind !== 'message').length, 0);
        calls = batch.messages.flatMap((message) =>
          message.type === 'func_call_msg'
            ? [{ id: message.id, name: message.name, args: message.arguments }]
            : [],
        );
      }
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.ok(call.id.length > 0);
      assert.equal(call.name, input.name);
      const args: unknown = JSON.parse(call.args);
      // Given payload identity and declared JSON fields, not a keyword oracle for command meaning.
      assert.deepEqual(args, input.args);
      status = 'passed';
    } catch (failure: unknown) {
      failed++;
      error = failure instanceof Error ? failure.message : String(failure);
    }
    results.push({
      id: input.id,
      provider: selected.providerKey,
      model,
      apiType: selected.provider.apiType,
      mode,
      status,
      error,
      elapsedMs: Date.now() - started,
      input,
      systemPrompt,
      context,
      response,
      capture: observed.capture,
    });
    console.log(JSON.stringify({ id: input.id, status, scope: 'supplied-tool-payload-transport' }));
  }
  await writeLiveReport('function-payloads-' + mode, results);
  console.log(
    JSON.stringify({
      total: given.length,
      passed: given.length - failed,
      failed,
      toolExecution: false,
      semanticAcceptance: 'not-assessed',
    }),
  );
  if (failed) process.exitCode = 1;
}

/** The two vendor entry points share this exact two-payload wire scenario. */
export async function runLiveMultiTools(
  defaultProvider: string,
  allowedApiTypes?: readonly string[],
) {
  const selected = await selectLiveProvider(defaultProvider);
  if (!selected) return;
  if (allowedApiTypes && !allowedApiTypes.includes(selected.provider.apiType))
    throw new Error(
      'This probe does not support configured API type: ' + selected.provider.apiType,
    );
  const model = selected.models[0]!;
  const given: Record<string, { value: string }> = {
    tool_a: { value: 'A' },
    tool_b: { value: 'B' },
  };
  const tools: FuncTool[] = Object.keys(given).map((name) => ({
    type: 'func',
    name,
    description: 'Capture the supplied string payload without executing it.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    call: async () => {
      throw new Error('No tool is executed by the multi-payload probe');
    },
  }));
  const modelParams: Team.ModelParams =
    selected.provider.apiType === 'openai'
      ? { openai: { temperature: 0 } }
      : selected.provider.apiType === 'openai-compatible'
        ? { 'openai-compatible': { temperature: 0 } }
        : selected.provider.apiType === 'anthropic-compatible'
          ? { 'anthropic-compatible': { temperature: 0 } }
          : selected.provider.apiType === 'anthropic'
            ? { anthropic: { temperature: 0 } }
            : selected.provider.apiType === 'codex'
              ? { codex: { web_search: 'disabled' } }
              : {};
  const systemPrompt =
    'Emit the two supplied tool-call payloads in one response. No tool will be executed.';
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'multi-payload-input',
      grammar: 'markdown',
      content:
        'Call each supplied function once with its exact JSON arguments: ' + JSON.stringify(given),
    },
  ];
  const observed = liveCapture(1);
  const started = Date.now();
  let status = 'failed';
  let error: string | undefined;
  let result: unknown;
  try {
    result = await selected.generator.genToReceiver(
      selected.provider,
      new Team.Member({
        id: 'multi-payload-probe',
        name: 'Multi-payload transport probe',
        provider: selected.providerKey,
        model,
        model_params: modelParams,
      }),
      systemPrompt,
      tools,
      {
        dialogSelfId: 'live-multi-payload',
        dialogRootId: 'live-multi-payload',
        providerKey: selected.providerKey,
        modelKey: model,
        toolUseRequirement: 'required',
      },
      context,
      observed.receiver,
      1,
    );
    observed.assertComplete();
    assert.equal(observed.capture.sideOutputs.length, 0);
    assert.equal(observed.capture.calls.length, 2);
    assert.equal(new Set(observed.capture.calls.map((call) => call.id)).size, 2);
    assert.deepEqual(
      observed.capture.calls.map((call) => call.name).sort(),
      Object.keys(given).sort(),
    );
    for (const call of observed.capture.calls) {
      assert.ok(call.id.length > 0);
      const args: unknown = JSON.parse(call.args);
      assert.ok(Object.hasOwn(given, call.name));
      assert.deepEqual(args, given[call.name]); // Exact provided payload, independent of prose/field order.
    }
    status = 'passed';
  } catch (failure: unknown) {
    error = failure instanceof Error ? failure.message : String(failure);
    process.exitCode = 1;
  }
  await writeLiveReport('multi-tool-payload', [
    {
      provider: selected.providerKey,
      model,
      apiType: selected.provider.apiType,
      status,
      error,
      elapsedMs: Date.now() - started,
      modelParams,
      systemPrompt,
      context,
      given,
      result,
      capture: observed.capture,
    },
  ]);
  console.log(
    JSON.stringify({
      status,
      scope: 'two-independent-supplied-tool-payloads',
      semanticAcceptance: 'not-assessed',
    }),
  );
}
