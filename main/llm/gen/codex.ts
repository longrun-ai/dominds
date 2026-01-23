/**
 * Module: llm/gen/codex
 *
 * ChatGPT Codex responses integration (streaming-only).
 */
import type {
  ChatGptEventReceiver,
  ChatGptFunctionTool,
  ChatGptMessageItem,
  ChatGptMessageRole,
  ChatGptReasoning,
  ChatGptResponseItem,
  ChatGptResponsesRequest,
  ChatGptResponsesStreamEvent,
  ChatGptTextControls,
} from '@dominds/codex-auth';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../shared/i18n/text';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { LlmUsageStats } from '../../shared/types/context-health';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, ProviderConfig } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';

const log = createLogger('llm/codex');
const codexFallbackInstructions = 'You are Codex CLI.';

type CodexPromptLoader = (model: string) => Promise<string | null>;

async function resolveCodexInstructions(
  model: string,
  systemPrompt: string,
  loadPrompt: CodexPromptLoader,
): Promise<{ instructions: string; assistantPrelude: string | null }> {
  const basePrompt = await loadPrompt(model);
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

function funcToolToCodex(funcTool: FuncTool): ChatGptFunctionTool {
  // MCP schemas are passed through to providers. Codex tool schema types are narrower; runtime
  // validation is handled by provider rejection + the driver stop policy.
  const parameters = funcTool.parameters as unknown as ChatGptFunctionTool['parameters'];
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  return {
    type: 'function',
    name: funcTool.name,
    description,
    strict: false,
    parameters,
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

  const codexParams = agent.model_params?.codex ?? agent.model_params?.openai;
  let reasoning: ChatGptReasoning | null = null;
  let text: ChatGptTextControls | undefined;

  if (codexParams && codexParams.reasoning_effort) {
    reasoning = {
      effort: codexParams.reasoning_effort,
    };
  }
  if (codexParams && codexParams.verbosity) {
    text = {
      verbosity: codexParams.verbosity,
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
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const codexHomeValue: string = process.env[providerConfig.apiKeyEnvVar] || '~/.codex';
    const codexHome = codexHomeValue.startsWith('~')
      ? process.env['HOME'] + codexHomeValue.substring(1)
      : codexHomeValue;
    // NOTE: `@dominds/codex-auth` is an ESM package (`"type": "module"`). The Dominds backend is
    // compiled as CommonJS, so Node.js requires a dynamic `import()` for runtime access here.
    const codexAuth: typeof import('@dominds/codex-auth') = await import('@dominds/codex-auth');
    const manager = new codexAuth.AuthManager({ codexHome });
    const client = await codexAuth.createChatGptClientFromManager(manager, {
      baseUrl: providerConfig.baseUrl,
    });

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }
    const resolvedInstructions = await resolveCodexInstructions(
      agent.model,
      systemPrompt,
      codexAuth.loadCodexPrompt,
    );
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
    let usage: LlmUsageStats = { kind: 'unavailable' };

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
            const responseUsage = event.response.usage;
            if (
              responseUsage &&
              typeof responseUsage.input_tokens === 'number' &&
              typeof responseUsage.output_tokens === 'number'
            ) {
              usage = {
                kind: 'available',
                promptTokens: responseUsage.input_tokens,
                completionTokens: responseUsage.output_tokens,
                totalTokens:
                  typeof responseUsage.total_tokens === 'number'
                    ? responseUsage.total_tokens
                    : responseUsage.input_tokens + responseUsage.output_tokens,
              };
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
      await client.trigger(payload, eventReceiver, abortSignal ? { signal: abortSignal } : {});
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

    return { usage };
  }

  async genMoreMessages(
    _providerConfig: ProviderConfig,
    _agent: Team.Member,
    _systemPrompt: string,
    _funcTools: FuncTool[],
    _context: ChatMessage[],
    _genseq: number,
  ): Promise<LlmBatchResult> {
    throw new Error('Codex generator only supports streaming mode.');
  }
}
