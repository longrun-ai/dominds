import type { ChatMessage } from '../../main/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function requireStringContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected last message content to be string fallback');
  }
  return value;
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
            status: 'running',
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
  const content = requireStringContent(last.content);
  assert(
    content.includes('image missing') && content.includes(missingRelPath),
    'Expected missing image to be downgraded to text',
  );

  console.log('✓ OpenAI-compatible image fallback test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
