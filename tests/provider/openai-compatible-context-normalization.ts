import { MINIMAX_REASONING_DETAILS_API_QUIRK } from '../../main/llm/api-quirks';
import type { ChatMessage } from '../../main/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function getRole(value: unknown): string {
  if (!isRecord(value)) return 'unknown';
  const role = value.role;
  return typeof role === 'string' ? role : 'unknown';
}

function isAssistantReasoningMessage(
  value: unknown,
): value is { role: 'assistant'; content: string; reasoning_content: string } {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    typeof value.content === 'string' &&
    typeof value.reasoning_content === 'string'
  );
}

function isAssistantReasoningDetailsMessage(
  value: unknown,
): value is { role: 'assistant'; content: string; reasoning_details: unknown[] } {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    typeof value.content === 'string' &&
    Array.isArray(value.reasoning_details)
  );
}

function isAssistantToolCallMessage(value: unknown): value is {
  role: 'assistant';
  content?: unknown;
  reasoning_content?: string;
  tool_calls: ReadonlyArray<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
} {
  if (!isRecord(value) || value.role !== 'assistant' || !Array.isArray(value.tool_calls)) {
    return false;
  }
  return value.tool_calls.every((call) => {
    return (
      isRecord(call) &&
      typeof call.id === 'string' &&
      typeof call.type === 'string' &&
      isRecord(call.function) &&
      typeof call.function.name === 'string' &&
      typeof call.function.arguments === 'string'
    );
  });
}

function isToolMessage(value: unknown): value is { role: 'tool'; tool_call_id: string } {
  return isRecord(value) && value.role === 'tool' && typeof value.tool_call_id === 'string';
}

function requireAssistantReasoningMessage(value: unknown): {
  role: 'assistant';
  content: string;
  reasoning_content: string;
} {
  if (!isAssistantReasoningMessage(value)) {
    throw new Error('Expected assistant message to be an object');
  }
  return value;
}

function requireAssistantToolCallMessage(value: unknown): {
  role: 'assistant';
  content?: unknown;
  reasoning_content?: string;
  tool_calls: ReadonlyArray<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
} {
  if (!isAssistantToolCallMessage(value)) {
    throw new Error('Expected tool call message to be an object');
  }
  return value;
}

function requireToolMessage(value: unknown): { role: 'tool'; tool_call_id: string } {
  if (!isToolMessage(value)) {
    throw new Error('Expected tool message to be an object');
  }
  return value;
}

async function main() {
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Run `ls -la` via tool.',
    },
    {
      type: 'thinking_msg',
      role: 'assistant',
      genseq: 1,
      content: 'I should use a tool.',
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 1,
      content: 'Calling tool now.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 1,
      id: 'call-1',
      name: 'shell_cmd',
      arguments: JSON.stringify({ command: 'ls -la' }),
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'shell_cmd',
      content: 'ok',
    },
  ];

  const messages = await buildOpenAiCompatibleRequestMessagesWrapper('', context);
  const roles = messages.map(getRole);

  assert(
    roles.join(',') === 'user,assistant,assistant,tool',
    `Unexpected roles: ${roles.join(',')}`,
  );

  const assistantMsg = requireAssistantReasoningMessage(messages[1]);
  assert(
    assistantMsg.content === 'Calling tool now.',
    'Expected saying content to remain standalone',
  );
  assert(
    typeof assistantMsg.reasoning_content === 'string' &&
      assistantMsg.reasoning_content === 'I should use a tool.',
    'Expected thinking content to map to assistant.reasoning_content',
  );

  const toolCallMsg = requireAssistantToolCallMessage(messages[2]);
  assert(
    toolCallMsg.reasoning_content === 'I should use a tool.',
    'Expected assistant tool call message to carry reasoning_content',
  );
  assert(
    !Object.prototype.hasOwnProperty.call(toolCallMsg, 'content'),
    'Expected assistant tool call message without visible text to omit content',
  );
  assert(toolCallMsg.tool_calls.length === 1, 'Expected exactly one tool call');
  const call = toolCallMsg.tool_calls[0];
  assert(isRecord(call), 'Expected tool call to be an object');
  assert(call.id === 'call-1', 'Expected tool call id to match');
  assert(call.type === 'function', 'Expected tool call type to be function');
  assert(isRecord(call.function), 'Expected tool call function to be an object');
  assert(call.function.name === 'shell_cmd', 'Expected function name to match');
  assert(typeof call.function.arguments === 'string', 'Expected function arguments to be string');

  const toolMsg = requireToolMessage(messages[3]);
  assert(toolMsg.tool_call_id === 'call-1', 'Expected tool_call_id to match call id');

  const messagesWithDisabledToolCallReasoning = await buildOpenAiCompatibleRequestMessagesWrapper(
    '',
    context,
    {
      providerConfig: {
        name: 'No Tool Call Reasoning',
        apiType: 'openai-compatible',
        apiQuirks: ['disable-assistant-tool-call-reasoning-content'],
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnvVar: 'EXAMPLE_API_KEY',
        models: {
          example: { name: 'example' },
        },
      },
    },
  );
  const disabledToolCallMsg = requireAssistantToolCallMessage(
    messagesWithDisabledToolCallReasoning[2],
  );
  assert(
    disabledToolCallMsg.reasoning_content === undefined,
    'Expected disable-assistant-tool-call-reasoning-content quirk to omit tool call reasoning_content',
  );
  assert(
    messagesWithDisabledToolCallReasoning[1] !== undefined &&
      isAssistantReasoningMessage(messagesWithDisabledToolCallReasoning[1]),
    'Expected disable-assistant-tool-call-reasoning-content quirk to keep text assistant reasoning_content',
  );

  const reasoningDetailsContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 10,
      msgId: 'user-10',
      grammar: 'markdown',
      content: 'Continue after preserved MiniMax reasoning.',
    },
    {
      type: 'thinking_msg',
      role: 'assistant',
      genseq: 10,
      content: 'Preserved MiniMax thinking.',
      provider_data: {
        openai_compatible_reasoning_details: [
          { type: 'reasoning.text', text: 'Preserved MiniMax thinking.', index: 0 },
        ],
      },
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 10,
      content: 'Visible answer.',
    },
  ];
  const genericReasoningDetailsMessages = await buildOpenAiCompatibleRequestMessagesWrapper(
    '',
    reasoningDetailsContext,
  );
  const genericDetailsMessage = requireAssistantReasoningMessage(
    genericReasoningDetailsMessages[1],
  );
  assert(
    genericDetailsMessage.reasoning_content === 'Preserved MiniMax thinking.',
    'Expected non-MiniMax providers to replay preserved reasoning_details as generic reasoning_content',
  );

  const reasoningDetailsMessages = await buildOpenAiCompatibleRequestMessagesWrapper(
    '',
    reasoningDetailsContext,
    {
      providerConfig: {
        name: 'MiniMax Test',
        apiType: 'openai-compatible',
        apiQuirks: [MINIMAX_REASONING_DETAILS_API_QUIRK],
        baseUrl: 'https://api.minimax.io/v1',
        apiKeyEnvVar: 'MINIMAX_API_KEY',
        models: {
          'MiniMax-M2.7': { name: 'MiniMax M2.7' },
        },
      },
    },
  );
  const detailsMessage = reasoningDetailsMessages[1];
  assert(
    isAssistantReasoningDetailsMessage(detailsMessage),
    'Expected preserved reasoning_details to map onto the next MiniMax assistant message',
  );
  assert(
    detailsMessage.reasoning_details[0] !== undefined &&
      isRecord(detailsMessage.reasoning_details[0]) &&
      detailsMessage.reasoning_details[0].text === 'Preserved MiniMax thinking.',
    'Expected reasoning_details payload to keep provider detail text',
  );

  const assistantTurnToolCallContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 11,
      msgId: 'user-11',
      grammar: 'markdown',
      content: 'Use a tool after explaining.',
    },
    {
      type: 'thinking_msg',
      role: 'assistant',
      genseq: 11,
      content: 'Need context before choosing the tool.',
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 11,
      content: 'I will inspect the saved task state first.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 11,
      id: 'call-11',
      name: 'recall_taskdoc',
      arguments: JSON.stringify({ selector: 'current-state' }),
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 11,
      id: 'call-11',
      name: 'recall_taskdoc',
      content: 'state',
    },
  ];
  const assistantTurnMessages = await buildOpenAiCompatibleRequestMessagesWrapper(
    '',
    assistantTurnToolCallContext,
  );
  const assistantTurnToolCallMsg = requireAssistantToolCallMessage(assistantTurnMessages[2]);
  assert(
    assistantTurnToolCallMsg.reasoning_content === 'Need context before choosing the tool.',
    'Expected assistant tool call message to keep the current assistant turn reasoning_content',
  );

  const orphanedCallContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 2,
      msgId: 'user-2',
      grammar: 'markdown',
      content: 'Tool call was interrupted.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 2,
      id: 'call-orphan',
      name: 'shell_cmd',
      arguments: JSON.stringify({ command: 'cat missing.txt' }),
    },
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 3,
      msgId: 'user-3',
      grammar: 'markdown',
      content: 'Continue normally.',
    },
  ];

  let threw = false;
  try {
    await buildOpenAiCompatibleRequestMessagesWrapper('', orphanedCallContext);
  } catch (err) {
    threw = true;
    const message = err instanceof Error ? err.message : String(err);
    assert(
      message.includes('unresolved persisted tool call message detected'),
      'Expected explicit unresolved func_call invariant error',
    );
    assert(message.includes('callId=call-orphan'), 'Expected callId in invariant error');
  }
  assert(threw, 'Expected orphaned func_call provider projection to fail loudly');

  console.log('✓ OpenAI-compatible context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
