/**
 * Module: llm/gen/anthropic
 *
 * Anthropic Messages API integration implementing streaming and batch generation.
 */
import { Anthropic } from '@anthropic-ai/sdk';
import type {
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

import { createLogger } from '../../log';
import { getTextForLanguage } from '../../shared/i18n/text';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { LlmUsageStats } from '../../shared/types/context-health';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, ProviderConfig } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';

const log = createLogger('llm/anthropic');

type AnthropicMessageContent = Exclude<MessageParam['content'], string>;

type AnthropicContentBlock = AnthropicMessageContent[number];

type ActiveToolUse = {
  id: string;
  name: string;
  inputParts: string[];
  initialInput: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isRecord(value) &&
    value.type === 'tool_use' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string'
  );
}

function funcToolToAnthropic(funcTool: FuncTool): Tool {
  // MCP schemas are passed through to providers. Anthropic's SDK types expect a narrower schema
  // shape; runtime compatibility is handled by provider validation + the driver stop policy.
  const input_schema = funcTool.parameters as unknown as Tool['input_schema'];
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  return {
    name: funcTool.name,
    description,
    input_schema,
  };
}

/**
 * Context Reconstruction Functions
 *
 * Converts persisted messages to Anthropic SDK MessageParam[] format.
 * Relies on natural storage order - func_result always follows func_call.
 */

/**
 * Reconstruct Anthropic context from persisted messages.
 * Relies on natural storage order - func_result always follows func_call.
 */
function reconstructAnthropicContext(persistedMessages: ChatMessage[]): MessageParam[] {
  const reconstructed: MessageParam[] = [];

  for (const msg of persistedMessages) {
    // User text messages
    if (msg.role === 'user' && !msg.type.startsWith('func_')) {
      reconstructed.push({
        role: 'user',
        content: [{ type: 'text', text: msg.content }],
      });
    }
    // Assistant text/thinking
    else if (
      msg.role === 'assistant' &&
      (msg.type === 'saying_msg' || msg.type === 'thinking_msg')
    ) {
      reconstructed.push({
        role: 'assistant',
        content: [{ type: 'text', text: msg.content }],
      });
    }
    // Tool call -> immediately followed by tool_result (natural order)
    else if (msg.type === 'func_call_msg') {
      reconstructed.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: msg.id,
            name: msg.name,
            input: JSON.parse(msg.arguments || '{}'),
          },
        ],
      });
    } else if (msg.type === 'func_result_msg') {
      reconstructed.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.id,
            content: msg.content,
          },
        ],
      });
    }
  }

  return reconstructed;
}

/**
 * Convert a single ChatMessage to content blocks for Anthropic SDK.
 * Returns array of content blocks (may contain multiple for complex messages).
 * Handles tool call/result pairing via id fields for proper SDK compatibility.
 */
function chatMessageToContentBlocks(chatMsg: ChatMessage): AnthropicContentBlock[] {
  // Handle TransientGuide messages as text content
  if (chatMsg.type === 'transient_guide_msg') {
    const block: AnthropicContentBlock = { type: 'text', text: chatMsg.content };
    return [block];
  }

  // Handle prompting and reporting messages
  if (chatMsg.type === 'prompting_msg' || chatMsg.type === 'environment_msg') {
    const block: AnthropicContentBlock = { type: 'text', text: chatMsg.content };
    return [block];
  }

  // Handle saying and thinking messages from assistant
  if (chatMsg.type === 'saying_msg' || chatMsg.type === 'thinking_msg') {
    const block: AnthropicContentBlock = { type: 'text', text: chatMsg.content };
    return [block];
  }

  // Handle function calls
  if (chatMsg.type === 'func_call_msg') {
    const parsed: unknown = JSON.parse(chatMsg.arguments || '{}');
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      throw new Error('Invalid func_call_msg.arguments: expected JSON object');
    }
    const block: AnthropicContentBlock = {
      type: 'tool_use',
      id: chatMsg.id,
      name: chatMsg.name,
      input: parsed,
    };
    return [block];
  }

  // Handle function results (LLM-native tool calls)
  if (chatMsg.type === 'func_result_msg') {
    const block: AnthropicContentBlock = {
      type: 'tool_result',
      tool_use_id: chatMsg.id,
      content: chatMsg.content,
    };
    return [block];
  }

  // Handle texting call results (NOT LLM-native, represented as role='user' messages)
  // Texting tools are conversational, not function calls - send as text content
  if (chatMsg.type === 'call_result_msg') {
    const msg: AnthropicContentBlock = {
      type: 'text',
      text: chatMsg.content,
    };
    return [msg];
  }

  // Exhaustiveness check - ensure all ChatMessage types are handled
  throw new Error(`Unsupported ChatMessage type: ${JSON.stringify(chatMsg)}`);
}

function chatMessageToAnthropic(chatMsg: ChatMessage): MessageParam {
  const contentBlocks = chatMessageToContentBlocks(chatMsg);

  if (contentBlocks.length === 0) {
    throw new Error(`No content blocks generated for message: ${JSON.stringify(chatMsg)}`);
  }

  // Determine the role, handling cases where role might not exist
  let role: 'user' | 'assistant' = 'assistant'; // default
  if ('role' in chatMsg) {
    role = chatMsg.role === 'tool' ? 'user' : chatMsg.role;
  }

  return {
    role,
    content: contentBlocks.length === 1 ? contentBlocks : contentBlocks,
  };
}

function anthropicToChatMessages(message: unknown, genseq: number): ChatMessage[] {
  const results: ChatMessage[] = [];

  if (!isRecord(message)) {
    throw new Error('Invalid Anthropic message: expected object');
  }

  const role = message.role;
  const content = message.content;
  if (role !== 'assistant' && role !== 'user') {
    throw new Error('Invalid Anthropic message: missing role');
  }

  const blocks = Array.isArray(content) ? content : [];
  const thinkingBlocks = blocks.filter((block) => isRecord(block) && block.type === 'thinking');
  if (thinkingBlocks.length > 0 && role === 'assistant') {
    const thinkingText = thinkingBlocks
      .map((block) => (typeof block.thinking === 'string' ? block.thinking : ''))
      .join('');
    if (thinkingText) {
      results.push({
        type: 'thinking_msg',
        role: 'assistant',
        content: thinkingText,
        genseq: genseq,
      });
    }
  }

  const textContent = extractTextContent(blocks);
  if (textContent && role === 'assistant') {
    results.push({
      type: 'saying_msg',
      role,
      content: textContent,
      genseq: genseq,
    });
  }
  if (role === 'assistant') {
    const toolBlocks = blocks.filter(isToolUseBlock);
    toolBlocks.forEach((block) => {
      results.push({
        type: 'func_call_msg',
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        role: 'assistant',
        genseq: genseq,
      });
    });
  }

  return results;
}

function extractTextContent(blocks: unknown[]): string {
  return blocks
    .map((block) => {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .join('');
}

/**
 * Validate that reconstructed context produces valid Anthropic SDK MessageParam[].
 * Checks for proper role assignment, content block structure, and tool call/result pairing.
 */
function validateReconstructedContext(messages: MessageParam[]): void {
  for (const msg of messages) {
    // Validate role
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new Error(`Invalid message role: ${msg.role}. Must be 'user' or 'assistant'.`);
    }

    // Validate content blocks
    if (!Array.isArray(msg.content) || msg.content.length === 0) {
      throw new Error('Message must have non-empty content array.');
    }

    for (const block of msg.content) {
      // Validate content block type
      if (!['text', 'thinking', 'tool_use', 'tool_result'].includes(block.type)) {
        throw new Error(`Invalid content block type: ${block.type}`);
      }

      // Validate thinking blocks have signature
      if (block.type === 'thinking' && !block.signature) {
        throw new Error('Thinking blocks must have a signature.');
      }

      // Validate tool_use blocks have required fields
      if (block.type === 'tool_use') {
        if (!block.id || !block.name || block.input === undefined) {
          throw new Error('Tool_use blocks must have id, name, and input fields.');
        }
      }

      // Validate tool_result blocks have required fields
      if (block.type === 'tool_result') {
        // Check for tool_use_id field (Anthropic SDK uses 'tool_use_id' for ToolResultBlockParam)
        const hasToolUseId =
          'tool_use_id' in block &&
          typeof block.tool_use_id === 'string' &&
          block.tool_use_id.length > 0;
        const hasContent = 'content' in block && block.content !== undefined;
        if (!hasToolUseId || !hasContent) {
          throw new Error(
            'Tool_result blocks must have tool_use_id (reference to tool_use) and content fields.',
          );
        }
      }
    }
  }
}

/**
 * Reconstruct Anthropic context from persisted messages with genseq tracking.
 * This function groups messages by generation sequence and converts them to
 * Anthropic SDK MessageParam[] format for context restoration.
 *
 * @param persistedMessages - Array of ChatMessage objects with genseq tracking
 * @returns Array of MessageParam objects in Anthropic SDK format
 */
export function reconstructAnthropicContextWrapper(
  persistedMessages: ChatMessage[],
): MessageParam[] {
  const reconstructed = reconstructAnthropicContext(persistedMessages);

  // Validate the reconstructed context
  try {
    validateReconstructedContext(reconstructed);
  } catch (error) {
    log.error('Context reconstruction validation failed:', error);
    throw new Error(`Invalid reconstructed context: ${error}`);
  }

  return reconstructed;
}

/**
 * AnthropicGen
 *
 * Implements `LlmGenerator` for Anthropic, mapping tool calls and text deltas
 * and providing both streaming and non-streaming generation.
 */
export class AnthropicGen implements LlmGenerator {
  get apiType() {
    return 'anthropic';
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    _genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    const client = new Anthropic({ apiKey, baseURL: providerConfig.baseUrl });

    const requestMessages: MessageParam[] = context.map(chatMessageToAnthropic);

    const anthropicParams = agent.model_params?.anthropic || {};
    const maxTokens = agent.model_params?.max_tokens;

    // Safety check: model should never be undefined at this point due to validation in driver
    if (!agent.model) {
      throw new Error(
        `Internal error: Model is undefined for agent '${agent.id}' after validation`,
      );
    }

    // Get model info from provider config for output_length
    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;

    const baseParams = {
      model: agent.model,
      messages: requestMessages,
      system: systemPrompt.length > 0 ? systemPrompt : undefined,
      max_tokens: maxTokens ?? anthropicParams.max_tokens ?? outputLength ?? 1024,
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToAnthropic) }),
      ...(anthropicParams.temperature !== undefined && {
        temperature: anthropicParams.temperature,
      }),
      ...(anthropicParams.top_p !== undefined && { top_p: anthropicParams.top_p }),
      ...(anthropicParams.top_k !== undefined && { top_k: anthropicParams.top_k }),
      ...(anthropicParams.stop_sequences !== undefined && {
        stop_sequences: anthropicParams.stop_sequences,
      }),
      ...(anthropicParams.reasoning_split !== undefined && {
        reasoning_split: anthropicParams.reasoning_split,
      }),
    };

    const streamParams: MessageCreateParamsStreaming & { signal?: AbortSignal } = {
      ...baseParams,
      stream: true,
      ...(abortSignal ? { signal: abortSignal } : {}),
    };

    const stream: AsyncIterable<MessageStreamEvent> = client.messages.stream(
      streamParams as unknown as MessageCreateParamsStreaming,
    );

    // Stream lifecycle management using SDK start/stop events
    let currentContentBlock: AnthropicMessageContent[number] | null = null;
    let currentToolUse: ActiveToolUse | null = null;
    let sayingStarted = false;
    let thinkingStarted = false;
    let usage: LlmUsageStats = { kind: 'unavailable' };

    for await (const event of stream) {
      if (abortSignal?.aborted) {
        throw new Error('AbortError');
      }
      switch (event.type) {
        case 'content_block_start': {
          const contentBlock = event.content_block;

          // Track tool use so we can emit function calls once JSON is complete
          if (contentBlock.type === 'tool_use') {
            currentToolUse = {
              id: contentBlock.id,
              name: contentBlock.name,
              inputParts: [],
              initialInput: contentBlock.input,
            };
          }

          // Create and yield appropriate stream based on content block type
          if (contentBlock.type === 'text') {
            if (!sayingStarted) {
              sayingStarted = true;
              await receiver.sayingStart();
            }
          } else if (contentBlock.type === 'thinking') {
            if (!thinkingStarted) {
              thinkingStarted = true;
              await receiver.thinkingStart();
            }
          } else if (contentBlock.type === 'tool_use') {
            // Tool use has no streaming text output
          } else {
            // Unexpected content block type
            log.warn(
              'ANTH unexpected content_block_start',
              new Error('Unknown content block type'),
              {
                blockType: contentBlock.type,
              },
            );
          }

          currentContentBlock = contentBlock;
          break;
        }

        case 'content_block_delta': {
          // Only process deltas for known content blocks
          if (!currentContentBlock) {
            log.warn(
              'ANTH unexpected content_block_delta without active content block',
              new Error('Delta received before content_block_start'),
              {
                deltaType: event.delta.type,
              },
            );
            break;
          }

          const delta = event.delta;

          // Handle all RawContentBlockDelta types from Anthropic SDK
          if (delta.type === 'text_delta') {
            const textDelta = delta.text ?? '';
            if (textDelta) {
              await receiver.sayingChunk(textDelta);
            }
          } else if (delta.type === 'thinking_delta') {
            // Lazily start thinking section if delta arrives before content_block_start
            if (!thinkingStarted) {
              thinkingStarted = true;
              await receiver.thinkingStart();
            }
            const thinkingDelta = delta.thinking ?? '';
            if (thinkingDelta) {
              await receiver.thinkingChunk(thinkingDelta);
            }
          } else if (delta.type === 'citations_delta') {
            // Handle CitationsDelta - typically just logging for now
          } else if (delta.type === 'signature_delta') {
            // Handle SignatureDelta - typically just logging for now
          } else if (delta.type === 'input_json_delta') {
            const partialJson = delta.partial_json;
            if (currentToolUse) {
              if (partialJson.length > 0) {
                currentToolUse.inputParts.push(partialJson);
              }
            } else if (partialJson.length > 0) {
              log.warn(
                'ANTH input_json_delta without active tool_use',
                new Error('Input JSON delta received without active tool_use block'),
                {
                  hasCurrentBlock: currentContentBlock !== null,
                  blockType: currentContentBlock ? currentContentBlock.type : 'none',
                },
              );
            }
          }
          break;
        }

        case 'content_block_stop': {
          if (!currentContentBlock) {
            break;
          }
          if (currentContentBlock.type === 'thinking') {
            await receiver.thinkingFinish();
            thinkingStarted = false;
          }
          if (currentContentBlock.type === 'text') {
            await receiver.sayingFinish();
            sayingStarted = false;
          }
          if (currentContentBlock.type === 'tool_use') {
            if (!currentToolUse) {
              log.warn(
                'ANTH tool_use stop without active tool_use',
                new Error('Tool_use block stopped without active tool tracking'),
              );
            } else {
              let argsJson = '';
              if (currentToolUse.inputParts.length > 0) {
                argsJson = currentToolUse.inputParts.join('');
              } else {
                const stringified = JSON.stringify(currentToolUse.initialInput);
                argsJson =
                  typeof stringified === 'string' && stringified.length > 0 ? stringified : '{}';
              }
              await receiver.funcCall(currentToolUse.id, currentToolUse.name, argsJson);
            }
            currentToolUse = null;
          }

          currentContentBlock = null;
          break;
        }

        case 'message_start': {
          const startUsage = event.message.usage;
          const cacheCreation =
            typeof startUsage.cache_creation_input_tokens === 'number'
              ? startUsage.cache_creation_input_tokens
              : 0;
          const cacheRead =
            typeof startUsage.cache_read_input_tokens === 'number'
              ? startUsage.cache_read_input_tokens
              : 0;
          const promptTokens = startUsage.input_tokens + cacheCreation + cacheRead;
          const completionTokens = startUsage.output_tokens;
          usage = {
            kind: 'available',
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          };
          break;
        }

        case 'message_delta': {
          const deltaUsage = event.usage;
          const inputTokens =
            typeof deltaUsage.input_tokens === 'number' ? deltaUsage.input_tokens : null;
          const cacheCreation =
            typeof deltaUsage.cache_creation_input_tokens === 'number'
              ? deltaUsage.cache_creation_input_tokens
              : 0;
          const cacheRead =
            typeof deltaUsage.cache_read_input_tokens === 'number'
              ? deltaUsage.cache_read_input_tokens
              : 0;
          if (usage.kind === 'available') {
            const promptTokens: number =
              inputTokens !== null ? inputTokens + cacheCreation + cacheRead : usage.promptTokens;
            const completionTokens = deltaUsage.output_tokens;
            usage = {
              kind: 'available',
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            };
          } else if (inputTokens !== null) {
            const promptTokens: number = inputTokens + cacheCreation + cacheRead;
            const completionTokens = deltaUsage.output_tokens;
            usage = {
              kind: 'available',
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            };
          }
          break;
        }

        case 'message_stop': {
          currentContentBlock = null;
          currentToolUse = null;

          // Note: thinking_finish and saying_finish are handled via content_block_stop events
          break;
        }

        // Note: input_json_delta is handled within content_block_delta as part of input_json_delta delta type

        default: {
          // Handle unexpected events with proper type checking
          const unknownEvent: unknown = event;
          const eventType =
            isRecord(unknownEvent) && typeof unknownEvent.type === 'string'
              ? unknownEvent.type
              : 'unknown';
          log.warn('ANTH unexpected llm event', new Error('Unknown event type'), {
            eventType,
          });
          break;
        }
      }
    }

    return { usage };
  }

  async genMoreMessages(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmBatchResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    const client = new Anthropic({ apiKey, baseURL: providerConfig.baseUrl });

    const requestMessages: MessageParam[] = context.map(chatMessageToAnthropic);

    const anthropicParams = agent.model_params?.anthropic || {};
    const maxTokens = agent.model_params?.max_tokens;

    // Safety check: model should never be undefined at this point due to validation in driver
    if (!agent.model) {
      throw new Error(
        `Internal error: Model is undefined for agent '${agent.id}' after validation`,
      );
    }

    // Get model info from provider config for output_length
    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;

    const baseParams = {
      model: agent.model,
      messages: requestMessages,
      system: systemPrompt.length > 0 ? systemPrompt : undefined,
      max_tokens: maxTokens ?? anthropicParams.max_tokens ?? outputLength ?? 1024,
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToAnthropic) }),
      ...(anthropicParams.temperature !== undefined && {
        temperature: anthropicParams.temperature,
      }),
      ...(anthropicParams.top_p !== undefined && { top_p: anthropicParams.top_p }),
      ...(anthropicParams.top_k !== undefined && { top_k: anthropicParams.top_k }),
      ...(anthropicParams.stop_sequences !== undefined && {
        stop_sequences: anthropicParams.stop_sequences,
      }),
    };

    const createParams: MessageCreateParamsNonStreaming & { signal?: AbortSignal } = {
      ...baseParams,
      stream: false,
      ...(abortSignal ? { signal: abortSignal } : {}),
    };

    const response = await client.messages.create(createParams);

    if (!response) {
      throw new Error('No response from Anthropic API');
    }

    const responseUsage = response.usage;
    const cacheCreation =
      typeof responseUsage.cache_creation_input_tokens === 'number'
        ? responseUsage.cache_creation_input_tokens
        : 0;
    const cacheRead =
      typeof responseUsage.cache_read_input_tokens === 'number'
        ? responseUsage.cache_read_input_tokens
        : 0;
    const promptTokens = responseUsage.input_tokens + cacheCreation + cacheRead;
    const completionTokens = responseUsage.output_tokens;

    const usage: LlmUsageStats = {
      kind: 'available',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };

    return { messages: anthropicToChatMessages(response, genseq), usage };
  }
}
