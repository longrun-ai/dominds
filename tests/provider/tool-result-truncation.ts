import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Dialog } from '../../main/dialog';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { buildAnthropicRequestMessagesWrapper } from '../../main/llm/gen/anthropic';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';
import { resolveProviderToolResultMaxChars } from '../../main/llm/gen/tool-output-limit';
import { Team } from '../../main/team';
import { ripgrepSnippetsTool } from '../../main/tools/ripgrep';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpenAiFunctionCallOutputItem(
  value: ResponseInputItem | undefined,
): value is ResponseInputItem & { type: 'function_call_output'; output: string } {
  return (
    isRecord(value) && value.type === 'function_call_output' && typeof value.output === 'string'
  );
}

function isAnthropicToolResultBlock(
  value: unknown,
): value is { type: 'tool_result'; content: string } {
  return isRecord(value) && value.type === 'tool_result' && typeof value.content === 'string';
}

function isAnthropicTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function requireOpenAiToolOutputItem(
  value: ResponseInputItem | undefined,
): ResponseInputItem & { type: 'function_call_output'; output: string } {
  if (value === undefined || !isOpenAiFunctionCallOutputItem(value)) {
    throw new Error('Expected function_call_output item');
  }
  return value;
}

function requireToolMessageContent(value: ChatCompletionMessageParam | undefined): string {
  if (
    value === undefined ||
    !isRecord(value) ||
    value.role !== 'tool' ||
    typeof value.content !== 'string'
  ) {
    throw new Error('Expected tool message');
  }
  return value.content;
}

function requireAnthropicUserToolTurn(
  value: Awaited<ReturnType<typeof buildAnthropicRequestMessagesWrapper>>[number] | undefined,
): { role: 'user'; content: ReadonlyArray<unknown> } {
  if (value === undefined || value.role !== 'user' || !Array.isArray(value.content)) {
    throw new Error('Expected anthropic user function-result turn');
  }
  return value as { role: 'user'; content: ReadonlyArray<unknown> };
}

function getOpenAiToolOutput(input: ResponseInputItem[]): string {
  const item = input.find(
    (
      candidate,
    ): candidate is ResponseInputItem & { type: 'function_call_output'; output: string } =>
      isOpenAiFunctionCallOutputItem(candidate),
  );
  return requireOpenAiToolOutputItem(item).output;
}

function getOpenAiCompatibleToolOutput(messages: ChatCompletionMessageParam[]): string {
  const toolMessage = messages.find(
    (message) =>
      isRecord(message) && message.role === 'tool' && typeof message.content === 'string',
  );
  return requireToolMessageContent(toolMessage);
}

function getAnthropicToolOutput(
  messages: Awaited<ReturnType<typeof buildAnthropicRequestMessagesWrapper>>,
): string {
  const userTurn = requireAnthropicUserToolTurn(
    [...messages].reverse().find((message) => message.role === 'user'),
  );
  const content = userTurn.content;
  const toolResult = content.find((block): block is { type: 'tool_result'; content: string } =>
    isAnthropicToolResultBlock(block),
  );
  if (toolResult !== undefined) {
    return toolResult.content;
  }
  const textBlock = content.find(isAnthropicTextBlock);
  if (textBlock === undefined) {
    throw new Error('Expected Anthropic function result text block');
  }
  return textBlock.text;
}

async function verifyRipgrepYamlTruncationMetadata(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-rg-'));
  try {
    const file = path.join(tmp, 'huge.txt');
    await fs.writeFile(file, 'needle:' + 'x'.repeat(500_000) + '\n', 'utf8');
    const prev = process.cwd();
    process.chdir(tmp);
    try {
      const output = (
        await ripgrepSnippetsTool.call(
          {} as Dialog,
          new Team.Member({ id: 'reader', name: 'Reader', read_dirs: ['**/*'] }),
          { pattern: 'needle', path: '.', max_results: 50 },
        )
      ).content;
      assert(output.includes('truncation:'), 'Expected ripgrep YAML truncation section');
      assert(output.includes('match_original_chars:'), 'Expected per-result original length');
      assert(output.includes('reasons: ['), 'Expected truncation reasons array');
    } finally {
      process.chdir(prev);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function verifyProviderDefaultToolResultLimits(): void {
  assert(
    resolveProviderToolResultMaxChars({ apiType: 'codex' } as Pick<
      ProviderConfig,
      'apiType' | 'tool_result_max_chars'
    >) ===
      8 * 1024 * 1024,
    'Expected Codex default tool-result limit to be 8 MiB',
  );
  assert(
    resolveProviderToolResultMaxChars({ apiType: 'openai' } as Pick<
      ProviderConfig,
      'apiType' | 'tool_result_max_chars'
    >) ===
      8 * 1024 * 1024,
    'Expected OpenAI default tool-result limit to be 8 MiB',
  );
  assert(
    resolveProviderToolResultMaxChars({ apiType: 'openai-compatible' } as Pick<
      ProviderConfig,
      'apiType' | 'tool_result_max_chars'
    >) ===
      4 * 1024 * 1024,
    'Expected OpenAI-compatible default tool-result limit to be 4 MiB',
  );
  assert(
    resolveProviderToolResultMaxChars({ apiType: 'anthropic' } as Pick<
      ProviderConfig,
      'apiType' | 'tool_result_max_chars'
    >) ===
      4 * 1024 * 1024,
    'Expected Anthropic default tool-result limit to be 4 MiB',
  );
  assert(
    resolveProviderToolResultMaxChars({ apiType: 'mock' } as Pick<
      ProviderConfig,
      'apiType' | 'tool_result_max_chars'
    >) ===
      8 * 1024 * 1024,
    'Expected mock default tool-result limit to be 8 MiB',
  );
}

async function main() {
  const providerConfig: ProviderConfig = {
    name: 'test-provider',
    apiType: 'openai',
    baseUrl: 'https://example.test',
    apiKeyEnvVar: 'TEST_API_KEY',
    tool_result_max_chars: 120,
    models: {},
  };
  const longContent = 'tool:' + 'x'.repeat(500);
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Run tool.',
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
      content: longContent,
    },
  ];

  const openAiInput = await buildOpenAiRequestInputWrapper(context, providerConfig);
  const openAiOutput = getOpenAiToolOutput(openAiInput);
  assert(openAiOutput.length <= 120, 'Expected OpenAI tool output to honor provider limit');
  assert(
    openAiOutput.includes('tool_output_truncated_for_provider'),
    'Expected OpenAI truncation marker',
  );

  const openAiCompatibleMessages = await buildOpenAiCompatibleRequestMessagesWrapper('', context, {
    providerConfig: { ...providerConfig, apiType: 'openai-compatible' },
  });
  const openAiCompatibleOutput = getOpenAiCompatibleToolOutput(openAiCompatibleMessages);
  assert(
    openAiCompatibleOutput.length <= 120,
    'Expected OpenAI-compatible tool output to honor provider limit',
  );
  assert(
    openAiCompatibleOutput.includes('tool_output_truncated_for_provider'),
    'Expected OpenAI-compatible truncation marker',
  );

  const anthropicMessages = await buildAnthropicRequestMessagesWrapper(context, {
    ...providerConfig,
    apiType: 'anthropic',
  });
  const anthropicOutput = getAnthropicToolOutput(anthropicMessages);
  assert(anthropicOutput.length <= 120, 'Expected Anthropic tool output to honor provider limit');
  assert(
    anthropicOutput.includes('tool_output_truncated_for_provider'),
    'Expected Anthropic truncation marker',
  );

  await verifyRipgrepYamlTruncationMetadata();
  verifyProviderDefaultToolResultLimits();

  console.log('✓ Provider tool-result truncation test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
