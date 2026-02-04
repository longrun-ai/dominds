import type { ChatMessage } from 'dominds/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from 'dominds/llm/gen/openai-compatible';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const missingRelPath = 'artifacts/mcp/test-server/test-tool/missing.png';

  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Here is an image from a tool.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 1,
      id: 'call-1',
      name: 'mcp_test_tool',
      arguments: '{}',
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'mcp_test_tool',
      content: 'tool produced an image',
      contentItems: [
        {
          type: 'input_image',
          mimeType: 'image/png',
          byteLength: 123,
          artifact: {
            rootId: 'missing-root',
            selfId: 'missing-self',
            relPath: missingRelPath,
          },
        },
      ],
    },
  ];

  const messages = await buildOpenAiCompatibleRequestMessagesWrapper('', context);

  const last = messages[messages.length - 1];
  assert(isRecord(last), 'Expected last message to be an object');
  assert(last.role === 'user', 'Expected last message role to be user');
  assert(typeof last.content === 'string', 'Expected last message content to be string fallback');
  assert(
    last.content.includes('image missing') && last.content.includes(missingRelPath),
    'Expected missing image to be downgraded to text',
  );

  console.log('✓ OpenAI-compatible image fallback test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
