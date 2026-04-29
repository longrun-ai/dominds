import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { buildAnthropicRequestMessagesWrapper } from '../../main/llm/gen/anthropic';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(message: MessageParam | undefined): unknown[] {
  if (!message || typeof message.content === 'string') return [];
  return Array.isArray(message.content) ? message.content : [];
}

function textBlocks(blocks: unknown[]): string[] {
  return blocks
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text);
}

function imageBlockCount(blocks: unknown[]): number {
  return blocks.filter((block) => isRecord(block) && block.type === 'image').length;
}

function buildImageItem(relPath: string): NonNullable<ChatMessage['contentItems']>[number] {
  return {
    type: 'input_image',
    mimeType: 'image/png',
    byteLength: 123,
    artifact: {
      rootId: 'root',
      selfId: 'self',
      status: 'running',
      relPath,
    },
  };
}

async function main() {
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Please inspect the attached user image.',
      contentItems: [buildImageItem('artifacts/user-input/user-1/pasted.png')],
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 1,
      id: 'call-1',
      name: 'demo_tool',
      arguments: '{}',
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'demo_tool',
      content: 'tool produced an image',
      contentItems: [buildImageItem('artifacts/mcp/demo-tool/result.png')],
    },
  ];
  const providerConfig: ProviderConfig = {
    name: 'MiniMax International',
    apiType: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    models: {
      'MiniMax-M2.7': {
        name: 'MiniMax M2.7',
        supports_image_input: false,
      },
    },
  };

  const messages = await buildAnthropicRequestMessagesWrapper(
    context,
    {
      dialogSelfId: 'self',
      dialogRootId: 'root',
      providerKey: 'minimax.io',
      modelKey: 'MiniMax-M2.7',
    },
    providerConfig,
  );

  const firstUserBlocks = contentBlocks(messages.find((message) => message.role === 'user'));
  assert(imageBlockCount(firstUserBlocks) === 0, 'Expected user image to be omitted');
  assert(
    textBlocks(firstUserBlocks).some((text) =>
      text.includes('current model does not support image input'),
    ),
    'Expected user image omission text for unsupported model',
  );

  const lastUserBlocks = contentBlocks(
    [...messages].reverse().find((message) => message.role === 'user'),
  );
  assert(imageBlockCount(lastUserBlocks) === 0, 'Expected tool-result image to be omitted');
  assert(
    textBlocks(lastUserBlocks).some((text) =>
      text.includes('current model does not support image input'),
    ),
    'Expected tool-result image omission text for unsupported model',
  );

  console.log('ok provider user image model support test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
