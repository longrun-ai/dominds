import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { buildAnthropicRequestMessagesWrapper } from '../../main/llm/gen/anthropic';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';
import {
  ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  buildImageBudgetKeyForContentItem,
  OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  selectLatestImagesWithinBudget,
} from '../../main/llm/gen/tool-result-image-ingest';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpenAiFunctionCallOutputArray(
  value: ResponseInputItem | undefined,
): value is ResponseInputItem & {
  type: 'function_call_output';
  output: Array<{ type: string; text?: string }>;
} {
  return isRecord(value) && value.type === 'function_call_output' && Array.isArray(value.output);
}

function listOpenAiOutputTexts(input: ResponseInputItem[]): string[] {
  const item = input.find((candidate) => isOpenAiFunctionCallOutputArray(candidate));
  if (!item) {
    throw new Error('Expected OpenAI function_call_output item with array output');
  }
  return item.output
    .filter(
      (candidate): candidate is { type: 'input_text'; text: string } =>
        isRecord(candidate) &&
        candidate.type === 'input_text' &&
        typeof candidate.text === 'string',
    )
    .map((candidate) => candidate.text);
}

function listOpenAiCompatibleOutputTexts(messages: ChatCompletionMessageParam[]): string[] {
  const last = messages[messages.length - 1];
  if (!last || !isRecord(last) || last.role !== 'user') {
    throw new Error('Expected final OpenAI-compatible user message');
  }
  if (typeof last.content === 'string') return [last.content];
  if (Array.isArray(last.content)) {
    return last.content
      .filter(
        (part): part is Extract<ChatCompletionContentPart, { type: 'text' }> =>
          isRecord(part) && part.type === 'text' && typeof part.text === 'string',
      )
      .map((part) => part.text);
  }
  throw new Error('Expected OpenAI-compatible content to be string or parts');
}

function listAnthropicToolResultTexts(
  messages: Awaited<ReturnType<typeof buildAnthropicRequestMessagesWrapper>>,
): string[] {
  const userTurn = [...messages].reverse().find((message) => message.role === 'user');
  if (!userTurn || !Array.isArray(userTurn.content)) {
    throw new Error('Expected Anthropic user function-result turn');
  }
  return userTurn.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text);
}

function countSubstringOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  return text.split(needle).length - 1;
}

function buildImageItems(byteLengths: number[], prefix: string): ChatMessage['contentItems'] {
  return byteLengths.map((byteLength, index) => ({
    type: 'input_image' as const,
    mimeType: 'image/png',
    byteLength,
    artifact: {
      rootId: 'root',
      selfId: 'self',
      status: 'running' as const,
      relPath: `artifacts/demo/${prefix}-${String(index + 1)}.png`,
    },
  }));
}

async function main() {
  const twentyMiB = 20 * 1024 * 1024;
  const unifiedBudgetContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-old',
      grammar: 'markdown',
      content: 'old user image',
      contentItems: buildImageItems([twentyMiB], 'unified-user-old'),
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-new',
      name: 'demo_tool',
      content: 'newer tool image',
      contentItems: buildImageItems([twentyMiB], 'unified-tool-new'),
    },
  ];
  const oldUserMsg = unifiedBudgetContext[0];
  const newToolMsg = unifiedBudgetContext[1];
  if (!oldUserMsg || !newToolMsg) {
    throw new Error('Expected unified image budget test messages');
  }
  const oldUserItems = oldUserMsg.contentItems;
  const newToolItems = newToolMsg.contentItems;
  const oldUserImage = oldUserItems?.[0];
  const newToolImage = newToolItems?.[0];
  if (!oldUserImage || oldUserImage.type !== 'input_image') {
    throw new Error('Expected old user image test fixture');
  }
  if (!newToolImage || newToolImage.type !== 'input_image') {
    throw new Error('Expected new tool image test fixture');
  }
  const oldUserKey = buildImageBudgetKeyForContentItem({
    msg: oldUserMsg,
    itemIndex: 0,
    artifact: oldUserImage.artifact,
  });
  const newToolKey = buildImageBudgetKeyForContentItem({
    msg: newToolMsg,
    itemIndex: 0,
    artifact: newToolImage.artifact,
  });
  const unifiedAllowedKeys = selectLatestImagesWithinBudget(
    unifiedBudgetContext,
    ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  );
  assert(
    !unifiedAllowedKeys.has(oldUserKey) && unifiedAllowedKeys.has(newToolKey),
    'Expected the unified image budget to keep the newest image across user and tool sources',
  );

  const baseContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Analyze the tool image.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 1,
      id: 'call-1',
      name: 'demo_tool',
      arguments: '{}',
    },
  ];

  const openAiContext: ChatMessage[] = [
    ...baseContext,
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'demo_tool',
      content: 'tool produced three images',
      contentItems: buildImageItems([twentyMiB, twentyMiB, twentyMiB], 'openai-budget'),
    },
  ];

  const openAiProviderConfig: ProviderConfig = {
    name: 'test-openai',
    apiType: 'openai',
    baseUrl: 'https://example.test',
    apiKeyEnvVar: 'TEST_API_KEY',
    models: {},
  };
  const openAiInput = await buildOpenAiRequestInputWrapper(openAiContext, openAiProviderConfig);
  const openAiTexts = listOpenAiOutputTexts(openAiInput);
  const openAiJoinedText = openAiTexts.join('\n');
  assert(
    openAiJoinedText.includes('request image budget exceeded'),
    'Expected OpenAI to omit the oldest image once request image budget is exceeded',
  );
  assert(
    countSubstringOccurrences(openAiJoinedText, '[image missing:') === 2,
    'Expected OpenAI to keep the two newest images within the 50 MiB budget',
  );
  assert(
    3 * twentyMiB > OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES &&
      2 * twentyMiB <= OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
    'OpenAI budget test constants must straddle the configured budget',
  );

  const anthropicContext: ChatMessage[] = [
    ...baseContext,
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'demo_tool',
      content: 'tool produced two images',
      contentItems: buildImageItems([twentyMiB, twentyMiB], 'anthropic-budget'),
    },
  ];
  const anthropicMessages = await buildAnthropicRequestMessagesWrapper(anthropicContext, {
    ...openAiProviderConfig,
    apiType: 'anthropic',
  });
  const anthropicTexts = listAnthropicToolResultTexts(anthropicMessages);
  const anthropicJoinedText = anthropicTexts.join('\n');
  assert(
    anthropicJoinedText.includes('request image budget exceeded'),
    'Expected Anthropic to omit the oldest image once request image budget is exceeded',
  );
  assert(
    countSubstringOccurrences(anthropicJoinedText, '[image missing:') === 1,
    'Expected Anthropic to keep only the newest image within the 32 MiB budget',
  );
  assert(
    2 * twentyMiB > ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES &&
      twentyMiB <= ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
    'Anthropic budget test constants must straddle the configured budget',
  );

  const openAiCompatibleContext: ChatMessage[] = [
    ...baseContext,
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'demo_tool',
      content: 'tool produced three images',
      contentItems: buildImageItems([twentyMiB, twentyMiB, twentyMiB], 'openai-compatible-budget'),
    },
  ];
  const openAiCompatibleMessages = await buildOpenAiCompatibleRequestMessagesWrapper(
    '',
    openAiCompatibleContext,
    {
      dialogSelfId: 'self',
      dialogRootId: 'root',
      providerKey: 'openai-compatible',
      modelKey: 'vision-model',
    },
    {
      providerConfig: {
        ...openAiProviderConfig,
        apiType: 'openai-compatible',
        models: {
          'vision-model': {
            supports_image_input: true,
          },
        },
      },
    },
  );
  const openAiCompatibleTexts = listOpenAiCompatibleOutputTexts(openAiCompatibleMessages);
  const openAiCompatibleJoinedText = openAiCompatibleTexts.join('\n');
  assert(
    openAiCompatibleJoinedText.includes('request image budget exceeded'),
    'Expected OpenAI-compatible to omit the oldest image once request image budget is exceeded',
  );
  assert(
    countSubstringOccurrences(openAiCompatibleJoinedText, '[image missing:') === 2,
    'Expected OpenAI-compatible to keep the two newest images within the 50 MiB budget',
  );
  assert(
    3 * twentyMiB > OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES &&
      2 * twentyMiB <= OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
    'OpenAI-compatible budget test constants must straddle the configured budget',
  );

  console.log('✓ Provider image budget fallback test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
