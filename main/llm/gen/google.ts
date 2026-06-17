/**
 * Module: llm/gen/google
 *
 * Google Gemini API integration implementing streaming and batch generation.
 * Rationale:
 * - Direct native integration via the official `@google/genai` SDK.
 * - Supports reasoning/thinking segments via Gemini 2.0+ `thought` parts.
 * - Supports functional tools/declarations and correlated response structures.
 */

import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
} from '@google/genai';
import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../runtime/i18n-text';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import { ChatMessage, FuncResultMsg, ProviderConfig } from '../client';
import {
  type LlmBatchOutput,
  type LlmBatchResult,
  type LlmFailureDisposition,
  type LlmGenerator,
  type LlmRequestContext,
  type LlmStreamReceiver,
  type LlmStreamResult,
  type ToolResultImageIngest,
  type UserImageIngest,
} from '../gen';
import { isVisionImageMimeType } from './artifacts';
import {
  readErrorCode,
  readErrorMessage,
  readErrorStatus,
  readProviderSuggestedRetryAfterMs,
} from './failure-classifier';
import {
  buildImageBudgetKeyForContentItem,
  buildImageBudgetLimitDetail,
  buildToolResultImageIngest,
  buildUserImageIngest,
  GEMINI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  readToolResultImageBytesSafe,
  resolveModelImageInputSupport,
  selectLatestImagesWithinBudget,
} from './tool-result-image-ingest';

const log = createLogger('llm/google');

export class GoogleGen implements LlmGenerator {
  readonly apiType: string;

  constructor(apiType: string = 'google') {
    this.apiType = apiType;
  }

  classifyFailure(error: unknown): LlmFailureDisposition | undefined {
    const message = readErrorMessage(error) ?? 'Unknown Google GenAI error';
    const msg = message.toLowerCase();

    // 1. Check for abort/cancellation error
    if (
      msg.includes('abort') ||
      msg.includes('cancel') ||
      (error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError'))
    ) {
      return {
        kind: 'rejected',
        message: 'Aborted.',
        code: 'ABORTED',
      };
    }

    const status = readErrorStatus(error);
    const code = readErrorCode(error);

    // 2. Check for rate limit / quota limits (429)
    if (status === 429 || msg.includes('quota') || msg.includes('limit') || msg.includes('429')) {
      return {
        kind: 'retriable',
        message,
        status: 429,
        code: code || 'RESOURCE_EXHAUSTED',
        retryStrategy: 'smart_rate',
        retryAfterMs: readProviderSuggestedRetryAfterMs(error),
      };
    }

    // 3. Check for auth/keys/permission errors (401/403)
    if (
      status === 401 ||
      status === 403 ||
      msg.includes('auth') ||
      msg.includes('key') ||
      msg.includes('401') ||
      msg.includes('403')
    ) {
      return {
        kind: 'rejected',
        message,
        status: status ?? 401,
        code: code || 'UNAUTHENTICATED',
      };
    }

    // 4. Check for invalid request, bad parameters (400, 404, etc.)
    if (status === 400 || status === 404 || status === 413 || status === 422) {
      return {
        kind: 'rejected',
        message,
        status,
        code: code || 'INVALID_ARGUMENT',
      };
    }

    // 5. Check for 5xx errors or other server errors (retriable)
    if (status !== undefined || code !== undefined) {
      return {
        kind: 'retriable',
        message,
        status,
        code,
        retryStrategy: 'conservative',
      };
    }

    // Fall back to the generic LLM failure classifier for transport/network issues.
    return undefined;
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    requestContext: LlmRequestContext,
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) {
      throw new Error(`Google API key not found in env var ${providerConfig.apiKeyEnvVar}`);
    }

    const ai = new GoogleGenAI({
      apiKey,
      ...(providerConfig.baseUrl ? { httpOptions: { baseUrl: providerConfig.baseUrl } } : {}),
    });
    const modelKey = requestContext.modelKey || agent.model || 'gemini-2.5-flash';

    const geminiContents: Content[] = await buildGeminiRequestInput(
      context,
      requestContext,
      providerConfig,
      receiver.toolResultImageIngest ? receiver.toolResultImageIngest.bind(receiver) : undefined,
      receiver.userImageIngest ? receiver.userImageIngest.bind(receiver) : undefined,
    );
    const modelParams = agent.model_params?.google || {};

    const geminiTools: any[] = [];
    if (funcTools.length > 0) {
      geminiTools.push({ functionDeclarations: funcTools.map(funcToolToGeminiFunction) });
    }
    if (modelParams.google_search_tool) {
      geminiTools.push({ googleSearch: {} });
    }
    const finalTools = geminiTools.length > 0 ? geminiTools : undefined;

    const requirement = requestContext.toolUseRequirement ?? 'auto';
    if (funcTools.length === 0 && requirement === 'required') {
      throw new Error(
        `Google request invariant violation: toolUseRequirement=required but no tools are available (dialog=${requestContext.dialogSelfId})`,
      );
    }

    const config: GenerateContentConfig = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      ...(requirement !== 'none' && finalTools ? { tools: finalTools } : {}),
      ...(modelParams.temperature !== undefined && { temperature: modelParams.temperature }),
      ...(modelParams.top_p !== undefined && { topP: modelParams.top_p }),
      ...(abortSignal && { abortSignal }),
    };

    if (requirement === 'required' && finalTools) {
      config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
    } else if (requirement === 'none' && finalTools) {
      config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
    } else if (finalTools) {
      config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
    }

    if (agent.model_params?.json_response) {
      config.responseMimeType = 'application/json';
    }

    const supportsThinking = providerConfig.models[modelKey]?.supports_thinking;
    const defaultThinking = providerConfig.models[modelKey]?.default_thinking;
    const thinkingEnabled =
      modelParams.thinking !== undefined ? modelParams.thinking : defaultThinking;

    if (supportsThinking) {
      if (thinkingEnabled) {
        config.thinkingConfig = {};
        if (modelParams.thinking_budget !== undefined) {
          config.thinkingConfig.thinkingBudget = modelParams.thinking_budget;
        }
      } else {
        config.thinkingConfig = {
          thinkingBudget: 0,
        };
      }
    }

    let state: 'idle' | 'thinking' | 'saying' = 'idle';
    let funcCallCounter = 0;
    let finalUsage: LlmUsageStats | undefined;

    try {
      const responseStream = await ai.models.generateContentStream({
        model: modelKey,
        contents: geminiContents,
        config,
      });

      for await (const chunk of responseStream) {
        if (abortSignal?.aborted) {
          throw new Error('AbortError');
        }

        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          const content = candidate.content;
          if (!content) continue;
          const parts = content.parts || [];
          for (const part of parts) {
            if (part.thought === true) {
              if (state === 'idle') {
                state = 'thinking';
                await receiver.thinkingStart();
              } else if (state === 'saying') {
                state = 'thinking';
                await receiver.sayingFinish();
                await receiver.thinkingStart();
              }
              if (part.text) {
                await receiver.thinkingChunk(part.text);
              }
            } else if (part.text) {
              if (state === 'idle') {
                state = 'saying';
                await receiver.sayingStart();
              } else if (state === 'thinking') {
                state = 'saying';
                await receiver.thinkingFinish();
                await receiver.sayingStart();
              }
              await receiver.sayingChunk(part.text);
            } else if (part.functionCall) {
              const name = part.functionCall.name;
              if (!name) {
                throw new Error(
                  `Gemini functionCall missing name (callId=${part.functionCall.id || 'unknown'})`,
                );
              }
              if (state === 'thinking') {
                state = 'idle';
                await receiver.thinkingFinish();
              } else if (state === 'saying') {
                state = 'idle';
                await receiver.sayingFinish();
              }
              const callId = part.functionCall.id || `call_gemini_${genseq}_${funcCallCounter++}`;
              const argsStr = JSON.stringify(part.functionCall.args || {});
              await receiver.funcCall(callId, name, argsStr);
            }
          }
        }

        if (chunk.usageMetadata) {
          finalUsage = {
            kind: 'available',
            promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: chunk.usageMetadata.totalTokenCount ?? undefined,
          };
        }
      }

      if (state === 'thinking') {
        await receiver.thinkingFinish();
      } else if (state === 'saying') {
        await receiver.sayingFinish();
      }

      return {
        usage: finalUsage || { kind: 'unavailable' },
        llmGenModel: modelKey,
      };
    } catch (err: unknown) {
      if (state === 'thinking') {
        await receiver.thinkingFinish();
      } else if (state === 'saying') {
        await receiver.sayingFinish();
      }
      throw err;
    }
  }

  async genMoreMessages(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    requestContext: LlmRequestContext,
    context: ChatMessage[],
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmBatchResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) {
      throw new Error(`Google API key not found in env var ${providerConfig.apiKeyEnvVar}`);
    }

    const ai = new GoogleGenAI({
      apiKey,
      ...(providerConfig.baseUrl ? { httpOptions: { baseUrl: providerConfig.baseUrl } } : {}),
    });
    const modelKey = requestContext.modelKey || agent.model || 'gemini-2.5-flash';

    const geminiContents: Content[] = await buildGeminiRequestInput(
      context,
      requestContext,
      providerConfig,
    );
    const modelParams = agent.model_params?.google || {};

    const geminiTools: any[] = [];
    if (funcTools.length > 0) {
      geminiTools.push({ functionDeclarations: funcTools.map(funcToolToGeminiFunction) });
    }
    if (modelParams.google_search_tool) {
      geminiTools.push({ googleSearch: {} });
    }
    const finalTools = geminiTools.length > 0 ? geminiTools : undefined;

    const requirement = requestContext.toolUseRequirement ?? 'auto';
    if (funcTools.length === 0 && requirement === 'required') {
      throw new Error(
        `Google request invariant violation: toolUseRequirement=required but no tools are available (dialog=${requestContext.dialogSelfId})`,
      );
    }

    const config: GenerateContentConfig = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      ...(requirement !== 'none' && finalTools ? { tools: finalTools } : {}),
      ...(modelParams.temperature !== undefined && { temperature: modelParams.temperature }),
      ...(modelParams.top_p !== undefined && { topP: modelParams.top_p }),
      ...(abortSignal && { abortSignal }),
    };

    if (requirement === 'required' && finalTools) {
      config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
    } else if (requirement === 'none' && finalTools) {
      config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
    } else if (finalTools) {
      config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
    }

    if (agent.model_params?.json_response) {
      config.responseMimeType = 'application/json';
    }

    const supportsThinking = providerConfig.models[modelKey]?.supports_thinking;
    const defaultThinking = providerConfig.models[modelKey]?.default_thinking;
    const thinkingEnabled =
      modelParams.thinking !== undefined ? modelParams.thinking : defaultThinking;

    if (supportsThinking) {
      if (thinkingEnabled) {
        config.thinkingConfig = {};
        if (modelParams.thinking_budget !== undefined) {
          config.thinkingConfig.thinkingBudget = modelParams.thinking_budget;
        }
      } else {
        config.thinkingConfig = {
          thinkingBudget: 0,
        };
      }
    }

    const response = await ai.models.generateContent({
      model: modelKey,
      contents: geminiContents,
      config,
    });

    const outputs: LlmBatchOutput[] = [];
    const messages: ChatMessage[] = [];
    let thinkingContent = '';
    let sayingContent = '';

    const candidate = response.candidates?.[0];
    if (candidate && candidate.content) {
      const parts = candidate.content.parts || [];
      let funcCallCounter = 0;

      for (const part of parts) {
        if (part.thought === true) {
          if (part.text) {
            thinkingContent += part.text;
          }
        } else if (part.text) {
          sayingContent += part.text;
        } else if (part.functionCall) {
          const name = part.functionCall.name;
          if (!name) {
            throw new Error(
              `Gemini functionCall missing name (callId=${part.functionCall.id || 'unknown'})`,
            );
          }
          const callId = part.functionCall.id || `call_gemini_${genseq}_${funcCallCounter++}`;
          const argsStr = JSON.stringify(part.functionCall.args || {});
          outputs.push({
            kind: 'message',
            message: {
              type: 'func_call_msg',
              role: 'assistant',
              genseq,
              id: callId,
              name,
              arguments: argsStr,
            },
          });
          messages.push({
            type: 'func_call_msg',
            role: 'assistant',
            genseq,
            id: callId,
            name: name,
            arguments: argsStr,
          });
        }
      }
    }

    if (thinkingContent) {
      messages.unshift({
        type: 'thinking_msg',
        role: 'assistant',
        genseq,
        content: thinkingContent,
      });
    }
    if (sayingContent) {
      outputs.push({
        kind: 'message',
        message: {
          type: 'saying_msg',
          role: 'assistant',
          genseq,
          content: sayingContent,
        },
      });
      messages.push({
        type: 'saying_msg',
        role: 'assistant',
        genseq,
        content: sayingContent,
      });
    }

    const usage: LlmUsageStats = response.usageMetadata
      ? {
          kind: 'available',
          promptTokens: response.usageMetadata.promptTokenCount ?? 0,
          completionTokens: response.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: response.usageMetadata.totalTokenCount ?? undefined,
        }
      : { kind: 'unavailable' };

    return {
      messages,
      outputs,
      usage,
      llmGenModel: modelKey,
    };
  }
}

async function userLikeMessageToGeminiContentWithImages(
  msg: Extract<
    ChatMessage,
    { type: 'prompting_msg' | 'tellask_result_msg' | 'tellask_carryover_msg' }
  >,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<Content> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return chatMessageToGeminiContent(msg);
  }

  const parts: Content['parts'] = [{ text: msg.content }];
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    true,
  );
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      parts.push({ text: item.text });
      continue;
    }
    if (item.type === 'input_image') {
      if (!supportsImageInput) {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_model_unsupported',
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image not sent: current model does not support image input]` });
        continue;
      }
      if (!isVisionImageMimeType(item.mimeType)) {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_mime_unsupported',
              mimeType: item.mimeType,
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image not sent: unsupported mimeType=${item.mimeType}]` });
        continue;
      }
      if (
        !allowedImageKeys.has(
          buildImageBudgetKeyForContentItem({ msg, itemIndex, artifact: item.artifact }),
        )
      ) {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_size_limit',
              detail: buildImageBudgetLimitDetail({
                byteLength: item.byteLength,
                budgetBytes: GEMINI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({
          text: `[image not sent: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            GEMINI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
          )}]`,
        });
        continue;
      }
      const bytesResult = await readToolResultImageBytesSafe(item.artifact);
      if (bytesResult.kind === 'missing') {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_missing',
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image missing: ${item.artifact.relPath}]` });
        continue;
      }
      if (bytesResult.kind === 'read_failed') {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_read_failed',
              detail: bytesResult.detail,
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      if (onUserImageIngest) {
        await onUserImageIngest(
          buildUserImageIngest({
            requestContext,
            ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
            artifact: item.artifact,
            disposition: 'fed_native',
            providerPathLabel: 'Google GenAI path',
          }),
        );
      }
      parts.push({
        inlineData: {
          mimeType: item.mimeType,
          data: bytesResult.bytes.toString('base64'),
        },
      });
      continue;
    }
  }

  return {
    role: 'user',
    parts,
  };
}

async function funcResultToGeminiContentWithLimit(
  msg: FuncResultMsg,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
): Promise<Content> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return chatMessageToGeminiContent(msg);
  }

  const parts: Content['parts'] = [];

  let responseObj: Record<string, unknown>;
  try {
    responseObj = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
    if (typeof responseObj !== 'object' || responseObj === null || Array.isArray(responseObj)) {
      responseObj = { result: msg.content };
    }
  } catch (err) {
    responseObj = { result: msg.content };
  }

  parts.push({
    functionResponse: {
      name: msg.name,
      response: responseObj,
      id: msg.id,
    },
  });

  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      parts.push({ text: item.text });
      continue;
    }

    if (item.type === 'input_image') {
      if (!supportsImageInput) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_model_unsupported',
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image not sent: current model does not support image input]` });
        continue;
      }
      if (!isVisionImageMimeType(item.mimeType)) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_mime_unsupported',
              mimeType: item.mimeType,
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image omitted: unsupported mimeType=${item.mimeType}]` });
        continue;
      }
      if (
        !allowedImageKeys.has(
          buildImageBudgetKeyForContentItem({ msg, itemIndex, artifact: item.artifact }),
        )
      ) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_size_limit',
              detail: buildImageBudgetLimitDetail({
                byteLength: item.byteLength,
                budgetBytes: GEMINI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({
          text: `[image omitted: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            GEMINI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
          )}]`,
        });
        continue;
      }

      const bytesResult = await readToolResultImageBytesSafe(item.artifact);
      if (bytesResult.kind === 'missing') {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_missing',
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image missing: ${item.artifact.relPath}]` });
        continue;
      }
      if (bytesResult.kind === 'read_failed') {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_read_failed',
              detail: bytesResult.detail,
              providerPathLabel: 'Google GenAI path',
            }),
          );
        }
        parts.push({ text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      const bytes = bytesResult.bytes;
      if (onToolResultImageIngest) {
        await onToolResultImageIngest(
          buildToolResultImageIngest({
            requestContext,
            toolCallId: msg.id,
            toolName: msg.name,
            artifact: item.artifact,
            disposition: 'fed_native',
            providerPathLabel: 'Google GenAI path',
          }),
        );
      }
      parts.push({
        inlineData: {
          mimeType: item.mimeType,
          data: bytes.toString('base64'),
        },
      });
      continue;
    }
  }

  return {
    role: 'user',
    parts,
  };
}

async function buildGeminiRequestInput(
  context: ChatMessage[],
  requestContext: LlmRequestContext,
  providerConfig?: ProviderConfig,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<Content[]> {
  const input: Content[] = [];
  const allowedImageKeys = selectLatestImagesWithinBudget(
    context,
    GEMINI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  );
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    true,
  );

  for (const msg of context) {
    if (
      (msg.type === 'prompting_msg' ||
        msg.type === 'tellask_result_msg' ||
        msg.type === 'tellask_carryover_msg') &&
      Array.isArray(msg.contentItems) &&
      msg.contentItems.length > 0
    ) {
      input.push(
        await userLikeMessageToGeminiContentWithImages(
          msg,
          requestContext,
          providerConfig,
          allowedImageKeys,
          onUserImageIngest,
        ),
      );
      continue;
    }
    if (msg.type === 'func_result_msg') {
      input.push(
        await funcResultToGeminiContentWithLimit(
          msg,
          requestContext,
          allowedImageKeys,
          supportsImageInput,
          onToolResultImageIngest,
        ),
      );
      continue;
    }
    input.push(chatMessageToGeminiContent(msg));
  }

  return input;
}
function chatMessageToGeminiContent(msg: ChatMessage): Content {
  switch (msg.type) {
    case 'environment_msg':
    case 'prompting_msg':
    case 'tellask_result_msg':
    case 'tellask_carryover_msg':
      return {
        role: 'user',
        parts: [{ text: msg.content }],
      };
    case 'transient_guide_msg':
    case 'saying_msg':
      return {
        role: 'model',
        parts: [{ text: msg.content }],
      };
    case 'thinking_msg':
      return {
        role: 'model',
        parts: [{ thought: true, text: msg.content }],
      };
    case 'func_call_msg': {
      const args: Record<string, unknown> =
        typeof msg.arguments === 'string' ? JSON.parse(msg.arguments) : msg.arguments;
      return {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: msg.name,
              args,
              id: msg.id,
            },
          },
        ],
      };
    }
    case 'func_result_msg': {
      let responseObj: Record<string, unknown>;
      try {
        responseObj = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        if (typeof responseObj !== 'object' || responseObj === null || Array.isArray(responseObj)) {
          responseObj = { result: msg.content };
        }
      } catch (err) {
        responseObj = { result: msg.content };
      }
      return {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: msg.name,
              response: responseObj,
              id: msg.id,
            },
          },
        ],
      };
    }
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

function funcToolToGeminiFunction(funcTool: FuncTool): FunctionDeclaration {
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  return {
    name: funcTool.name,
    description,
    parametersJsonSchema: funcTool.parameters,
  };
}
