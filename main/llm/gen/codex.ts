/**
 * Module: llm/gen/codex
 *
 * ChatGPT Codex responses integration (streaming-only).
 */
import type {
  ChatGptEventReceiver,
  ChatGptFunctionTool,
  ChatGptJsonSchema,
  ChatGptMessageItem,
  ChatGptMessageRole,
  ChatGptReasoning,
  ChatGptResponseItem,
  ChatGptResponsesRequest,
  ChatGptResponsesStreamEvent,
  ChatGptTextControls,
} from '@dominds/codex-auth';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createLogger } from '../../log';
import type { Team } from '../../team';
import type { FuncTool, JsonSchema, JsonSchemaProperty } from '../../tool';
import type { ChatMessage, ProviderConfig } from '../client';
import type { LlmGenerator, LlmStreamReceiver } from '../gen';

const log = createLogger('llm/codex');
const require = createRequire(__filename);
const codexPromptCache = new Map<string, string>();
const codexFallbackInstructions = 'You are Codex CLI.';

function resolvePromptFilename(model: string): string {
  if (model.startsWith('gpt-5.2-codex') || model.startsWith('bengalfox')) {
    return 'gpt-5.2-codex_prompt.md';
  }
  if (model.startsWith('gpt-5.1-codex-max')) {
    return 'gpt-5.1-codex-max_prompt.md';
  }
  if (
    (model.startsWith('gpt-5-codex') ||
      model.startsWith('gpt-5.1-codex') ||
      model.startsWith('codex-')) &&
    !model.includes('-mini')
  ) {
    return 'gpt_5_codex_prompt.md';
  }
  if (model.startsWith('codex-mini-latest')) {
    return 'prompt_with_apply_patch_instructions.md';
  }
  if (model.startsWith('gpt-5.2')) {
    return 'gpt_5_2_prompt.md';
  }
  if (model.startsWith('gpt-5.1')) {
    return 'gpt_5_1_prompt.md';
  }
  return 'prompt.md';
}

async function loadCodexPrompt(model: string): Promise<string | null> {
  const cached = codexPromptCache.get(model);
  if (cached) {
    return cached;
  }

  let pkgRoot: string;
  try {
    const entryPath = require.resolve('@dominds/codex-auth');
    pkgRoot = path.resolve(path.dirname(entryPath), '..');
  } catch (error: unknown) {
    log.warn('Failed to resolve @dominds/codex-auth prompt directory', error);
    return null;
  }

  const filename = resolvePromptFilename(model);
  const candidates = [
    path.join(pkgRoot, 'prompts', filename),
    path.join(pkgRoot, 'prompts', 'prompt.md'),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const prompt = await fs.readFile(candidate, 'utf8');
      codexPromptCache.set(model, prompt);
      return prompt;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  log.warn(`Failed to read Codex prompt for model '${model}'`, lastError);
  return null;
}

async function resolveCodexInstructions(
  model: string,
  systemPrompt: string,
): Promise<{ instructions: string; assistantPrelude: string | null }> {
  const basePrompt = await loadCodexPrompt(model);
  const trimmedSystemPrompt = systemPrompt.trim();
  if (!basePrompt) {
    return {
      instructions: trimmedSystemPrompt.length > 0 ? systemPrompt : codexFallbackInstructions,
      assistantPrelude: null,
    };
  }
  return {
    instructions: basePrompt,
    assistantPrelude: trimmedSystemPrompt.length > 0 ? trimmedSystemPrompt : null,
  };
}

function jsonSchemaPropertyToCodex(schema: JsonSchemaProperty): ChatGptJsonSchema {
  switch (schema.type) {
    case 'string': {
      const result: ChatGptJsonSchema = { type: 'string' };
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }
    case 'number': {
      const result: ChatGptJsonSchema = { type: 'number' };
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }
    case 'boolean': {
      const result: ChatGptJsonSchema = { type: 'boolean' };
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }
    case 'array': {
      if (!schema.items) {
        throw new Error('Array schema is missing items definition.');
      }
      const result: ChatGptJsonSchema = {
        type: 'array',
        items: jsonSchemaPropertyToCodex(schema.items),
      };
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }
    case 'object': {
      const rawProperties = schema.properties ? schema.properties : {};
      const properties: Record<string, ChatGptJsonSchema> = {};
      for (const [key, value] of Object.entries(rawProperties)) {
        properties[key] = jsonSchemaPropertyToCodex(value);
      }
      const result: ChatGptJsonSchema = {
        type: 'object',
        properties,
      };
      if (schema.required) {
        result.required = schema.required;
      }
      if (schema.additionalProperties !== undefined) {
        result.additionalProperties = schema.additionalProperties;
      }
      return result;
    }
    default: {
      const _exhaustive: never = schema.type;
      throw new Error(`Unsupported schema type: ${_exhaustive}`);
    }
  }
}

function jsonSchemaToCodex(schema: JsonSchema): ChatGptJsonSchema {
  const properties: Record<string, ChatGptJsonSchema> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    properties[key] = jsonSchemaPropertyToCodex(value);
  }

  const result: ChatGptJsonSchema = {
    type: 'object',
    properties,
  };
  if (schema.required) {
    result.required = schema.required;
  }
  if (schema.additionalProperties !== undefined) {
    result.additionalProperties = schema.additionalProperties;
  }
  return result;
}

function funcToolToCodex(funcTool: FuncTool): ChatGptFunctionTool {
  return {
    type: 'function',
    name: funcTool.name,
    description: funcTool.description ?? '',
    strict: true,
    parameters: jsonSchemaToCodex(funcTool.parameters),
  };
}

function messageItem(role: ChatGptMessageRole, text: string): ChatGptMessageItem {
  const contentType = role === 'assistant' ? 'output_text' : 'input_text';
  return {
    type: 'message',
    role,
    content: [
      {
        type: contentType,
        text,
      },
    ],
  };
}

function chatMessageToCodexItems(msg: ChatMessage): ChatGptResponseItem[] {
  switch (msg.type) {
    case 'environment_msg':
    case 'prompting_msg':
      return [messageItem('user', msg.content)];
    case 'transient_guide_msg':
    case 'saying_msg':
    case 'thinking_msg':
      return [messageItem('assistant', msg.content)];
    case 'call_result_msg':
      return [messageItem('user', msg.content)];
    case 'func_call_msg':
      return [
        {
          type: 'function_call',
          name: msg.name,
          arguments: msg.arguments,
          call_id: msg.id,
        },
      ];
    case 'func_result_msg':
      return [
        {
          type: 'function_call_output',
          call_id: msg.id,
          output: msg.content,
        },
      ];
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unsupported chat message: ${_exhaustive}`);
    }
  }
}

function buildCodexRequest(
  agent: Team.Member,
  instructions: string,
  assistantPrelude: string | null,
  funcTools: FuncTool[],
  context: ChatMessage[],
): ChatGptResponsesRequest {
  if (!agent.model) {
    throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
  }

  const input: ChatGptResponseItem[] = [];
  if (assistantPrelude) {
    // Codex backend rejects system messages; pass extra instructions as prior assistant context.
    input.push(messageItem('assistant', assistantPrelude));
  }
  for (const msg of context) {
    const items = chatMessageToCodexItems(msg);
    for (const item of items) {
      input.push(item);
    }
  }

  const openaiParams =
    agent.model_params && agent.model_params.openai ? agent.model_params.openai : undefined;
  let reasoning: ChatGptReasoning | null = null;
  let text: ChatGptTextControls | undefined;

  if (openaiParams && openaiParams.reasoning_effort) {
    reasoning = {
      effort: openaiParams.reasoning_effort,
    };
  }
  if (openaiParams && openaiParams.verbosity) {
    text = {
      verbosity: openaiParams.verbosity,
    };
  }

  return {
    model: agent.model,
    instructions,
    input,
    tools: funcTools.map(funcToolToCodex),
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning,
    store: false,
    stream: true,
    include: [],
    text,
  };
}

export class CodexGen implements LlmGenerator {
  get apiType(): string {
    return 'codex';
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    _genseq: number,
  ): Promise<void> {
    const codexAuth: typeof import('@dominds/codex-auth') = await import('@dominds/codex-auth');
    const manager = new codexAuth.AuthManager();
    const client = await codexAuth.createChatGptClientFromManager(manager, {
      baseUrl: providerConfig.baseUrl,
    });

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }
    const resolvedInstructions = await resolveCodexInstructions(agent.model, systemPrompt);
    const payload = buildCodexRequest(
      agent,
      resolvedInstructions.instructions,
      resolvedInstructions.assistantPrelude,
      funcTools,
      context,
    );

    let sayingStarted = false;
    let thinkingStarted = false;
    let sawOutputText = false;

    const eventReceiver: ChatGptEventReceiver = {
      onEvent: async (event: ChatGptResponsesStreamEvent) => {
        switch (event.type) {
          case 'response.created':
          case 'response.in_progress':
            return;
          case 'response.failed': {
            const error = event.response.error;
            const message =
              error && typeof error.message === 'string' && error.message.length > 0
                ? error.message
                : 'Codex response failed.';
            throw new Error(message);
          }
          case 'response.output_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
              }
              await receiver.sayingChunk(delta);
              sawOutputText = true;
            }
            return;
          }
          case 'response.output_text.done': {
            if (!sawOutputText && event.text.length > 0) {
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
              }
              await receiver.sayingChunk(event.text);
              sawOutputText = true;
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            return;
          }
          case 'response.content_part.added':
          case 'response.content_part.done':
            return;
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (!thinkingStarted) {
                thinkingStarted = true;
                await receiver.thinkingStart();
              }
              await receiver.thinkingChunk(delta);
            }
            return;
          }
          case 'response.reasoning_summary_part.added': {
            if (!thinkingStarted) {
              thinkingStarted = true;
              await receiver.thinkingStart();
            }
            return;
          }
          case 'response.output_item.added':
            return;
          case 'response.output_item.done': {
            switch (event.item.type) {
              case 'function_call':
                await receiver.funcCall(event.item.call_id, event.item.name, event.item.arguments);
                return;
              case 'message': {
                if (!sawOutputText) {
                  let text = '';
                  for (const part of event.item.content) {
                    switch (part.type) {
                      case 'output_text':
                        text += part.text;
                        break;
                      case 'input_text':
                      case 'input_image':
                        break;
                      default: {
                        const _exhaustive: never = part;
                        return _exhaustive;
                      }
                    }
                  }
                  if (text.length > 0) {
                    if (!sayingStarted) {
                      sayingStarted = true;
                      await receiver.sayingStart();
                    }
                    await receiver.sayingChunk(text);
                    await receiver.sayingFinish();
                    sayingStarted = false;
                    sawOutputText = true;
                  }
                }
                return;
              }
              case 'reasoning':
              case 'local_shell_call':
              case 'function_call_output':
              case 'custom_tool_call':
              case 'custom_tool_call_output':
              case 'web_search_call':
              case 'ghost_snapshot':
              case 'compaction':
              case 'compaction_summary':
                return;
              default: {
                const _exhaustive: never = event.item;
                return _exhaustive;
              }
            }
          }
          case 'response.completed': {
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            if (thinkingStarted) {
              await receiver.thinkingFinish();
              thinkingStarted = false;
            }
            return;
          }
          default: {
            const _exhaustive: never = event;
            return _exhaustive;
          }
        }
      },
    };

    try {
      await client.trigger(payload, eventReceiver);
    } catch (error: unknown) {
      log.warn('CODEX streaming error', error);
      throw error;
    } finally {
      if (sayingStarted) {
        await receiver.sayingFinish();
      }
      if (thinkingStarted) {
        await receiver.thinkingFinish();
      }
    }
  }

  async genMoreMessages(
    _providerConfig: ProviderConfig,
    _agent: Team.Member,
    _systemPrompt: string,
    _funcTools: FuncTool[],
    _context: ChatMessage[],
    _genseq: number,
  ): Promise<ChatMessage[]> {
    throw new Error('Codex generator only supports streaming mode.');
  }
}
