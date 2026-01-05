/**
 * Module: llm/gen/anthropic
 *
 * Anthropic Messages API integration implementing streaming and batch generation.
 */
import { Anthropic } from '@anthropic-ai/sdk';
import type {
  MessageCreateParams,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { createLogger } from '../../log';
import { EndOfStream, PubChan } from '../../shared/evt';
import type { Team } from '../../team';
import type { FuncTool, JsonSchema } from '../../tool';
import type { ChatMessage, FuncCallMsg, ProviderConfig } from '../client';
import type { LlmGenerator, LlmStreamReceiver } from '../gen';

const log = createLogger('llm/anthropic');

// Modern TypeScript: Schema adaptation with proper typing
interface AnthropicCompatibleSchema extends JsonSchema {
  [key: string]: unknown;
}

type AnthropicMessageContent = Exclude<MessageParam['content'], string>;

type AnthropicContentBlock = AnthropicMessageContent[number];

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
  const input_schema: AnthropicCompatibleSchema = {
    ...funcTool.parameters,
  };
  return {
    name: funcTool.name,
    description: funcTool.description || '',
    input_schema,
  };
}

/**
 * Context Reconstruction Functions
 *
 * Converts persisted messages with genseq tracking to Anthropic SDK MessageParam[] format.
 * Groups messages by generation sequence and maintains tool call/result relationships.
 */

/**
 * Reconstruct Anthropic context from persisted messages with genseq tracking.
 * Groups messages by generation sequence and converts to SDK MessageParam[] format.
 */
function reconstructAnthropicContext(persistedMessages: ChatMessage[]): MessageParam[] {
  // Group messages by generation sequence
  const messagesByGenseq = new Map<number, ChatMessage[]>();

  for (const msg of persistedMessages) {
    // Extract genseq from message (handle both old and new formats)
    const genseq = 'genseq' in msg && typeof msg.genseq === 'number' ? msg.genseq : 1;

    if (!messagesByGenseq.has(genseq)) {
      messagesByGenseq.set(genseq, []);
    }
    messagesByGenseq.get(genseq)!.push(msg);
  }

  // Sort messages within each generation sequence by their natural ordering
  // (This preserves the order in which they were added to the dialog)
  const sortedGenseqs = Array.from(messagesByGenseq.keys()).sort((a, b) => a - b);

  const reconstructedMessages: MessageParam[] = [];

  for (const genseq of sortedGenseqs) {
    const messages = messagesByGenseq.get(genseq)!;

    // Preserve natural order - aggregate only, no reordering
    // Group messages by role for proper Anthropic message structure
    const assistantContent: AnthropicContentBlock[] = [];
    const toolResults: AnthropicContentBlock[] = [];

    for (const msg of messages) {
      const blocks = chatMessageToContentBlocks(msg);

      for (const block of blocks) {
        if (block.type === 'tool_use') {
          // Tool calls go with assistant message
          assistantContent.push(block);
        } else if (block.type === 'tool_result') {
          // Tool results aggregated into single user message
          toolResults.push(block);
        } else if (msg.role === 'assistant') {
          // Non-tool assistant content (text, thinking)
          assistantContent.push(block);
        }
        // Non-tool user messages (text) are added as-is below
      }

      // Add non-tool user messages directly in natural order
      if (msg.role === 'user' && !msg.type.startsWith('func_')) {
        const blocks = chatMessageToContentBlocks(msg);
        for (const block of blocks) {
          if (block.type !== 'tool_result') {
            reconstructedMessages.push({
              role: 'user',
              content: [block],
            });
          }
        }
      }
    }

    // Add assistant message with aggregated tool calls (if any)
    if (assistantContent.length > 0) {
      reconstructedMessages.push({
        role: 'assistant',
        content: assistantContent,
      });
    }

    // Add user message with aggregated tool results (if any)
    if (toolResults.length > 0) {
      reconstructedMessages.push({
        role: 'user',
        content: toolResults,
      });
    }
  }

  return reconstructedMessages;
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _exhaustive: never = chatMsg;
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

  private handleStreamEvent(
    event: MessageStreamEvent,
    funcCalls: FuncCallMsg[],
    onTextDelta: (textDelta: string) => void,
    genseq: number,
  ): void {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        const textDelta = event.delta.text;
        onTextDelta(textDelta);
      }
    } else if (event.type === 'content_block_start') {
      const contentBlock = event.content_block;
      if (isToolUseBlock(contentBlock)) {
        const toolBlock = contentBlock;
        funcCalls.push({
          type: 'func_call_msg',
          id: toolBlock.id,
          name: toolBlock.name,
          arguments: JSON.stringify(toolBlock.input),
          role: 'assistant',
          genseq: genseq,
        });
      }
    }
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    genseq: number,
  ): Promise<void> {
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

    const stream: AsyncIterable<MessageStreamEvent> = client.messages.stream({
      ...baseParams,
      stream: true,
    } satisfies MessageCreateParamsStreaming);

    // Process stream and yield streams immediately as content becomes available
    let textChunkCount = 0;
    let thinkingChunkCount = 0;
    let usageInfo: { input_tokens: number | null; output_tokens: number | null } | undefined =
      undefined;

    // Stream lifecycle management using SDK start/stop events
    let currentContentBlock: { type: string } | null = null;
    let inputJsonChan: PubChan<string> | undefined;
    let sayingStarted = false;
    let thinkingStarted = false;

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const contentBlock = event.content_block;

          // Handle tool use incident - should not happen in streaming mode
          if (contentBlock.type === 'tool_use') {
            log.error(
              'ANTH streaming incident: tool_use during streaming',
              new Error('Tool call encountered in streaming mode'),
              {
                toolName: contentBlock.name,
                toolId: contentBlock.id,
              },
            );
            throw new Error(
              `Tool call "${contentBlock.name}" (${contentBlock.id}) encountered during streaming mode. ` +
                `Tool calls should not occur in streaming generation. ` +
                `Please check the agent configuration or prompt to ensure streaming compatibility.`,
            );
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
          } else if (
            contentBlock.type === 'server_tool_use' ||
            contentBlock.type === 'web_search_tool_result'
          ) {
            // Tool results can contain partial JSON during streaming
            inputJsonChan = new PubChan<string>();
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
              textChunkCount++;
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
              thinkingChunkCount++;
              await receiver.thinkingChunk(thinkingDelta);
            }
          } else if (delta.type === 'citations_delta') {
            // Handle CitationsDelta - typically just logging for now
          } else if (delta.type === 'signature_delta') {
            // Handle SignatureDelta - typically just logging for now
          } else if (delta.type === 'input_json_delta') {
            // Handle InputJSONDelta - for function calling, log the JSON input
            const partialJson = delta.partial_json;
            if (inputJsonChan && partialJson) {
              inputJsonChan.write(partialJson);
            } else if (partialJson) {
              log.warn(
                'ANTH input_json_delta without active input_json channel',
                new Error('Input JSON delta received but no input_json channel'),
                {
                  hasCurrentBlock: !!currentContentBlock,
                  blockType: currentContentBlock?.type,
                  hasInputJsonChan: !!inputJsonChan,
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
          if (
            currentContentBlock.type === 'server_tool_use' ||
            currentContentBlock.type === 'web_search_tool_result'
          ) {
            inputJsonChan?.write(EndOfStream);
            inputJsonChan = undefined;
          }

          if (currentContentBlock.type === 'thinking') {
            await receiver.thinkingFinish();
            thinkingStarted = false;
          }
          if (currentContentBlock.type === 'text') {
            await receiver.sayingFinish();
            sayingStarted = false;
          }

          currentContentBlock = null;
          break;
        }

        case 'message_start': {
          const message = event.message;
          if (message.usage) {
            usageInfo = message.usage;
          }
          break;
        }

        case 'message_delta': {
          // Modern TypeScript: Access properties directly from typed event
          if ('usage' in event && event.usage) {
            usageInfo = event.usage;
          }
          break;
        }

        case 'message_stop': {
          // Modern TypeScript: Access stop_reason via property access with type narrowing
          const stopReason = 'stop_reason' in event ? event.stop_reason : undefined;

          inputJsonChan?.write(EndOfStream);

          inputJsonChan = undefined;
          currentContentBlock = null;

          // Note: thinking_finish and saying_finish are handled by the driver
          // based on the EndOfStream signals from the streams
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

    inputJsonChan?.write(EndOfStream);
  }

  async genMoreMessages(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    genseq: number,
  ): Promise<ChatMessage[]> {
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

    const response = await client.messages.create({
      ...baseParams,
      stream: false,
    } satisfies MessageCreateParams);

    if (!response) {
      throw new Error('No response from Anthropic API');
    }

    return anthropicToChatMessages(response, genseq);
  }
}
