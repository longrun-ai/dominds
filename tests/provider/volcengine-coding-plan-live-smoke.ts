import assert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';
import { liveCapture, selectLiveProvider, writeLiveReport } from '../helpers/live-provider';

async function main() {
  const selected = await selectLiveProvider('volcano-engine-coding-plan', {
    multipleModels: true,
    reasoning: true,
  });
  if (!selected) return;
  if (selected.provider.apiType !== 'openai-compatible')
    throw new Error('This probe requires the current OpenAI-compatible coding-plan API');
  const echo: FuncTool = {
    type: 'func',
    name: 'tool_echo',
    description: 'Capture a supplied value without executing it.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    call: async () => {
      throw new Error('The live smoke probe does not execute tools');
    },
  };
  const rows: Array<{ status: 'passed' | 'failed'; [key: string]: unknown }> = [];
  async function attempt(
    kind: 'content' | 'tool' | 'history' | 'reasoning',
    model: string,
    genseq: number,
    context: ChatMessage[],
  ) {
    const observed = liveCapture(genseq);
    const started = Date.now();
    let status: 'passed' | 'failed' = 'failed';
    let error: string | undefined;
    let result: unknown;
    const systemPrompt =
      'Respond briefly to the supplied diagnostic request. Tools are captured, never executed.';
    try {
      result = await selected!.generator.genToReceiver(
        selected!.provider,
        new Team.Member({
          id: 'coding-plan-smoke',
          name: 'Coding-plan transport probe',
          provider: selected!.providerKey,
          model,
          model_params: {
            'openai-compatible': {
              temperature: 0,
              thinking: kind === 'reasoning',
              parallel_tool_calls: false,
            },
          },
        }),
        systemPrompt,
        kind === 'tool' ? [echo] : [],
        {
          dialogSelfId: 'coding-plan-' + kind,
          dialogRootId: 'coding-plan-' + kind,
          providerKey: selected!.providerKey,
          modelKey: model,
          toolUseRequirement: kind === 'tool' ? 'required' : 'none',
        },
        context,
        observed.receiver,
        genseq,
      );
      observed.assertComplete();
      assert.equal(observed.capture.sideOutputs.length, 0);
      if (kind === 'tool') {
        assert.equal(observed.capture.calls.length, 1);
        const call = observed.capture.calls[0]!;
        assert.ok(call.id.length > 0);
        assert.equal(call.name, 'tool_echo');
        assert.deepEqual(JSON.parse(call.args), { value: model });
      } else {
        assert.equal(observed.capture.calls.length, 0);
        assert.ok(observed.capture.sayingChunks.join('').length > 0);
      }
      if (kind === 'reasoning')
        assert.ok(
          observed.capture.thinkingChunks.join('').length > 0,
          'The selected reasoning probe requires actual visible thinking-channel data',
        );
      status = 'passed';
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    rows.push({
      id: kind + ':' + model,
      provider: selected!.providerKey,
      model,
      apiType: selected!.provider.apiType,
      status,
      error,
      elapsedMs: Date.now() - started,
      systemPrompt,
      context,
      result,
      capture: observed.capture,
      scope:
        'Native provider/generator request acceptance and supplied-data/callback effects. No tool execution, durable execution, semantic history use or reasoning quality is established.',
    });
    console.log(JSON.stringify({ id: kind + ':' + model, status, scope: 'provider-transport' }));
  }
  for (const model of selected.models) {
    await attempt('content', model, 1, [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 1,
        msgId: 'coding-content',
        grammar: 'markdown',
        content: 'Send a short connectivity response.',
      },
    ]);
    await attempt('tool', model, 2, [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 2,
        msgId: 'coding-tool',
        grammar: 'markdown',
        content:
          'Call tool_echo once with exactly this supplied JSON object: ' +
          JSON.stringify({ value: model }),
      },
    ]);
    await attempt('history', model, 5, [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 4,
        msgId: 'coding-history-first',
        grammar: 'markdown',
        content: 'Use tool_echo once.',
      },
      {
        type: 'thinking_msg',
        role: 'assistant',
        genseq: 4,
        content: 'Need to call the echo tool.',
      },
      { type: 'saying_msg', role: 'assistant', genseq: 4, content: 'Calling the echo tool.' },
      {
        type: 'func_call_msg',
        role: 'assistant',
        genseq: 4,
        id: 'call-history-' + model,
        name: 'tool_echo',
        arguments: JSON.stringify({ value: model }),
      },
      {
        type: 'func_result_msg',
        role: 'tool',
        genseq: 4,
        id: 'call-history-' + model,
        name: 'tool_echo',
        content: 'echo:' + model,
      },
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 5,
        msgId: 'coding-history-followup',
        grammar: 'markdown',
        content: 'Briefly acknowledge this completed fixture exchange without another tool call.',
      },
    ]);
  }
  if (selected.reasoningModel)
    await attempt('reasoning', selected.reasoningModel, 3, [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 3,
        msgId: 'coding-reasoning',
        grammar: 'markdown',
        content: 'Use the enabled thinking channel, then give a short response.',
      },
    ]);
  await writeLiveReport('coding-plan-smoke', rows);
  const failed = rows.filter((row) => row.status === 'failed').length;
  console.log(
    JSON.stringify({
      total: rows.length,
      passed: rows.length - failed,
      failed,
      semanticAcceptance: 'not-assessed',
    }),
  );
  if (failed) process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
