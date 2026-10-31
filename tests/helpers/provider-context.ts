import assert from 'node:assert/strict';
import type { ChatMessage, FuncCallMsg, FuncResultMsg } from '../../main/llm/client';
import type { semanticEvidenceCollector } from './semantic-evidence';

// These strings are supplied history data. Equality/containment checks protect their
// lossless transport, never the meaning of generated explanations or diagnostics.
export function providerHistory() {
  const user: ChatMessage = {
    type: 'prompting_msg',
    role: 'user',
    genseq: 1,
    msgId: 'user-1',
    grammar: 'markdown',
    content: 'input-data:7ae2\n引号 " / Ω',
  };
  const thinking: ChatMessage = {
    type: 'thinking_msg',
    role: 'assistant',
    genseq: 1,
    content: 'thinking-data:c409\n保留',
  };
  const saying: ChatMessage = {
    type: 'saying_msg',
    role: 'assistant',
    genseq: 1,
    content: 'saying-data:380f\n保留',
  };
  const call: FuncCallMsg = {
    type: 'func_call_msg',
    role: 'assistant',
    genseq: 1,
    id: 'call-1',
    name: 'shell_cmd',
    arguments: JSON.stringify({ command: 'printf "Ω"', opaque: '7ae2' }),
  };
  const result: FuncResultMsg = {
    type: 'func_result_msg',
    role: 'tool',
    genseq: 1,
    id: call.id,
    name: call.name,
    content: 'result-data:f628\n引号 " / Ω',
  };
  return { user, thinking, saying, call, result, context: [user, thinking, saying, call, result] };
}

export async function assertInvalidProviderHistories(
  provider: string,
  project: (context: ChatMessage[]) => unknown | Promise<unknown>,
  evidence: ReturnType<typeof semanticEvidenceCollector>,
) {
  const { user, call, result } = providerHistory();
  const later: ChatMessage = {
    ...user,
    genseq: 2,
    msgId: 'user-2',
    content: 'later-input-data:2ba3',
  };
  const rows = [
    { id: 'unresolved-call', context: [user, call, later] },
    { id: 'orphaned-result', context: [user, result, later] },
    { id: 'mismatched-result', context: [user, call, { ...result, id: 'other-call' }, later] },
  ];
  for (const row of rows) {
    const original = structuredClone(row.context);
    let observed: Error | undefined;
    await assert.rejects(
      async () => {
        await project(row.context);
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        observed = error;
        return true;
      },
    );
    assert.ok(observed);
    assert.deepEqual(row.context, original);
    evidence.record({
      id: provider + '-' + row.id,
      scenario: `${provider} rejects an incomplete or incorrectly paired tool history before request construction.`,
      businessValue:
        'Prevent invented tool outcomes or invalid provider replay, while preserving the supplied history for investigation.',
      context: {
        provider,
        input: JSON.stringify(original),
        scope: 'Actual request projection only; no provider request or driver repair is executed.',
      },
      reviewQuestions: [
        'Does the actual diagnostic accurately identify this supplied pairing failure and affected call without inventing a tool result or suggesting that the request was sent?',
      ],
      actualText: `${observed.name}: ${observed.message}`,
    });
  }
}
