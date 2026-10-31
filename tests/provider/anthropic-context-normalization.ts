import assert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
import {
  reconstructAnthropicContextWrapper,
  reconstructAnthropicContextWrapperAsync,
} from '../../main/llm/gen/anthropic';
import { assertInvalidProviderHistories, providerHistory } from '../helpers/provider-context';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-projection-anthropic-');
async function main() {
  const fixture = providerHistory();
  const malformed = {
    ...fixture,
    call: { ...fixture.call, id: 'call-malformed', arguments: '{"command":\n"opaque:7ae2' },
    result: {
      ...fixture.result,
      id: 'call-malformed',
      content: 'supplied-failure-data:81fe\n引号 " / Ω',
    },
  };
  const scenarios = [
    { id: 'normal', ...fixture },
    { id: 'malformed', ...malformed },
  ];
  for (const row of scenarios) {
    const context: ChatMessage[] = [row.user, row.thinking, row.saying, row.call, row.result];
    const original = structuredClone(context);
    for (const [mode, project] of [
      ['sync', reconstructAnthropicContextWrapper],
      ['async', reconstructAnthropicContextWrapperAsync],
    ] as const) {
      const messages = await project(context);
      assert.deepEqual(
        messages.map((message) => message.role),
        ['user', 'assistant', 'user'],
      );
      const texts = messages.map((message) => {
        assert.ok(Array.isArray(message.content));
        // No native JSON tool_use/tool_result is replayed from opaque historical arguments.
        assert.ok(message.content.every((block) => block.type === 'text'));
        return message.content.map((block) => {
          assert.ok(block.type === 'text');
          return block.text;
        });
      });
      assert.deepEqual(texts[0], [row.user.content]);
      for (const supplied of [row.thinking.content, row.saying.content, row.call.arguments])
        assert.ok(texts[1]!.some((text) => text.includes(supplied)));
      assert.ok(texts[2]!.some((text) => text.includes(row.result.content)));
      assert.deepEqual(context, original);
      evidence.record({
        id: `${mode}-${row.id}-history`,
        scenario: `Anthropic ${mode} request projection of ${row.id} supplied tool history.`,
        businessValue:
          'Preserve raw arguments and observed result without requiring valid JSON or presenting historical tool activity as a fresh action.',
        context: {
          input: JSON.stringify(original),
          scope: 'Actual sync/async projection; no provider request, tool execution or restart.',
        },
        reviewQuestions: [
          'Does the actual text attribute the call and result correctly, preserve malformed input as historical data, and keep the supplied failure visible without inventing execution or completion?',
        ],
        actualText: JSON.stringify(messages, null, 2),
      });
    }
  }
  const second = {
    ...fixture.call,
    id: 'call-2',
    name: 'inspect_data',
    arguments: '{"selector":"second"}',
  };
  const secondResult = {
    ...fixture.result,
    id: second.id,
    name: second.name,
    content: 'second-result-data:316e',
  };
  const parallelContext = [fixture.user, fixture.call, second, secondResult, fixture.result];
  for (const [mode, project] of [
    ['sync', reconstructAnthropicContextWrapper],
    ['async', reconstructAnthropicContextWrapperAsync],
  ] as const) {
    const before = structuredClone(parallelContext);
    const messages = await project(parallelContext);
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant', 'user'],
    );
    for (const [index, payload] of [
      [1, fixture.call.arguments],
      [2, fixture.result.content],
      [3, second.arguments],
      [4, secondResult.content],
    ] as const) {
      const content = messages[index]?.content;
      assert.ok(Array.isArray(content));
      assert.ok(content.every((block) => block.type === 'text'));
      assert.ok(content.some((block) => block.type === 'text' && block.text.includes(payload)));
    }
    assert.deepEqual(parallelContext, before);
    evidence.record({
      id: `${mode}-parallel-history`,
      scenario: `Anthropic ${mode} projection pairs two parallel calls with reverse-arriving results.`,
      businessValue:
        'Keep each observed outcome attributed to its own historical call instead of misrepresenting another tool result.',
      context: {
        input: JSON.stringify(before),
        scope: 'Actual request projection only; no provider request or tool execution.',
      },
      reviewQuestions: [
        'Does the actual text keep both call identities, raw arguments and corresponding outcomes correctly attributed after normalization?',
      ],
      actualText: JSON.stringify(messages, null, 2),
    });
  }
  await assertInvalidProviderHistories(
    'anthropic-sync',
    reconstructAnthropicContextWrapper,
    evidence,
  );
  await assertInvalidProviderHistories(
    'anthropic-async',
    reconstructAnthropicContextWrapperAsync,
    evidence,
  );
  await evidence.write();
  console.log('Anthropic raw history, role assembly and rejection: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
