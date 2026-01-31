import type { ChatMessage } from 'dominds/llm/client';
import { buildOpenAiRequestInputWrapper } from 'dominds/llm/gen/openai';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function findFirstAssistantMessageContent(input: unknown[]): string | null {
  for (const item of input) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      'role' in item &&
      'content' in item
    ) {
      const candidate = item as { type?: unknown; role?: unknown; content?: unknown };
      if (
        candidate.type === 'message' &&
        candidate.role === 'assistant' &&
        typeof candidate.content === 'string'
      ) {
        return candidate.content;
      }
    }
  }
  return null;
}

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

  const input = buildOpenAiRequestInputWrapper(context);
  const assistantContent = findFirstAssistantMessageContent(input);
  assert(assistantContent !== null, 'Expected an assistant message item');
  assert(
    assistantContent === '   \nx',
    `Expected leading whitespace to be preserved. Got:\n${JSON.stringify(assistantContent)}`,
  );

  console.log('✓ OpenAI whitespace test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
