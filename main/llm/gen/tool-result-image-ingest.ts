import type {
  ToolResultImageArtifact,
  ToolResultImageDisposition,
} from '@longrun-ai/kernel/types/storage';
import { getWorkLanguage } from '../../runtime/work-language';
import type { ChatMessage, ModelInfo } from '../client';
import type { LlmRequestContext, ToolResultImageIngest, UserImageIngest } from '../gen';
import { readDialogArtifactBytes } from './artifacts';

type ToolResultImageReadResult =
  | { kind: 'ready'; bytes: Buffer }
  | { kind: 'missing' }
  | { kind: 'read_failed'; detail: string };

// These are provider-path guardrails derived from publicly documented request payload limits.
// They are intentionally documented here as coarse transport caps for Dominds' inline image replay,
// not as claims about the provider's exact per-image validator.
//
// OpenAI official vision guide currently documents up to 50 MB total payload size per request.
// Codex here reuses the OpenAI Responses image path, so we follow the same cap by inference.
// Anthropic vision docs currently document 32 MB request size limits for standard endpoints.
//
// OpenAI-compatible has no cross-provider standard. We keep an OpenAI-like fallback cap here for
// future opt-in paths, but must not present it as an official guarantee for arbitrary gateways.
export const OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES = 50 * 1024 * 1024;
export const OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES = 50 * 1024 * 1024;
export const CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES = 50 * 1024 * 1024;
export const ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES = 32 * 1024 * 1024;

export function resolveModelImageInputSupport(
  modelInfo: ModelInfo | undefined,
  defaultValue: boolean,
): boolean {
  const value = modelInfo?.['supports_image_input'];
  if (value === undefined) return defaultValue;
  return value === true;
}

function resolveProviderModelLabel(requestContext: LlmRequestContext): {
  providerKey: string;
  modelKey: string;
  providerModel: string;
} {
  const providerKey =
    typeof requestContext.providerKey === 'string' && requestContext.providerKey.trim().length > 0
      ? requestContext.providerKey.trim()
      : 'unknown-provider';
  const modelKey =
    typeof requestContext.modelKey === 'string' && requestContext.modelKey.trim().length > 0
      ? requestContext.modelKey.trim()
      : 'unknown-model';
  return {
    providerKey,
    modelKey,
    providerModel: `${providerKey}/${modelKey}`,
  };
}

export function buildImageBudgetLimitDetail(args: {
  byteLength: number;
  budgetBytes: number;
}): string {
  return `image_bytes=${String(args.byteLength)}, request_image_budget_bytes=${String(args.budgetBytes)}`;
}

function imageBudgetMessageKey(msg: ChatMessage): string | null {
  switch (msg.type) {
    case 'prompting_msg':
      return `prompting:${String(msg.genseq)}:${msg.msgId}`;
    case 'func_result_msg':
      return `func_result:${String(msg.genseq)}:${msg.id}`;
    case 'tellask_result_msg':
      return `tellask_result:${msg.callName}:${msg.callId}`;
    case 'tellask_carryover_msg':
      return `tellask_carryover:${String(msg.genseq)}:${msg.callName}:${msg.callId}`;
    case 'environment_msg':
    case 'transient_guide_msg':
    case 'saying_msg':
    case 'thinking_msg':
    case 'func_call_msg':
      return null;
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

export function buildImageBudgetKeyForContentItem(args: {
  msg: ChatMessage;
  itemIndex: number;
  artifact: ToolResultImageArtifact;
}): string {
  const msgKey = imageBudgetMessageKey(args.msg);
  if (msgKey === null) {
    throw new Error(`Message type ${args.msg.type} cannot carry image budget items`);
  }
  return `${msgKey}:${String(args.itemIndex)}:${args.artifact.rootId}:${args.artifact.selfId}:${args.artifact.relPath}`;
}

export function selectLatestImagesWithinBudget(
  context: ChatMessage[],
  budgetBytes: number,
): Set<string> {
  const candidates: Array<{ key: string; byteLength: number }> = [];
  for (const msg of context) {
    const msgKey = imageBudgetMessageKey(msg);
    if (msgKey === null) continue;
    const items = 'contentItems' in msg ? msg.contentItems : undefined;
    if (!Array.isArray(items) || items.length === 0) continue;
    for (const [itemIndex, item] of items.entries()) {
      if (item.type !== 'input_image') continue;
      candidates.push({
        key: buildImageBudgetKeyForContentItem({ msg, itemIndex, artifact: item.artifact }),
        byteLength: item.byteLength,
      });
    }
  }

  const allowed = new Set<string>();
  let usedBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (usedBytes + candidate.byteLength > budgetBytes) {
      continue;
    }
    allowed.add(candidate.key);
    usedBytes += candidate.byteLength;
  }
  return allowed;
}

export async function readToolResultImageBytesSafe(
  artifact: ToolResultImageArtifact,
): Promise<ToolResultImageReadResult> {
  try {
    const bytes = await readDialogArtifactBytes(artifact);
    if (!bytes) return { kind: 'missing' };
    return { kind: 'ready', bytes };
  } catch (error) {
    return {
      kind: 'read_failed',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export function buildToolResultImageIngest(args: {
  requestContext: LlmRequestContext;
  toolCallId: string;
  toolName: string;
  artifact: ToolResultImageArtifact;
  disposition: ToolResultImageDisposition;
  mimeType?: string;
  detail?: string;
  providerPathLabel?: string;
}): ToolResultImageIngest {
  const language = getWorkLanguage();
  const { providerKey, modelKey, providerModel } = resolveProviderModelLabel(args.requestContext);
  const pathLabel =
    typeof args.providerPathLabel === 'string' && args.providerPathLabel.trim().length > 0
      ? args.providerPathLabel.trim()
      : 'current provider path';
  const relPath = args.artifact.relPath;
  const mimeText =
    typeof args.mimeType === 'string' && args.mimeType.trim().length > 0
      ? args.mimeType
      : undefined;

  const message = (() => {
    if (language === 'zh') {
      switch (args.disposition) {
        case 'fed_native':
          return `本轮已将这张图片发送给 ${providerModel}。`;
        case 'fed_provider_transformed':
          return `本轮已将这张图片发送给 ${providerModel}（按当前 provider 的原生图片消息方式投喂）。`;
        case 'filtered_provider_unsupported':
          return `本轮未将这张图片发送给 ${providerModel}：当前 ${pathLabel} 不支持图片输入。对话仍会继续，但后续分析不会使用这张图片。`;
        case 'filtered_model_unsupported':
          return `本轮未将这张图片发送给 ${providerModel}：当前模型不支持图片输入。对话仍会继续，但后续分析不会使用这张图片。`;
        case 'filtered_mime_unsupported':
          return `本轮未将这张图片发送给 ${providerModel}：当前 ${pathLabel} 不接受该图片格式${mimeText ? `（${mimeText}）` : ''}。对话仍会继续，但后续分析不会使用这张图片。`;
        case 'filtered_size_limit':
          return `本轮未将这张图片发送给 ${providerModel}：图片超出当前 ${pathLabel} 的限制。对话仍会继续，但后续分析不会使用这张图片。`;
        case 'filtered_read_failed':
          return `本轮未将这张图片发送给 ${providerModel}：读取图片 artifact 失败（${relPath}）。对话仍会继续，但后续分析不会使用这张图片。`;
        case 'filtered_missing':
          return `本轮未将这张图片发送给 ${providerModel}：图片 artifact 缺失（${relPath}）。对话仍会继续，但后续分析不会使用这张图片。`;
        default: {
          const _exhaustive: never = args.disposition;
          return _exhaustive;
        }
      }
    }

    switch (args.disposition) {
      case 'fed_native':
        return `This round sent this image to ${providerModel}.`;
      case 'fed_provider_transformed':
        return `This round sent this image to ${providerModel} using the provider's native image-message projection.`;
      case 'filtered_provider_unsupported':
        return `This round did not send this image to ${providerModel}: the current ${pathLabel} does not support image input. The dialog will continue, but later analysis will not use this image.`;
      case 'filtered_model_unsupported':
        return `This round did not send this image to ${providerModel}: the current model does not support image input. The dialog will continue, but later analysis will not use this image.`;
      case 'filtered_mime_unsupported':
        return `This round did not send this image to ${providerModel}: the current ${pathLabel} does not accept this image format${mimeText ? ` (${mimeText})` : ''}. The dialog will continue, but later analysis will not use this image.`;
      case 'filtered_size_limit':
        return `This round did not send this image to ${providerModel}: the image exceeds the current ${pathLabel} limit. The dialog will continue, but later analysis will not use this image.`;
      case 'filtered_read_failed':
        return `This round did not send this image to ${providerModel}: failed to read the image artifact (${relPath}). The dialog will continue, but later analysis will not use this image.`;
      case 'filtered_missing':
        return `This round did not send this image to ${providerModel}: the image artifact is missing (${relPath}). The dialog will continue, but later analysis will not use this image.`;
      default: {
        const _exhaustive: never = args.disposition;
        return _exhaustive;
      }
    }
  })();

  return {
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    artifact: args.artifact,
    provider: providerKey,
    model: modelKey,
    disposition: args.disposition,
    message,
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
  };
}

export function buildUserImageIngest(args: {
  requestContext: LlmRequestContext;
  msgId?: string;
  artifact: ToolResultImageArtifact;
  disposition: ToolResultImageDisposition;
  mimeType?: string;
  detail?: string;
  providerPathLabel?: string;
}): UserImageIngest {
  const language = getWorkLanguage();
  const { providerKey, modelKey, providerModel } = resolveProviderModelLabel(args.requestContext);
  const pathLabel =
    typeof args.providerPathLabel === 'string' && args.providerPathLabel.trim().length > 0
      ? args.providerPathLabel.trim()
      : 'current provider path';
  const relPath = args.artifact.relPath;
  const mimeText =
    typeof args.mimeType === 'string' && args.mimeType.trim().length > 0
      ? args.mimeType
      : undefined;

  const message = (() => {
    if (language === 'zh') {
      switch (args.disposition) {
        case 'fed_native':
          return `本轮已将这张用户附件图片发送给 ${providerModel}。`;
        case 'fed_provider_transformed':
          return `本轮已将这张用户附件图片发送给 ${providerModel}（按当前 provider 的原生图片消息方式投喂）。`;
        case 'filtered_provider_unsupported':
          return `本轮未将这张用户附件图片发送给 ${providerModel}：当前 ${pathLabel} 不支持图片输入。对话仍会继续，但模型不会看到这张图片。`;
        case 'filtered_model_unsupported':
          return `本轮未将这张用户附件图片发送给 ${providerModel}：当前模型不支持图片输入。对话仍会继续，但模型不会看到这张图片。`;
        case 'filtered_mime_unsupported':
          return `本轮未将这张用户附件图片发送给 ${providerModel}：当前 ${pathLabel} 不接受该图片格式${mimeText ? `（${mimeText}）` : ''}。对话仍会继续，但模型不会看到这张图片。`;
        case 'filtered_size_limit':
          return `本轮未将这张用户附件图片发送给 ${providerModel}：图片超出当前 ${pathLabel} 的限制。对话仍会继续，但模型不会看到这张图片。`;
        case 'filtered_read_failed':
          return `本轮未将这张用户附件图片发送给 ${providerModel}：读取图片 artifact 失败（${relPath}）。对话仍会继续，但模型不会看到这张图片。`;
        case 'filtered_missing':
          return `本轮未将这张用户附件图片发送给 ${providerModel}：图片 artifact 缺失（${relPath}）。对话仍会继续，但模型不会看到这张图片。`;
        default: {
          const _exhaustive: never = args.disposition;
          return _exhaustive;
        }
      }
    }

    switch (args.disposition) {
      case 'fed_native':
        return `This round sent this user attachment image to ${providerModel}.`;
      case 'fed_provider_transformed':
        return `This round sent this user attachment image to ${providerModel} using the provider's native image-message projection.`;
      case 'filtered_provider_unsupported':
        return `This round did not send this user attachment image to ${providerModel}: the current ${pathLabel} does not support image input. The dialog will continue, but the model will not see this image.`;
      case 'filtered_model_unsupported':
        return `This round did not send this user attachment image to ${providerModel}: the current model does not support image input. The dialog will continue, but the model will not see this image.`;
      case 'filtered_mime_unsupported':
        return `This round did not send this user attachment image to ${providerModel}: the current ${pathLabel} does not accept this image format${mimeText ? ` (${mimeText})` : ''}. The dialog will continue, but the model will not see this image.`;
      case 'filtered_size_limit':
        return `This round did not send this user attachment image to ${providerModel}: the image exceeds the current ${pathLabel} limit. The dialog will continue, but the model will not see this image.`;
      case 'filtered_read_failed':
        return `This round did not send this user attachment image to ${providerModel}: failed to read the image artifact (${relPath}). The dialog will continue, but the model will not see this image.`;
      case 'filtered_missing':
        return `This round did not send this user attachment image to ${providerModel}: the image artifact is missing (${relPath}). The dialog will continue, but the model will not see this image.`;
      default: {
        const _exhaustive: never = args.disposition;
        return _exhaustive;
      }
    }
  })();

  return {
    ...(args.msgId !== undefined ? { msgId: args.msgId } : {}),
    artifact: args.artifact,
    provider: providerKey,
    model: modelKey,
    disposition: args.disposition,
    message,
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
  };
}
