import assert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
import { Team } from '../../main/team';
import { liveCapture, selectLiveProvider, writeLiveReport } from '../helpers/live-provider';

async function main() {
  const selected = await selectLiveProvider('minimaxi.com-coding-plan');
  if (!selected) return;
  const model = selected.models[0]!;
  const keys = ['game', 'year', 'ok', 'traits', 'score'];
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'live-json-input',
      grammar: 'markdown',
      content:
        'Return one JSON object with exactly these supplied field names: ' +
        JSON.stringify(keys) +
        '. Values may be any JSON values; this probe does not judge their meaning.',
    },
  ];
  const systemPrompt = 'Return one JSON object without surrounding prose.';
  const observed = liveCapture(1);
  let status = 'failed';
  let error: string | undefined;
  let result: unknown;
  const started = Date.now();
  try {
    result = await selected.generator.genToReceiver(
      selected.provider,
      new Team.Member({
        id: 'json-probe',
        name: 'JSON transport probe',
        provider: selected.providerKey,
        model,
        model_params: {
          json_response: true,
          ...(selected.provider.apiType === 'codex' ? { codex: { web_search: 'disabled' } } : {}),
        },
      }),
      systemPrompt,
      [],
      {
        dialogSelfId: 'live-json',
        dialogRootId: 'live-json',
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
    const data: unknown = JSON.parse(observed.capture.sayingChunks.join(''));
    assert.ok(data !== null && typeof data === 'object' && !Array.isArray(data));
    assert.deepEqual(Object.keys(data).sort(), [...keys].sort()); // Supplied field identifiers, not natural-language meaning.
    status = 'passed';
  } catch (failure: unknown) {
    error = failure instanceof Error ? failure.message : String(failure);
    process.exitCode = 1;
  }
  await writeLiveReport('json-response', [
    {
      provider: selected.providerKey,
      model,
      apiType: selected.provider.apiType,
      status,
      error,
      elapsedMs: Date.now() - started,
      modelParams: { json_response: true },
      systemPrompt,
      context,
      result,
      capture: observed.capture,
    },
  ]);
  console.log(
    JSON.stringify({
      status,
      scope: 'JSON-object-and-supplied-field-transport',
      semanticAcceptance: 'not-assessed',
    }),
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
