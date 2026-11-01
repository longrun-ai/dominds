import assert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';
import { liveCapture, selectLiveProvider, writeLiveReport } from '../helpers/live-provider';

async function main() {
  const selected = await selectLiveProvider('minimaxi.com');
  if (!selected) return;
  const model = selected.models[0]!;
  const tool: FuncTool = {
    type: 'func',
    name: 'env_get',
    description: 'A supplied history tool; this probe never executes it.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
    call: async () => {
      throw new Error('No environment variable may be read by this history probe');
    },
  };
  const context: ChatMessage[] = [
    {
      type: 'environment_msg',
      role: 'user',
      content:
        'ENV: This is a runtime-injected environment message. (Ideal future: role=environment.)',
    },
    { type: 'transient_guide_msg', role: 'assistant', content: 'GUIDE: Keep responses short.' },
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'turn-assembly-first',
      grammar: 'markdown',
      content:
        'Call env_get(key="DOMINDS_TEST_TURN_ASSEMBLY") and then say the value you got (or "(unset)").',
    },
    { type: 'saying_msg', role: 'assistant', genseq: 1, content: 'Calling env_get now.' },
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
    { type: 'saying_msg', role: 'assistant', genseq: 2, content: 'Value: (unset)' },
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 3,
      msgId: 'turn-assembly-followup',
      grammar: 'markdown',
      content: 'Briefly acknowledge the completed exchange without another tool call.',
    },
  ];
  const systemPrompt = 'The supplied tool history is fixture data. Do not execute tools.';
  const observed = liveCapture(3);
  const started = Date.now();
  let status = 'failed';
  let error: string | undefined;
  let result: unknown;
  try {
    result = await selected.generator.genToReceiver(
      selected.provider,
      new Team.Member({
        id: 'history-probe',
        name: 'History acceptance probe',
        provider: selected.providerKey,
        model,
        ...(selected.provider.apiType === 'codex'
          ? { model_params: { codex: { web_search: 'disabled' } } }
          : {}),
      }),
      systemPrompt,
      [tool],
      {
        dialogSelfId: 'live-turn-assembly',
        dialogRootId: 'live-turn-assembly',
        providerKey: selected.providerKey,
        modelKey: model,
        toolUseRequirement: 'none',
      },
      context,
      observed.receiver,
      3,
    );
    observed.assertComplete();
    assert.equal(observed.capture.calls.length, 0);
    assert.equal(observed.capture.sideOutputs.length, 0);
    assert.ok(observed.capture.sayingChunks.join('').length > 0);
    status = 'passed';
  } catch (failure: unknown) {
    error = failure instanceof Error ? failure.message : String(failure);
    process.exitCode = 1;
  }
  await writeLiveReport('turn-assembly', [
    {
      provider: selected.providerKey,
      model,
      apiType: selected.provider.apiType,
      status,
      error,
      elapsedMs: Date.now() - started,
      systemPrompt,
      context,
      result,
      capture: observed.capture,
      scope:
        'Vendor acceptance of this explicitly supplied environment/guide/call/result/saying history and a fresh generation3 only. No env_get execution, durable dialog restore or semantic use of the result is established.',
    },
  ]);
  console.log(
    JSON.stringify({
      status,
      scope: 'supplied-history-request-acceptance',
      semanticAcceptance: 'not-assessed',
    }),
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
