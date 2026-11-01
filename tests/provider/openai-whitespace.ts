import nativeAssert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';

async function main() {
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Test whitespace.',
    },
    {
      type: 'thinking_msg',
      role: 'assistant',
      genseq: 1,
      content: '   ',
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 1,
      content: 'x',
    },
  ];

  const input = await buildOpenAiRequestInputWrapper(context);
  // Exact supplied projection data, not a judgment of what its prose means.
  nativeAssert.equal(input.length, 2);
  const assistantContent = input.flatMap((item) =>
    'role' in item && item.role === 'assistant' && 'content' in item ? [item.content] : [],
  );
  nativeAssert.deepEqual(assistantContent, ['   \nx']);

  console.log('✓ OpenAI whitespace test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
