/**
 * Module: llm/gen/openai
 *
 * OpenAI Chat Completions API integration with streaming and batch generation.
 */
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncCallMsg, ProviderConfig } from '../client';
import type { LlmGenerator, LlmStreamReceiver } from '../gen';

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function funcToolToOpenAI(funcTool: FuncTool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: funcTool.name,
      description: funcTool.description,
      parameters: funcTool.parameters as unknown as Record<string, unknown>,
    },
  };
}

function convertSystemToDeveloper(message: ChatCompletionMessageParam): ChatCompletionMessageParam {
  // don't map it until openai unsupport 'system' role, many compat providers don't support 'developer' role yet
  return message;

  // if (message.role !== 'system') {
  //   return message;
  // }

  // const systemMessage = message as ChatCompletionSystemMessageParam;
  // const developerMessage: ChatCompletionDeveloperMessageParam = {
  //   role: 'developer',
  //   content: systemMessage.content,
  // };
  // if (systemMessage.name) developerMessage.name = systemMessage.name;
  // return developerMessage;
}

function collectFunctionToolCalls(
  funcCalls: ChatCompletionMessageToolCall[] | undefined,
  genseq: number,
): FuncCallMsg[] {
  if (!funcCalls || funcCalls.length === 0) {
    return [];
  }

  const functionCalls: FuncCallMsg[] = [];
  for (const funcCall of funcCalls) {
    if (funcCall.type !== 'function') continue;
    const functionName = funcCall.function?.name ?? '';
    const functionArguments = funcCall.function?.arguments ?? '';
    const id = funcCall.id ?? functionName ?? '';
    functionCalls.push({
      type: 'func_call_msg',
      id,
      name: functionName,
      arguments: functionArguments,
      role: 'assistant',
      genseq: genseq,
    });
  }
  return functionCalls;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isRecord(part)) {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.refusal === 'string') return part.refusal;
        }
        return '';
      })
      .join('');
  }

  if (isRecord(content)) {
    const candidate = content.text;
    return typeof candidate === 'string' ? candidate : '';
  }

  return '';
}

function chatMessageToOpenAI(chatMsg: ChatMessage): ChatCompletionMessageParam {
  // Handle TransientGuide messages by converting them to assistant role
  if (chatMsg.type === 'transient_guide_msg') {
    const assistantMessage: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: chatMsg.content,
    };
    return assistantMessage;
  }

  // Handle prompting and reporting messages
  if (chatMsg.type === 'prompting_msg' || chatMsg.type === 'environment_msg') {
    const userMessage: ChatCompletionUserMessageParam = {
      role: 'user',
      content: chatMsg.content,
    };
    return userMessage;
  }

  // Handle texting call results (treated as user messages)
  if (chatMsg.type === 'call_result_msg') {
    const userMessage: ChatCompletionUserMessageParam = {
      role: 'user',
      content: chatMsg.content,
    };
    return userMessage;
  }

  // Handle saying and thinking messages from assistant
  if (chatMsg.type === 'saying_msg' || chatMsg.type === 'thinking_msg') {
    return {
      role: 'assistant',
      content: chatMsg.content,
    };
  }

  // Handle function calls
  if (chatMsg.type === 'func_call_msg') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: chatMsg.id,
          type: 'function',
          function: {
            name: chatMsg.name,
            arguments: chatMsg.arguments,
          },
        },
      ],
    };
  }

  // Handle function results (convert to OpenAI tool format)
  if (chatMsg.type === 'func_result_msg') {
    if (!chatMsg.id) {
      throw new Error('func_result message must have an id for tool_call_id');
    }

    const toolMessage: ChatCompletionToolMessageParam = {
      role: 'tool',
      tool_call_id: chatMsg.id,
      content: chatMsg.content || '',
    };
    return toolMessage;
  }

  // Fallback for any unhandled cases
  throw new Error(`Unsupported chat message type`);
}

function openAIToChatMessages(message: ChatCompletionMessageParam, genseq: number): ChatMessage[] {
  if (message.role === 'assistant') {
    const assistantMessage = message as ChatCompletionAssistantMessageParam;
    const results: ChatMessage[] = [];

    const contentText =
      extractTextContent(assistantMessage.content) || assistantMessage.refusal || '';
    if (contentText) {
      results.push({
        type: 'saying_msg',
        role: 'assistant',
        content: contentText,
        genseq: genseq,
      });
    }

    const funcCalls = collectFunctionToolCalls(assistantMessage.tool_calls, genseq);
    funcCalls.forEach((funcCall) => {
      results.push({
        type: 'func_call_msg',
        role: 'assistant',
        id: funcCall.id,
        name: funcCall.name,
        arguments: funcCall.arguments,
        genseq: genseq,
      });
    });

    return results;
  }

  if (message.role === 'user') {
    throw new Error(
      'LLM wrappers should never receive role=user messages - user messages only come from browser via WebSocket',
    );
  }
  if (message.role === 'tool') {
    const toolMessage = message as ChatCompletionToolMessageParam;
    return [
      {
        type: 'func_result_msg',
        role: 'tool',
        genseq: genseq,
        id: toolMessage.tool_call_id,
        name: '',
        content: typeof toolMessage.content === 'string' ? toolMessage.content : '',
      },
    ];
  }

  return [];
}

/**
 * OpenAiGen
 *
 * Implements `LlmGenerator` for OpenAI, translating messages and tool calls
 * and supporting streaming/non-streaming flows.
 */
export class OpenAiGen implements LlmGenerator {
  get apiType() {
    return 'openai';
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

    const client = new OpenAI({ apiKey, baseURL: providerConfig.baseUrl });

    const requestMessages: ChatCompletionMessageParam[] = context.map(chatMessageToOpenAI);

    // Add system prompt if provided
    if (systemPrompt.length > 0) {
      requestMessages.unshift({
        role: 'system',
        content: systemPrompt,
      });
    }

    const normalizedMessages = requestMessages.map(convertSystemToDeveloper);

    // Extract OpenAI-specific parameters from agent.model_params
    const openaiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;

    // Build the base request parameters
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
      messages: normalizedMessages,
      // Add tools if funcTools are provided
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToOpenAI) }),
      // Apply OpenAI-specific parameters conditionally
      ...(openaiParams.temperature !== undefined && { temperature: openaiParams.temperature }),
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
      ...(maxTokens === undefined &&
        openaiParams.max_tokens !== undefined && { max_tokens: openaiParams.max_tokens }),
      ...(maxTokens === undefined &&
        openaiParams.max_tokens === undefined &&
        outputLength !== undefined && { max_tokens: outputLength }),
      ...(openaiParams.top_p !== undefined && { top_p: openaiParams.top_p }),
      ...(openaiParams.frequency_penalty !== undefined && {
        frequency_penalty: openaiParams.frequency_penalty,
      }),
      ...(openaiParams.presence_penalty !== undefined && {
        presence_penalty: openaiParams.presence_penalty,
      }),
      ...(openaiParams.seed !== undefined && { seed: openaiParams.seed }),
      ...(openaiParams.logprobs !== undefined && { logprobs: openaiParams.logprobs }),
      ...(openaiParams.top_logprobs !== undefined && { top_logprobs: openaiParams.top_logprobs }),
      ...(openaiParams.stop !== undefined && { stop: openaiParams.stop }),
      ...(openaiParams.logit_bias !== undefined && { logit_bias: openaiParams.logit_bias }),
      ...(openaiParams.user !== undefined && { user: openaiParams.user }),
      ...(openaiParams.reasoning_effort !== undefined && {
        reasoning_effort: openaiParams.reasoning_effort,
      }),
      ...(openaiParams.verbosity !== undefined && { verbosity: openaiParams.verbosity }),
    };

    const requestParams: ChatCompletionCreateParamsStreaming = {
      ...baseParams,
      stream: true,
    };

    const stream = await client.chat.completions.create(requestParams);

    let started = false;

    // Collect all chunks first
    for await (const chunk of stream) {
      try {
        if (!chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;

        const choice = chunk.choices[0];
        if (!choice || !choice.delta) continue;

        const delta = choice.delta;
        const finishReason = choice.finish_reason;

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (!started) {
            started = true;
            await receiver.sayingStart();
          }
          await receiver.sayingChunk(delta.content);
        }

        if (finishReason) {
          if (started) {
            await receiver.sayingFinish();
            started = false;
          }
        }
      } catch (error) {
        // Skip problematic chunks and continue
        continue;
      }
    }
    if (!started) {
      const requestParamsBatch: ChatCompletionCreateParams = {
        ...baseParams,
        stream: false,
      };
      const batchResponse = await client.chat.completions.create(requestParamsBatch);
      const batchChoice = batchResponse.choices[0];
      const batchMessage = batchChoice?.message;

      if (batchMessage) {
        const msgs = openAIToChatMessages(batchMessage, genseq);
        const assistantText = msgs.find(
          (m): m is import('../client').SayingMsg => m.type === 'saying_msg',
        );
        if (assistantText) {
          const content = assistantText.content;
          await receiver.sayingStart();
          await receiver.sayingChunk(content);
          await receiver.sayingFinish();
        }
      }
    }
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

    const client = new OpenAI({ apiKey, baseURL: providerConfig.baseUrl });

    const requestMessages: ChatCompletionMessageParam[] = context.map(chatMessageToOpenAI);

    // Add system prompt if provided
    if (systemPrompt.length > 0) {
      requestMessages.unshift({
        role: 'system',
        content: systemPrompt,
      });
    }

    const normalizedMessages = requestMessages.map(convertSystemToDeveloper);

    // Extract OpenAI-specific parameters from agent.model_params
    const openaiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;

    // Build the base request parameters
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
      messages: normalizedMessages,
      // Add tools if funcTools are provided
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToOpenAI) }),
      // Apply OpenAI-specific parameters conditionally
      ...(openaiParams.temperature !== undefined && { temperature: openaiParams.temperature }),
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
      ...(maxTokens === undefined &&
        openaiParams.max_tokens !== undefined && { max_tokens: openaiParams.max_tokens }),
      ...(maxTokens === undefined &&
        openaiParams.max_tokens === undefined &&
        outputLength !== undefined && { max_tokens: outputLength }),
      ...(openaiParams.top_p !== undefined && { top_p: openaiParams.top_p }),
      ...(openaiParams.frequency_penalty !== undefined && {
        frequency_penalty: openaiParams.frequency_penalty,
      }),
      ...(openaiParams.presence_penalty !== undefined && {
        presence_penalty: openaiParams.presence_penalty,
      }),
      ...(openaiParams.seed !== undefined && { seed: openaiParams.seed }),
      ...(openaiParams.logprobs !== undefined && { logprobs: openaiParams.logprobs }),
      ...(openaiParams.top_logprobs !== undefined && { top_logprobs: openaiParams.top_logprobs }),
      ...(openaiParams.stop !== undefined && { stop: openaiParams.stop }),
      ...(openaiParams.logit_bias !== undefined && { logit_bias: openaiParams.logit_bias }),
      ...(openaiParams.user !== undefined && { user: openaiParams.user }),
      ...(openaiParams.reasoning_effort !== undefined && {
        reasoning_effort: openaiParams.reasoning_effort,
      }),
      ...(openaiParams.verbosity !== undefined && { verbosity: openaiParams.verbosity }),
    };

    const requestParams: ChatCompletionCreateParams = {
      ...baseParams,
      stream: false,
    };

    const response = await client.chat.completions.create(requestParams);
    const choice = response.choices[0];

    if (!choice?.message) {
      throw new Error('No response from OpenAI API');
    }

    return openAIToChatMessages(choice.message, genseq);
  }
}
