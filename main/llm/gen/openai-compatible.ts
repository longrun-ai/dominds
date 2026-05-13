/**
 * Module: llm/gen/openai-compatible
 *
 * OpenAI Chat Completions compatible integration implementing streaming and batch generation.
 *
 * Rationale:
 * - Many "OpenAI-compatible" providers implement the Chat Completions API but not the newer
 *   Responses API. Dominds' `apiType: openai` uses the Responses API; this generator targets
 *   chat-completions-only providers and explicit provider quirks built on that transport shape.
 * - Isolation principle: this wrapper owns the `model_params.openai-compatible.*` namespace and
 *   must not inherit OpenAI Responses or Codex-specific request meanings.
 */

import { once } from 'events';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { FunctionDefinition } from 'openai/resources/shared';
import path from 'path';

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../runtime/i18n-text';
import { getWorkLanguage } from '../../runtime/work-language';
import { DOMINDS_RUNNING_VERSION } from '../../server/dominds-running-version';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import { KIMI_CODE_API_QUIRK, normalizeProviderApiQuirks } from '../api-quirks';
import type { ChatMessage, FuncResultMsg, ModelInfo, ProviderConfig } from '../client';
import {
  LlmStreamErrorEmittedError,
  type LlmBatchOutput,
  type LlmBatchResult,
  type LlmFailureDisposition,
  type LlmGenerator,
  type LlmInvalidFuncCall,
  type LlmRequestContext,
  type LlmStreamReceiver,
  type LlmStreamResult,
  type ToolResultImageIngest,
  type UserImageIngest,
} from '../gen';
import { buildHumanSystemStopReasonTextI18n } from '../stop-reason-i18n';
import { bytesToDataUrl, isVisionImageMimeType } from './artifacts';
import { classifyOpenAiLikeFailure, readErrorCode, readErrorStatus } from './failure-classifier';
import {
  findFirstToolCallAdjacencyViolation,
  formatToolCallAdjacencyViolation,
  normalizeToolCallPairs,
} from './tool-call-context';
import {
  resolveProviderToolResultMaxChars,
  truncateProviderToolOutputText,
} from './tool-output-limit';
import {
  buildImageBudgetKeyForContentItem,
  buildImageBudgetLimitDetail,
  buildToolResultImageIngest,
  buildUserImageIngest,
  OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  readToolResultImageBytesSafe,
  resolveModelImageInputSupport,
  selectLatestImagesWithinBudget,
} from './tool-result-image-ingest';

const log = createLogger('llm/openai-compatible');

const OPENAI_COMPAT_CAPTURE_SSE_ENV = 'DOMINDS_OPENAI_COMPAT_CAPTURE_SSE';
const OPENAI_COMPAT_CAPTURE_DIR_ENV = 'DOMINDS_OPENAI_COMPAT_CAPTURE_DIR';
const OPENAI_COMPAT_REJECTED_DIR_ENV = 'DOMINDS_OPENAI_COMPAT_REJECTED_DIR';
const OPENAI_COMPATIBLE_MALFORMED_BATCH_TOOL_CALL_ERROR_CODE =
  'OPENAI_COMPATIBLE_MALFORMED_BATCH_TOOL_CALL';
const OPENAI_COMPATIBLE_REJECTED_REQUEST_ERROR_CODE = 'OPENAI_COMPATIBLE_REJECTED_REQUEST';

type ChatCompletionMessageWithReasoning = ChatCompletionMessageParam & {
  reasoning_content?: string;
};

type OpenAiCompatibleChatExtraParams = {
  thinking?: boolean | Record<string, unknown>;
  reasoning_effort?: NonNullable<Team.ModelParams['openai-compatible']>['reasoning_effort'];
  prompt_cache_key?: string;
};

const KIMI_CODE_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const KIMI_CLI_CLOAK_API_QUIRK = 'kimi-cli-cloak';
const DISABLE_ASSISTANT_TOOL_CALL_REASONING_CONTENT_API_QUIRK =
  'disable-assistant-tool-call-reasoning-content';
const JSON_SCHEMA_COMBINATOR_KEYS = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
]);
const JSON_SCHEMA_BRANCH_ARRAY_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;
const JSON_SCHEMA_OBJECT_KEYS = new Set([
  'properties',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'required',
  'minProperties',
  'maxProperties',
]);
const JSON_SCHEMA_ARRAY_KEYS = new Set([
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
]);
const JSON_SCHEMA_STRING_KEYS = new Set(['minLength', 'maxLength', 'pattern', 'format']);
const JSON_SCHEMA_NUMERIC_KEYS = new Set([
  'minimum',
  'maximum',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

export function resolveOpenAiCompatibleToolChoice(
  funcTools: readonly FuncTool[],
  requestContext: LlmRequestContext,
  modelInfo?: ModelInfo,
): 'none' | 'auto' | 'required' | undefined {
  const requirement = requestContext.toolUseRequirement ?? 'auto';
  if (funcTools.length === 0) {
    if (requirement === 'required') {
      throw new Error(
        `OpenAI-compatible request invariant violation: toolUseRequirement=required but no tools are available (dialog=${requestContext.dialogSelfId})`,
      );
    }
    return modelInfo?.supports_tool_choice === false ? undefined : 'none';
  }
  if (modelInfo?.supports_tool_choice === false) return undefined;
  if (requirement === 'none') return 'none';
  if (requirement === 'required') return 'required';
  return 'auto';
}

function resolveOpenAiCompatibleRequestTools(
  funcTools: readonly FuncTool[],
  requestContext: LlmRequestContext,
): FuncTool[] {
  return (requestContext.toolUseRequirement ?? 'auto') === 'none' ? [] : [...funcTools];
}

function resolveOpenAiCompatibleRequestModelInfo(
  providerConfig: ProviderConfig,
  agent: Team.Member,
  requestContext: LlmRequestContext,
): ModelInfo | undefined {
  const requestModelKey = requestContext.modelKey;
  const modelKey =
    typeof requestModelKey === 'string' && requestModelKey.trim() !== ''
      ? requestModelKey
      : agent.model;
  if (typeof modelKey !== 'string' || modelKey.trim() === '') return undefined;
  return providerConfig.models[modelKey];
}

function resolveOpenAiCompatibleParallelToolCalls(args: {
  providerConfig: ProviderConfig;
  openAiParams: NonNullable<Team.ModelParams['openai-compatible']>;
}): boolean | undefined {
  if (args.openAiParams.parallel_tool_calls !== undefined) {
    return args.openAiParams.parallel_tool_calls;
  }
  if (isKimiCodeProvider(args.providerConfig)) return undefined;
  return true;
}

type OpenAiCompatibleCaptureContext = {
  providerKey: string;
  providerName: string;
  model: string;
  dialogRootId: string;
  dialogSelfId: string;
  requestKind: 'stream' | 'batch';
};

type OpenAiCompatibleCaptureRecord = {
  id: string;
  dir: string;
  metaPath: string;
  requestBodyPath: string;
  responseBodyPath: string;
  framesPath: string;
  summaryPath: string;
  context: OpenAiCompatibleCaptureContext;
};

type OpenAiCompatibleSseCaptureState = {
  buffer: string;
  responseBytes: number;
  frameCount: number;
  doneSeen: boolean;
  jsonFrameCount: number;
  invalidJsonFrameCount: number;
  invalidFrames: Array<{ frameIndex: number; eventName: string; message: string; data: string }>;
};

type OpenAiCompatibleRejectedCaptureContext = OpenAiCompatibleCaptureContext & {
  genseq: number;
  status: number;
  code?: string;
  upstreamMessage: string;
};

type OpenAiCompatibleRejectedCaptureRecord = {
  id: string;
  dir: string;
  metaPath: string;
  requestPayloadPath: string;
};

type OpenAiCompatibleRejectedCaptureResult =
  | { kind: 'captured'; record: OpenAiCompatibleRejectedCaptureRecord }
  | { kind: 'capture_failed'; detail: string };

function isOpenAiCompatibleSseCaptureEnabled(): boolean {
  const configured = process.env[OPENAI_COMPAT_CAPTURE_SSE_ENV]?.trim().toLowerCase();
  return configured === '1' || configured === 'true' || configured === 'yes' || configured === 'on';
}

function resolveOpenAiCompatibleCaptureDir(): string {
  const configured = process.env[OPENAI_COMPAT_CAPTURE_DIR_ENV]?.trim();
  if (configured && configured.length > 0) return path.resolve(configured);
  return path.resolve(process.cwd(), '.dialogs', 'debug', 'openai-compatible-sse');
}

function resolveOpenAiCompatibleRejectedDir(): string {
  const configured = process.env[OPENAI_COMPAT_REJECTED_DIR_ENV]?.trim();
  if (configured && configured.length > 0) return path.resolve(configured);
  return path.resolve(process.cwd(), '.dialogs', 'debug', 'openai-compatible-rejected');
}

function sanitizeCapturePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (sanitized.length === 0) return 'unknown';
  return sanitized.slice(0, 96);
}

function formatRejectedCaptureFailureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return 'unknown debug capture failure';
  return compact.slice(0, 500);
}

function buildOpenAiCompatibleCaptureId(context: OpenAiCompatibleCaptureContext): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 10);
  return [
    now,
    sanitizeCapturePathPart(context.providerKey ?? context.providerName),
    sanitizeCapturePathPart(context.model),
    sanitizeCapturePathPart(context.dialogSelfId),
    context.requestKind,
    suffix,
  ].join('__');
}

function buildOpenAiCompatibleRejectedCaptureId(
  context: OpenAiCompatibleRejectedCaptureContext,
): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 10);
  return [
    now,
    sanitizeCapturePathPart(context.providerKey ?? context.providerName),
    sanitizeCapturePathPart(context.model),
    sanitizeCapturePathPart(context.dialogSelfId),
    `g${String(context.genseq)}`,
    context.requestKind,
    suffix,
  ].join('__');
}

function redactHttpHeader(name: string, value: string): string {
  const normalized = name.toLowerCase();
  if (
    normalized === 'authorization' ||
    normalized === 'x-api-key' ||
    normalized === 'api-key' ||
    normalized.includes('token') ||
    normalized.includes('secret')
  ) {
    return '<redacted>';
  }
  return value;
}

function headersToRedactedRecord(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, name) => {
    entries[name] = redactHttpHeader(name, value);
  });
  return entries;
}

function mergeRequestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  return headers;
}

function requestMethod(input: string | URL | Request, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method;
  if (input instanceof Request) return input.method;
  return 'GET';
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function decodeArrayBufferView(view: ArrayBufferView): string {
  return new TextDecoder().decode(view);
}

async function readCaptureRequestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return await body.text();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return decodeArrayBufferView(body);
  if (body === null) return undefined;
  if (body !== undefined)
    return `[unreadable RequestInit body: ${Object.prototype.toString.call(body)}]`;
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `[failed to clone/read Request body: ${message}]`;
    }
  }
  return undefined;
}

async function writeCaptureJson(pathname: string, value: unknown): Promise<void> {
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function startOpenAiCompatibleCapture(
  context: OpenAiCompatibleCaptureContext,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<OpenAiCompatibleCaptureRecord> {
  const captureRoot = resolveOpenAiCompatibleCaptureDir();
  const id = buildOpenAiCompatibleCaptureId(context);
  const dir = path.join(captureRoot, id);
  await fs.mkdir(dir, { recursive: true });

  const record: OpenAiCompatibleCaptureRecord = {
    id,
    dir,
    metaPath: path.join(dir, 'meta.json'),
    requestBodyPath: path.join(dir, 'request-body.txt'),
    responseBodyPath: path.join(dir, 'response-body.raw'),
    framesPath: path.join(dir, 'sse-frames.jsonl'),
    summaryPath: path.join(dir, 'summary.json'),
    context,
  };

  const bodyText = await readCaptureRequestBody(input, init);
  await fs.writeFile(record.requestBodyPath, bodyText ?? '', 'utf-8');

  await writeCaptureJson(record.metaPath, {
    id: record.id,
    capturedAt: new Date().toISOString(),
    context,
    env: {
      enabledBy: OPENAI_COMPAT_CAPTURE_SSE_ENV,
      captureDirEnv: process.env[OPENAI_COMPAT_CAPTURE_DIR_ENV]
        ? OPENAI_COMPAT_CAPTURE_DIR_ENV
        : undefined,
    },
    request: {
      method: requestMethod(input, init),
      url: requestUrl(input),
      headers: headersToRedactedRecord(mergeRequestHeaders(input, init)),
      bodyPath: record.requestBodyPath,
    },
    response: {
      bodyPath: record.responseBodyPath,
      framesPath: record.framesPath,
      summaryPath: record.summaryPath,
    },
  });

  log.info('OPENAI compatible SSE capture started', undefined, {
    captureDir: record.dir,
    providerKey: context.providerKey,
    providerName: context.providerName,
    model: context.model,
    rootId: context.dialogRootId,
    selfId: context.dialogSelfId,
    requestKind: context.requestKind,
  });
  return record;
}

async function writeOpenAiCompatibleRejectedCapture(args: {
  context: OpenAiCompatibleRejectedCaptureContext;
  payload: unknown;
  error: unknown;
}): Promise<OpenAiCompatibleRejectedCaptureRecord> {
  const captureRoot = resolveOpenAiCompatibleRejectedDir();
  const id = buildOpenAiCompatibleRejectedCaptureId(args.context);
  const dir = path.join(captureRoot, id);
  await fs.mkdir(dir, { recursive: true });

  const record: OpenAiCompatibleRejectedCaptureRecord = {
    id,
    dir,
    metaPath: path.join(dir, 'meta.json'),
    requestPayloadPath: path.join(dir, 'request-payload.json'),
  };

  await writeCaptureJson(record.requestPayloadPath, args.payload);
  await writeCaptureJson(record.metaPath, {
    id,
    capturedAt: new Date().toISOString(),
    context: args.context,
    request: {
      payloadPath: record.requestPayloadPath,
    },
    error: {
      name: args.error instanceof Error ? args.error.name : undefined,
      message: args.context.upstreamMessage,
      status: args.context.status,
      code: args.context.code,
    },
  });

  return record;
}

async function tryWriteOpenAiCompatibleRejectedCapture(args: {
  context: OpenAiCompatibleRejectedCaptureContext;
  payload: unknown;
  error: unknown;
}): Promise<OpenAiCompatibleRejectedCaptureResult> {
  try {
    return { kind: 'captured', record: await writeOpenAiCompatibleRejectedCapture(args) };
  } catch (error: unknown) {
    const detail = formatRejectedCaptureFailureDetail(error);
    log.error('OPENAI-COMPATIBLE rejected request debug capture failed', error, {
      providerKey: args.context.providerKey,
      providerName: args.context.providerName,
      model: args.context.model,
      rootId: args.context.dialogRootId,
      selfId: args.context.dialogSelfId,
      genseq: args.context.genseq,
      requestKind: args.context.requestKind,
    });
    return { kind: 'capture_failed', detail };
  }
}

function parseSseFrameData(frame: string): { eventName: string; data: string | undefined } {
  const lines = frame.split(/\r?\n/);
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const eventName = eventLine ? eventLine.slice('event:'.length).trim() : '';
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => (line.startsWith('data: ') ? line.slice(6) : line.slice(5)));
  if (dataLines.length === 0) return { eventName, data: undefined };
  return { eventName, data: dataLines.join('\n') };
}

function parseSseFrameJson(frame: string): {
  kind: 'json_ok' | 'done' | 'no_data' | 'invalid_json';
  message?: string;
  data?: string;
} {
  const { data } = parseSseFrameData(frame);
  if (data === undefined) return { kind: 'no_data' };
  if (data === '[DONE]') return { kind: 'done' };
  try {
    JSON.parse(data);
    return { kind: 'json_ok' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid_json', message, data };
  }
}

function describeCaptureError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSseFrameLogLine(frame: string, state: OpenAiCompatibleSseCaptureState): string {
  const { eventName, data } = parseSseFrameData(frame);
  const result = parseSseFrameJson(frame);
  if (result.kind === 'done') state.doneSeen = true;
  if (result.kind === 'json_ok') state.jsonFrameCount += 1;
  if (result.kind === 'invalid_json') {
    state.invalidJsonFrameCount += 1;
    state.invalidFrames.push({
      frameIndex: state.frameCount,
      eventName,
      message: result.message ?? 'unknown parse error',
      data: result.data ?? '',
    });
  }
  return `${JSON.stringify({
    frameIndex: state.frameCount,
    eventName,
    dataBytes: data === undefined ? 0 : Buffer.byteLength(data),
    parse: result.kind,
    error: result.kind === 'invalid_json' ? result.message : undefined,
    data: result.kind === 'invalid_json' ? result.data : undefined,
  })}\n`;
}

async function writeAndDrain(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string | Uint8Array,
): Promise<void> {
  if (!stream.write(chunk)) {
    await Promise.race([
      once(stream, 'drain'),
      once(stream, 'error').then(([error]) => {
        throw error;
      }),
    ]);
  }
}

async function endWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

async function cancelReadableStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  context: { captureDir?: string; providerKey?: string; model?: string },
): Promise<void> {
  try {
    await reader.cancel();
  } catch (error: unknown) {
    log.warn('OPENAI compatible response reader cancel failed during cleanup', error, context);
  }
}

async function captureOpenAiCompatibleResponseBody(
  record: OpenAiCompatibleCaptureRecord,
  response: Response,
): Promise<void> {
  const responseClone = response.clone();
  const rawStream = createWriteStream(record.responseBodyPath);
  const framesStream = createWriteStream(record.framesPath);
  const decoder = new TextDecoder();
  const parseAsSse = record.context.requestKind === 'stream';
  let captureError: string | undefined;
  const state: OpenAiCompatibleSseCaptureState = {
    buffer: '',
    responseBytes: 0,
    frameCount: 0,
    doneSeen: false,
    jsonFrameCount: 0,
    invalidJsonFrameCount: 0,
    invalidFrames: [],
  };

  try {
    if (responseClone.body) {
      const reader = responseClone.body.getReader();
      let done = false;
      try {
        for (;;) {
          const readResult = await reader.read();
          if (readResult.done) {
            done = true;
            break;
          }
          state.responseBytes += readResult.value.byteLength;
          await writeAndDrain(rawStream, readResult.value);
          if (parseAsSse) {
            state.buffer += decoder.decode(readResult.value, { stream: true });
            for (;;) {
              const separator = state.buffer.match(/\r?\n\r?\n/);
              if (!separator || separator.index === undefined) break;
              const frame = state.buffer.slice(0, separator.index);
              state.buffer = state.buffer.slice(separator.index + separator[0].length);
              if (frame.trim().length === 0) continue;
              state.frameCount += 1;
              await writeAndDrain(framesStream, buildSseFrameLogLine(frame, state));
            }
          }
        }
        if (parseAsSse) {
          const rest = decoder.decode();
          if (rest.length > 0) state.buffer += rest;
          if (state.buffer.trim().length > 0) {
            state.frameCount += 1;
            await writeAndDrain(framesStream, buildSseFrameLogLine(state.buffer, state));
          }
        }
      } finally {
        if (!done) {
          await cancelReadableStreamReader(reader, {
            captureDir: record.dir,
            providerKey: record.context.providerKey,
            model: record.context.model,
          });
        }
        reader.releaseLock();
      }
    }
  } catch (error: unknown) {
    captureError = describeCaptureError(error);
  } finally {
    await Promise.all([endWriteStream(rawStream), endWriteStream(framesStream)]);
  }

  await writeCaptureJson(record.summaryPath, {
    id: record.id,
    completedAt: new Date().toISOString(),
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    requestKind: record.context.requestKind,
    captureError,
    headers: headersToRedactedRecord(response.headers),
    responseBytes: state.responseBytes,
    frameCount: state.frameCount,
    doneSeen: state.doneSeen,
    jsonFrameCount: state.jsonFrameCount,
    invalidJsonFrameCount: state.invalidJsonFrameCount,
    invalidFrames: state.invalidFrames,
  });

  if (state.invalidJsonFrameCount > 0) {
    log.warn('OPENAI compatible SSE capture found invalid JSON data frame', undefined, {
      captureDir: record.dir,
      invalidJsonFrameCount: state.invalidJsonFrameCount,
      invalidFrames: state.invalidFrames,
      providerKey: record.context.providerKey,
      model: record.context.model,
      rootId: record.context.dialogRootId,
      selfId: record.context.dialogSelfId,
    });
  } else if (captureError === undefined) {
    log.info('OPENAI compatible SSE capture completed', undefined, {
      captureDir: record.dir,
      responseBytes: state.responseBytes,
      frameCount: state.frameCount,
      doneSeen: state.doneSeen,
      providerKey: record.context.providerKey,
      model: record.context.model,
      rootId: record.context.dialogRootId,
      selfId: record.context.dialogSelfId,
    });
  }
  if (captureError !== undefined) {
    throw new Error(
      `OPENAI compatible SSE capture failed while reading response clone: ${captureError}`,
    );
  }
}

function buildOpenAiCompatibleCaptureFetch(context: OpenAiCompatibleCaptureContext): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record = await startOpenAiCompatibleCapture(context, input, init);
    try {
      const response = await fetch(input, init);
      void captureOpenAiCompatibleResponseBody(record, response).catch((error: unknown) => {
        log.error('OPENAI compatible SSE capture failed while reading response clone', error, {
          captureDir: record.dir,
          providerKey: context.providerKey,
          model: context.model,
          rootId: context.dialogRootId,
          selfId: context.dialogSelfId,
        });
      });
      return response;
    } catch (error: unknown) {
      await writeCaptureJson(record.summaryPath, {
        id: record.id,
        completedAt: new Date().toISOString(),
        fetchError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function createOpenAiCompatibleClient(args: {
  apiKey: string;
  providerConfig: ProviderConfig;
  agent: Team.Member;
  requestContext: LlmRequestContext;
  requestKind: 'stream' | 'batch';
}): OpenAI {
  const providerKey =
    typeof args.requestContext.providerKey === 'string' &&
    args.requestContext.providerKey.trim().length > 0
      ? args.requestContext.providerKey
      : args.providerConfig.name;
  const modelKey =
    typeof args.requestContext.modelKey === 'string' &&
    args.requestContext.modelKey.trim().length > 0
      ? args.requestContext.modelKey
      : (args.agent.model ?? 'unknown');
  const options: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: args.apiKey,
    baseURL: args.providerConfig.baseUrl,
  };
  if (isKimiCliCloakProvider(args.providerConfig)) {
    options.defaultHeaders = {
      'User-Agent': `KimiCLI/Dominds/${DOMINDS_RUNNING_VERSION}`,
    };
  } else if (isKimiCodeProvider(args.providerConfig)) {
    options.defaultHeaders = {
      'User-Agent': `Dominds/${DOMINDS_RUNNING_VERSION || 'dev'}`,
    };
  }
  if (
    args.providerConfig.apiType === 'openai-compatible' &&
    isOpenAiCompatibleSseCaptureEnabled()
  ) {
    options.fetch = buildOpenAiCompatibleCaptureFetch({
      providerKey,
      providerName:
        args.providerConfig.name.trim().length > 0 ? args.providerConfig.name : providerKey,
      model: modelKey,
      dialogRootId: args.requestContext.dialogRootId,
      dialogSelfId: args.requestContext.dialogSelfId,
      requestKind: args.requestKind,
    });
  }
  return new OpenAI(options);
}

function limitOpenAiCompatibleToolOutputText(
  text: string,
  msg: FuncResultMsg,
  limitChars: number,
): string {
  const limited = truncateProviderToolOutputText(text, limitChars);
  if (limited.truncated) {
    log.warn('OPENAI-COMPATIBLE tool output truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalChars: limited.originalChars,
      limitChars: limited.limitChars,
    });
  }
  return limited.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKimiCodeProvider(providerConfig: ProviderConfig): boolean {
  return normalizeProviderApiQuirks(providerConfig).has(KIMI_CODE_API_QUIRK);
}

function isKimiCliCloakProvider(providerConfig: ProviderConfig): boolean {
  return normalizeProviderApiQuirks(providerConfig).has(KIMI_CLI_CLOAK_API_QUIRK);
}

function isKimiCodeReasoningEffort(
  value: NonNullable<Team.ModelParams['openai-compatible']>['reasoning_effort'],
): value is 'low' | 'medium' | 'high' {
  return typeof value === 'string' && KIMI_CODE_REASONING_EFFORTS.has(value);
}

function isKimiCodeThinkingMode(
  value: unknown,
): value is 'auto' | 'off' | 'low' | 'medium' | 'high' {
  return (
    value === 'auto' || value === 'off' || value === 'low' || value === 'medium' || value === 'high'
  );
}

function cloneJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJsonSchemaValue(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = cloneJsonSchemaValue(child);
    }
    return out;
  }
  return value;
}

function hasAnyOwnKey(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  }
  return false;
}

function inferJsonSchemaTypeFromValues(values: readonly unknown[]): string {
  const inferred = new Set<string>();
  for (const value of values) {
    if (typeof value === 'boolean') inferred.add('boolean');
    else if (typeof value === 'number')
      inferred.add(Number.isInteger(value) ? 'integer' : 'number');
    else if (typeof value === 'string') inferred.add('string');
    else if (value === null) inferred.add('null');
    else if (Array.isArray(value)) inferred.add('array');
    else if (isRecord(value)) inferred.add('object');
    else return 'string';
  }
  if (inferred.size === 1) {
    const only = [...inferred][0];
    return only ?? 'string';
  }
  if (inferred.size === 2 && inferred.has('integer') && inferred.has('number')) {
    return 'number';
  }
  return 'string';
}

function inferJsonSchemaTypeFromStructure(value: Record<string, unknown>): string {
  if (hasAnyOwnKey(value, JSON_SCHEMA_OBJECT_KEYS)) return 'object';
  if (hasAnyOwnKey(value, JSON_SCHEMA_ARRAY_KEYS)) return 'array';
  if (hasAnyOwnKey(value, JSON_SCHEMA_STRING_KEYS)) return 'string';
  if (hasAnyOwnKey(value, JSON_SCHEMA_NUMERIC_KEYS)) return 'number';
  return 'string';
}

function normalizeOpenAiCompatibleKimiCodeJsonSchemaProperty(value: unknown): void {
  if (!isRecord(value)) return;
  if (
    !Object.prototype.hasOwnProperty.call(value, 'type') &&
    !hasAnyOwnKey(value, JSON_SCHEMA_COMBINATOR_KEYS)
  ) {
    const enumValues = value.enum;
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      value.type = inferJsonSchemaTypeFromValues(enumValues);
    } else if (Object.prototype.hasOwnProperty.call(value, 'const')) {
      value.type = inferJsonSchemaTypeFromValues([value.const]);
    } else {
      value.type = inferJsonSchemaTypeFromStructure(value);
    }
  }
  normalizeOpenAiCompatibleKimiCodeJsonSchemaContainer(value);
}

function normalizeOpenAiCompatibleKimiCodeJsonSchemaContainer(value: unknown): void {
  if (!isRecord(value)) return;

  const properties = value.properties;
  if (isRecord(properties)) {
    for (const property of Object.values(properties)) {
      normalizeOpenAiCompatibleKimiCodeJsonSchemaProperty(property);
    }
  }

  const items = value.items;
  if (isRecord(items)) {
    normalizeOpenAiCompatibleKimiCodeJsonSchemaProperty(items);
  } else if (Array.isArray(items)) {
    for (const item of items) {
      normalizeOpenAiCompatibleKimiCodeJsonSchemaProperty(item);
    }
  }

  const additionalProperties = value.additionalProperties;
  if (isRecord(additionalProperties)) {
    normalizeOpenAiCompatibleKimiCodeJsonSchemaProperty(additionalProperties);
  }

  for (const key of JSON_SCHEMA_BRANCH_ARRAY_KEYS) {
    const branches = value[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      normalizeOpenAiCompatibleKimiCodeJsonSchemaProperty(branch);
    }
  }
}

function normalizeOpenAiCompatibleKimiCodeJsonSchema(value: unknown): unknown {
  const cloned = cloneJsonSchemaValue(value);
  normalizeOpenAiCompatibleKimiCodeJsonSchemaContainer(cloned);
  return cloned;
}

function isLlmRequestContext(value: unknown): value is LlmRequestContext {
  return (
    isRecord(value) &&
    typeof value.dialogSelfId === 'string' &&
    typeof value.dialogRootId === 'string' &&
    typeof value.providerKey === 'string' &&
    typeof value.modelKey === 'string'
  );
}

function tryExtractChatUsage(usage: unknown): LlmUsageStats {
  // NOTE: External API payload; a runtime check is unavoidable.
  if (!isRecord(usage)) return { kind: 'unavailable' };
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const total = usage.total_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return { kind: 'unavailable' };
  return {
    kind: 'available',
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: typeof total === 'number' ? total : prompt + completion,
  };
}

function buildChatCompletionResponseFormat(
  openAiParams: NonNullable<Team.ModelParams['openai-compatible']>,
): ChatCompletionCreateParamsStreaming['response_format'] | undefined {
  const textFormat = openAiParams.text_format;
  if (textFormat === 'text' || textFormat === 'json_object') {
    return { type: textFormat };
  }
  if (textFormat !== 'json_schema') return undefined;

  const schemaName = openAiParams.text_format_json_schema_name?.trim();
  const rawSchema = openAiParams.text_format_json_schema?.trim();
  if (!schemaName || !rawSchema) {
    throw new Error(
      'Invalid openai-compatible text_format=json_schema: text_format_json_schema_name and text_format_json_schema are required.',
    );
  }
  let parsedSchema: unknown;
  try {
    parsedSchema = JSON.parse(rawSchema);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid openai-compatible text_format_json_schema: ${message}`);
  }
  if (!isRecord(parsedSchema)) {
    throw new Error(
      'Invalid openai-compatible text_format_json_schema: expected a JSON object at the top level.',
    );
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: schemaName,
      schema: parsedSchema,
      ...(openAiParams.text_format_json_schema_strict !== undefined
        ? { strict: openAiParams.text_format_json_schema_strict }
        : {}),
    },
  };
}

function buildReasoningPayloadFromText(text: string): ReasoningPayload | undefined {
  if (text.trim().length === 0) return undefined;
  return {
    summary: [{ type: 'summary_text', text }],
  };
}

function buildOpenAiCompatibleExtraParams(args: {
  providerConfig?: ProviderConfig;
  agent: Team.Member;
  openAiParams: NonNullable<Team.ModelParams['openai-compatible']>;
  requestContext?: LlmRequestContext;
}): OpenAiCompatibleChatExtraParams {
  if (args.providerConfig !== undefined && isKimiCodeProvider(args.providerConfig)) {
    return buildKimiCodeOpenAiCompatibleExtraParams(args);
  }
  const model = args.agent.model ?? '';
  const thinking = args.openAiParams.thinking;
  if (typeof thinking === 'string') {
    throw new Error(
      `Invalid openai-compatible model_params: string thinking mode '${thinking}' requires apiQuirks: ${KIMI_CODE_API_QUIRK} for model '${model}'.`,
    );
  }
  const reasoningEffort = args.openAiParams.reasoning_effort;
  const thinkingDisabled =
    thinking === false || (isRecord(thinking) && thinking.type === 'disabled');
  if (thinkingDisabled && reasoningEffort !== undefined) {
    throw new Error(
      `Invalid openai-compatible model_params: thinking disabled conflicts with reasoning_effort=${reasoningEffort} for model '${model}'.`,
    );
  }
  if (thinking === undefined && reasoningEffort === undefined) return {};
  const thinkingPayload =
    typeof thinking === 'boolean' ? { type: thinking ? 'enabled' : 'disabled' } : thinking;
  return {
    ...(thinkingPayload !== undefined ? { thinking: thinkingPayload } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  };
}

function buildKimiCodeOpenAiCompatibleExtraParams(args: {
  agent: Team.Member;
  openAiParams: NonNullable<Team.ModelParams['openai-compatible']>;
  requestContext?: LlmRequestContext;
}): OpenAiCompatibleChatExtraParams {
  const model = args.agent.model ?? '';
  const thinking = args.openAiParams.thinking;
  const reasoningEffort = args.openAiParams.reasoning_effort;
  const promptCacheKey = args.requestContext?.promptCacheKey?.trim();

  if (reasoningEffort !== undefined && !isKimiCodeReasoningEffort(reasoningEffort)) {
    throw new Error(
      `Invalid Kimi Code openai-compatible model_params: reasoning_effort=${reasoningEffort} is not supported for model '${model}'; expected low|medium|high.`,
    );
  }

  const base: OpenAiCompatibleChatExtraParams =
    promptCacheKey !== undefined && promptCacheKey.length > 0
      ? { prompt_cache_key: promptCacheKey }
      : {};

  if (thinking === undefined) {
    return {
      ...base,
      ...(reasoningEffort !== undefined
        ? { thinking: { type: 'enabled' }, reasoning_effort: reasoningEffort }
        : {}),
    };
  }

  if (thinking === 'auto' || thinking === 'off') {
    if (reasoningEffort !== undefined) {
      throw new Error(
        `Invalid Kimi Code openai-compatible model_params: thinking=${thinking} conflicts with reasoning_effort=${reasoningEffort} for model '${model}'.`,
      );
    }
    if (thinking === 'auto') return base;
    return {
      ...base,
      thinking: { type: 'disabled' },
    };
  }

  if (isKimiCodeThinkingMode(thinking)) {
    if (reasoningEffort !== undefined && reasoningEffort !== thinking) {
      throw new Error(
        `Invalid Kimi Code openai-compatible model_params: thinking=${thinking} conflicts with reasoning_effort=${reasoningEffort} for model '${model}'.`,
      );
    }
    return {
      ...base,
      thinking: { type: 'enabled' },
      reasoning_effort: thinking,
    };
  }

  const thinkingDisabled =
    thinking === false || (isRecord(thinking) && thinking.type === 'disabled');
  if (thinkingDisabled && reasoningEffort !== undefined) {
    throw new Error(
      `Invalid Kimi Code openai-compatible model_params: thinking disabled conflicts with reasoning_effort=${reasoningEffort} for model '${model}'.`,
    );
  }

  const thinkingPayload =
    typeof thinking === 'boolean' ? { type: thinking ? 'enabled' : 'disabled' } : thinking;
  return {
    ...base,
    ...(thinkingPayload !== undefined ? { thinking: thinkingPayload } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  };
}

async function wrapOpenAiCompatibleRejectedRequestError(args: {
  error: unknown;
  providerConfig: ProviderConfig;
  agent: Team.Member;
  requestContext: LlmRequestContext;
  genseq: number;
  requestKind: 'stream' | 'batch';
  payload: unknown;
}): Promise<unknown> {
  const status = readErrorStatus(args.error);
  if (status !== 400) return args.error;

  const providerKey = args.requestContext.providerKey ?? args.providerConfig.name;
  const modelKey = args.requestContext.modelKey ?? args.agent.model ?? 'unknown';
  const code = readErrorCode(args.error);
  const upstreamMessage = args.error instanceof Error ? args.error.message : String(args.error);
  const captureContext: OpenAiCompatibleRejectedCaptureContext = {
    providerKey,
    providerName:
      args.providerConfig.name.trim().length > 0 ? args.providerConfig.name : providerKey,
    model: modelKey,
    dialogRootId: args.requestContext.dialogRootId,
    dialogSelfId: args.requestContext.dialogSelfId,
    requestKind: args.requestKind,
    genseq: args.genseq,
    status,
    ...(code !== undefined && { code }),
    upstreamMessage,
  };
  const capture = await tryWriteOpenAiCompatibleRejectedCapture({
    context: captureContext,
    payload: args.payload,
    error: args.error,
  });
  const captureMessageLines =
    capture.kind === 'captured'
      ? [
          `debugPath=${capture.record.dir}`,
          `requestPayloadPath=${capture.record.requestPayloadPath}`,
        ]
      : [`debugCaptureError=${capture.detail}`];
  const message = [
    `OPENAI-compatible provider rejected ${args.requestKind} request with HTTP 400.`,
    `provider=${providerKey}`,
    `model=${modelKey}`,
    `rootId=${args.requestContext.dialogRootId}`,
    `selfId=${args.requestContext.dialogSelfId}`,
    `genseq=${String(args.genseq)}`,
    `upstream=${upstreamMessage}`,
    ...captureMessageLines,
  ].join('\n');

  const wrapped: Error & {
    cause?: unknown;
    code?: string;
    debugCaptureError?: string;
    debugPath?: string;
    requestPayloadPath?: string;
    status?: number;
    statusCode?: number;
  } = new Error(message);
  wrapped.name = 'OpenAiCompatibleRejectedRequestError';
  wrapped.cause = args.error;
  wrapped.status = status;
  wrapped.statusCode = status;
  wrapped.code = code ?? OPENAI_COMPATIBLE_REJECTED_REQUEST_ERROR_CODE;
  if (capture.kind === 'captured') {
    wrapped.debugPath = capture.record.dir;
    wrapped.requestPayloadPath = capture.record.requestPayloadPath;
  } else {
    wrapped.debugCaptureError = capture.detail;
  }
  return wrapped;
}

export function buildOpenAiCompatibleExtraParamsForTest(args: {
  providerConfig?: ProviderConfig;
  agent: Team.Member;
  openAiParams: NonNullable<Team.ModelParams['openai-compatible']>;
  requestContext?: LlmRequestContext;
}): OpenAiCompatibleChatExtraParams {
  return buildOpenAiCompatibleExtraParams(args);
}

export async function wrapOpenAiCompatibleRejectedRequestErrorForTest(args: {
  error: unknown;
  providerConfig: ProviderConfig;
  agent: Team.Member;
  requestContext: LlmRequestContext;
  genseq: number;
  requestKind: 'stream' | 'batch';
  payload: unknown;
}): Promise<unknown> {
  return await wrapOpenAiCompatibleRejectedRequestError(args);
}

function extractThinkingReasoningText(msg: Extract<ChatMessage, { type: 'thinking_msg' }>): string {
  const fromSummary = msg.reasoning?.summary.map((part) => part.text).join('') ?? '';
  const fromContent = msg.reasoning?.content?.map((part) => part.text).join('') ?? '';
  const combined = `${fromSummary}${fromContent}`;
  return combined.length > 0 ? combined : msg.content;
}

function extractReasoningContentField(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const content = value.reasoning_content;
  if (typeof content !== 'string') return undefined;
  return content.length > 0 ? content : undefined;
}

function attachReasoningContent(
  message: ChatCompletionMessageParam,
  reasoningContent: string | undefined,
): ChatCompletionMessageParam {
  if (!reasoningContent) return message;
  if (!isRecord(message) || message.role !== 'assistant') return message;
  return {
    ...message,
    reasoning_content: reasoningContent,
  } as ChatCompletionMessageWithReasoning;
}

function shouldAttachReasoningContentToAssistantToolCalls(
  providerConfig: ProviderConfig | undefined,
): boolean {
  if (providerConfig === undefined) return true;
  return !normalizeProviderApiQuirks(providerConfig).has(
    DISABLE_ASSISTANT_TOOL_CALL_REASONING_CONTENT_API_QUIRK,
  );
}

function funcToolToChatCompletionTool(
  funcTool: FuncTool,
  providerConfig?: ProviderConfig,
): ChatCompletionTool {
  // MCP schemas are passed through to providers. Chat Completions expects a narrower JSON schema
  // shape; runtime compatibility is handled by provider validation + the driver stop policy.
  const rawParameters = funcTool.parameters as unknown;
  const parameters = (
    providerConfig !== undefined && isKimiCodeProvider(providerConfig)
      ? normalizeOpenAiCompatibleKimiCodeJsonSchema(rawParameters)
      : rawParameters
  ) as FunctionDefinition['parameters'];
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  return {
    type: 'function',
    function: {
      name: funcTool.name,
      description,
      parameters,
      strict: false,
    },
  };
}

function chatMessageToChatCompletionMessage(msg: ChatMessage): ChatCompletionMessageParam {
  switch (msg.type) {
    case 'environment_msg':
    case 'prompting_msg':
    case 'tellask_result_msg':
    case 'tellask_carryover_msg':
      return { role: 'user', content: msg.content };
    case 'transient_guide_msg':
    case 'saying_msg':
    case 'thinking_msg':
      return { role: 'assistant', content: msg.content };
    case 'func_call_msg':
      return {
        role: 'assistant',
        tool_calls: [
          {
            id: msg.id,
            type: 'function',
            function: { name: msg.name, arguments: msg.arguments },
          },
        ],
      };
    case 'func_result_msg':
      return { role: 'tool', tool_call_id: msg.id, content: msg.content };
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

async function userLikeMessageToChatCompletionMessageWithImages(
  msg: Extract<
    ChatMessage,
    { type: 'prompting_msg' | 'tellask_result_msg' | 'tellask_carryover_msg' }
  >,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<ChatCompletionMessageParam> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return chatMessageToChatCompletionMessage(msg);
  }

  const content: ChatCompletionContentPart[] = [{ type: 'text', text: msg.content }];
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    false,
  );
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      content.push({ type: 'text', text: item.text });
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({
          type: 'text',
          text: `[image not sent: current model does not support image input]`,
        });
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({
          type: 'text',
          text: `[image not sent: unsupported mimeType=${item.mimeType}]`,
        });
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
                budgetBytes: OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({
          type: 'text',
          text: `[image not sent: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({ type: 'text', text: `[image missing: ${item.artifact.relPath}]` });
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({ type: 'text', text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      if (onUserImageIngest) {
        await onUserImageIngest(
          buildUserImageIngest({
            requestContext,
            ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
            artifact: item.artifact,
            disposition: 'fed_provider_transformed',
            providerPathLabel: 'OpenAI-compatible Chat Completions path',
          }),
        );
      }
      content.push({
        type: 'image_url',
        image_url: {
          url: bytesToDataUrl({ mimeType: item.mimeType, bytes: bytesResult.bytes }),
          detail: 'auto',
        },
      });
      continue;
    }
    const _exhaustive: never = item;
    throw new Error(`Unsupported user content item: ${String(_exhaustive)}`);
  }

  return { role: 'user', content };
}

async function funcResultToChatCompletionMessages(
  msg: FuncResultMsg,
  limitChars: number,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
): Promise<ChatCompletionMessageParam[]> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return [
      {
        role: 'tool',
        tool_call_id: msg.id,
        content: limitOpenAiCompatibleToolOutputText(msg.content, msg, limitChars),
      },
    ];
  }

  const out: ChatCompletionMessageParam[] = [];
  out.push({
    role: 'tool',
    tool_call_id: msg.id,
    content: limitOpenAiCompatibleToolOutputText(msg.content, msg, limitChars),
  });

  const parts: ChatCompletionContentPart[] = [];
  let sawImageUrl = false;
  let sawAnyImage = false;

  parts.push({
    type: 'text',
    text: `Tool output images (${msg.name}, call_id=${msg.id}):`,
  });

  const modelKey =
    typeof requestContext.modelKey === 'string' ? requestContext.modelKey.trim() : '';
  const modelInfo =
    modelKey.length > 0 && providerConfig ? providerConfig.models[modelKey] : undefined;
  const supportsImageInput = resolveModelImageInputSupport(modelInfo, false);
  const imageUnsupportedDisposition =
    modelInfo?.['supports_image_input'] === false
      ? 'filtered_model_unsupported'
      : 'filtered_provider_unsupported';

  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') continue;

    if (item.type === 'input_image') {
      sawAnyImage = true;
      if (!supportsImageInput) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: imageUnsupportedDisposition,
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image not sent: current openai-compatible image input is disabled for model=${typeof requestContext.modelKey === 'string' && requestContext.modelKey.trim().length > 0 ? requestContext.modelKey.trim() : 'unknown'}]`,
        });
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
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image omitted: unsupported mimeType=${item.mimeType}]`,
        });
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
                budgetBytes: OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image omitted: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image missing: ${item.artifact.relPath}]`,
        });
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
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image unreadable: ${item.artifact.relPath}]`,
        });
        continue;
      }
      if (onToolResultImageIngest) {
        await onToolResultImageIngest(
          buildToolResultImageIngest({
            requestContext,
            toolCallId: msg.id,
            toolName: msg.name,
            artifact: item.artifact,
            disposition: 'fed_provider_transformed',
            providerPathLabel: 'OpenAI-compatible path',
          }),
        );
      }
      const bytes = bytesResult.bytes;
      parts.push({
        type: 'image_url',
        image_url: {
          url: bytesToDataUrl({ mimeType: item.mimeType, bytes }),
          detail: 'auto',
        },
      });
      sawImageUrl = true;
      continue;
    }

    const _exhaustive: never = item;
    parts.push({ type: 'text', text: `[unknown content item: ${String(_exhaustive)}]` });
  }

  if (sawAnyImage) {
    if (sawImageUrl) {
      out.push({ role: 'user', content: parts });
    } else {
      const text = parts
        .filter((p): p is Extract<ChatCompletionContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text.length > 0) {
        out.push({ role: 'user', content: text });
      }
    }
  }

  return out;
}

function mergeAdjacentMessages(input: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  // Some proxies behave poorly with long runs of same-role messages (Dominds persists thinking/saying
  // as separate msgs). Merge adjacent user/assistant/system messages where safe.
  const merged: ChatCompletionMessageParam[] = [];

  for (const item of input) {
    if (!isRecord(item)) {
      merged.push(item);
      continue;
    }

    const role = item.role;
    const content = item.content;
    const hasToolCalls = 'tool_calls' in item && Array.isArray(item.tool_calls);
    const hasReasoningContent =
      'reasoning_content' in item && typeof item.reasoning_content === 'string';
    if (
      (role !== 'user' && role !== 'assistant' && role !== 'system') ||
      typeof content !== 'string' ||
      hasToolCalls ||
      hasReasoningContent
    ) {
      merged.push(item);
      continue;
    }

    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (
      prev &&
      isRecord(prev) &&
      prev.role === role &&
      typeof prev.content === 'string' &&
      !('tool_calls' in prev && Array.isArray(prev.tool_calls)) &&
      !('reasoning_content' in prev && typeof prev.reasoning_content === 'string')
    ) {
      prev.content = `${prev.content}\n${content}`;
      continue;
    }

    merged.push(item);
  }

  return merged;
}

async function buildChatCompletionMessages(
  systemPrompt: string,
  context: ChatMessage[],
  requestContext: LlmRequestContext,
  options?: {
    providerConfig?: ProviderConfig;
    onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>;
    onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>;
  },
): Promise<ChatCompletionMessageParam[]> {
  const normalized = normalizeToolCallPairs(context);
  const violation = findFirstToolCallAdjacencyViolation(normalized);
  if (violation) {
    const detail = formatToolCallAdjacencyViolation(
      violation,
      'OPENAI-COMPATIBLE provider projection',
    );
    log.error(detail, new Error('openai_compatible_tool_call_adjacency_violation'), {
      callId: violation.callId,
      toolName: violation.toolName,
      violationKind: violation.kind,
      index: violation.index,
    });
    throw new Error(detail);
  }
  const input: ChatCompletionMessageParam[] = [];
  const toolResultMaxChars = resolveProviderToolResultMaxChars(options?.providerConfig);
  const allowedImageKeys = selectLatestImagesWithinBudget(
    normalized,
    OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  );
  const attachToolCallReasoning = shouldAttachReasoningContentToAssistantToolCalls(
    options?.providerConfig,
  );
  let pendingReasoningContent: string | undefined;
  let assistantTurnReasoningContent: string | undefined;

  const takePendingReasoningContent = (): string | undefined => {
    const current = pendingReasoningContent;
    pendingReasoningContent = undefined;
    return current;
  };

  const appendReasoningContent = (value: string): void => {
    if (value.length === 0) return;
    pendingReasoningContent =
      pendingReasoningContent && pendingReasoningContent.length > 0
        ? `${pendingReasoningContent}\n${value}`
        : value;
  };

  const noteAssistantTurnReasoningContent = (value: string | undefined): void => {
    if (!value) return;
    assistantTurnReasoningContent = value;
  };

  const flushPendingReasoningAsAssistantMessage = (): void => {
    const reasoningContent = takePendingReasoningContent();
    if (!reasoningContent) return;
    noteAssistantTurnReasoningContent(reasoningContent);
    input.push(
      attachReasoningContent(
        {
          role: 'assistant',
          content: '',
        },
        reasoningContent,
      ),
    );
  };

  if (systemPrompt.trim().length > 0) {
    input.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const msg of normalized) {
    if (msg.type === 'thinking_msg') {
      appendReasoningContent(extractThinkingReasoningText(msg));
      continue;
    }

    if (msg.type === 'func_call_msg') {
      const mapped = chatMessageToChatCompletionMessage(msg);
      const pending = takePendingReasoningContent();
      noteAssistantTurnReasoningContent(pending);
      const reasoningContent = attachToolCallReasoning
        ? (pending ?? assistantTurnReasoningContent)
        : undefined;
      input.push(attachReasoningContent(mapped, reasoningContent));
      continue;
    }

    if (msg.type === 'func_result_msg') {
      flushPendingReasoningAsAssistantMessage();
      input.push(
        ...(await funcResultToChatCompletionMessages(
          msg,
          toolResultMaxChars,
          requestContext,
          options?.providerConfig,
          allowedImageKeys,
          options?.onToolResultImageIngest,
        )),
      );
      continue;
    }

    if (
      msg.type === 'environment_msg' ||
      msg.type === 'prompting_msg' ||
      msg.type === 'tellask_result_msg' ||
      msg.type === 'tellask_carryover_msg'
    ) {
      assistantTurnReasoningContent = undefined;
    }

    const mapped =
      (msg.type === 'prompting_msg' ||
        msg.type === 'tellask_result_msg' ||
        msg.type === 'tellask_carryover_msg') &&
      Array.isArray(msg.contentItems) &&
      msg.contentItems.length > 0
        ? await userLikeMessageToChatCompletionMessageWithImages(
            msg,
            requestContext,
            options?.providerConfig,
            allowedImageKeys,
            options?.onUserImageIngest,
          )
        : chatMessageToChatCompletionMessage(msg);
    const reasoningContent = takePendingReasoningContent();
    noteAssistantTurnReasoningContent(reasoningContent);
    input.push(attachReasoningContent(mapped, reasoningContent));
  }

  flushPendingReasoningAsAssistantMessage();

  return mergeAdjacentMessages(input);
}

export async function buildOpenAiCompatibleRequestMessagesWrapper(
  systemPrompt: string,
  context: ChatMessage[],
  requestContextOrOptions?: LlmRequestContext | { providerConfig?: ProviderConfig },
  optionsMaybe?: { providerConfig?: ProviderConfig },
): Promise<ChatCompletionMessageParam[]> {
  const requestContext = isLlmRequestContext(requestContextOrOptions)
    ? requestContextOrOptions
    : {
        dialogSelfId: '',
        dialogRootId: '',
        providerKey: 'openai-compatible',
        modelKey: 'unknown',
      };
  const options = isLlmRequestContext(requestContextOrOptions)
    ? optionsMaybe
    : requestContextOrOptions;
  return await buildChatCompletionMessages(systemPrompt, context, requestContext, options);
}

function applyArgsDelta(state: { argsJson: string }, chunk: string): void {
  if (chunk.length === 0) return;
  if (state.argsJson.length === 0) {
    state.argsJson = chunk;
    return;
  }
  // Support both delta and cumulative streaming implementations.
  if (chunk.startsWith(state.argsJson)) {
    state.argsJson = chunk;
    return;
  }
  if (state.argsJson.startsWith(chunk)) {
    return;
  }
  state.argsJson += chunk;
}

type ActiveFuncCall = {
  index: number;
  callId: string;
  name: string;
  argsJson: string;
  emitted: boolean;
};

function synthesizeCallId(genseq: number, index: number): string {
  // Some OpenAI-compatible proxies omit `id` in tool call deltas. Dominds requires a stable call id
  // for correlating tool outputs across turns; synthesize one that is stable for this generation.
  return `toolcall_${genseq}_${index}`;
}

function buildOpenAiCompatibleStreamError(args: {
  detail: string;
  kind: 'conflicting_stream' | 'invalid_tool_call';
}): LlmStreamErrorEmittedError {
  return new LlmStreamErrorEmittedError({
    detail: args.detail,
    i18nStopReason: buildHumanSystemStopReasonTextI18n({
      detail: args.detail,
      kind: args.kind,
    }),
  });
}

function throwOpenAiCompatibleMalformedBatchToolCall(detail: string): never {
  const message = `OPENAI-COMPATIBLE malformed batch tool call: ${detail}`;
  const error = new Error(message) as Error & { code?: string };
  error.code = OPENAI_COMPATIBLE_MALFORMED_BATCH_TOOL_CALL_ERROR_CODE;
  log.error(message, error);
  throw error;
}

function buildInvalidStreamedToolFunctionNameCall(state: ActiveFuncCall): LlmInvalidFuncCall {
  return {
    provider: 'openai-compatible',
    callId: state.callId,
    detail: `OPENAI-COMPATIBLE missing streamed tool function name for callId=${state.callId}`,
    toolCallIndex: state.index,
    rawArgumentsText: state.argsJson,
  };
}

function buildInvalidToolFunctionNameCall(args: {
  callId: string;
  toolCallIndex: number;
  rawArgumentsText: string;
}): LlmInvalidFuncCall {
  return {
    provider: 'openai-compatible',
    callId: args.callId,
    detail: `OPENAI-COMPATIBLE missing tool function name for callId=${args.callId}`,
    toolCallIndex: args.toolCallIndex,
    rawArgumentsText: args.rawArgumentsText,
  };
}

async function maybeEmitFuncCall(
  state: ActiveFuncCall,
  receiver: LlmStreamReceiver,
  genseq: number,
): Promise<void> {
  if (state.emitted) return;
  if (state.callId.trim().length === 0) {
    state.callId = synthesizeCallId(genseq, state.index);
  }
  if (state.name.trim().length === 0) {
    if (state.argsJson.trim().length === 0) {
      log.warn('OPENAI-COMPATIBLE ignored empty streamed tool call placeholder', undefined, {
        callId: state.callId,
        index: state.index,
      });
      state.emitted = true;
      return;
    }
    const invalidCall = buildInvalidStreamedToolFunctionNameCall(state);
    const detail = invalidCall.detail;
    log.error(detail, new Error('openai_compatible_missing_tool_call_name'), {
      callId: state.callId,
      index: state.index,
    });
    if (!receiver.invalidFuncCall) {
      if (receiver.streamError) {
        await receiver.streamError(detail);
      }
      throw buildOpenAiCompatibleStreamError({
        detail,
        kind: 'invalid_tool_call',
      });
    }
    state.emitted = true;
    await receiver.invalidFuncCall(invalidCall);
    return;
  }
  state.emitted = true;
  const args = state.argsJson.trim().length > 0 ? state.argsJson : '{}';
  await receiver.funcCall(state.callId, state.name, args);
}

async function emitOpenAiCompatibleStreamError(args: {
  receiver: LlmStreamReceiver;
  detail: string;
  kind: 'conflicting_stream' | 'invalid_tool_call';
  errorCode: string;
  logMeta?: Record<string, unknown>;
}): Promise<never> {
  log.error(args.detail, new Error(args.errorCode), args.logMeta);
  if (args.receiver.streamError) {
    await args.receiver.streamError(args.detail);
  }
  throw buildOpenAiCompatibleStreamError({
    detail: args.detail,
    kind: args.kind,
  });
}

async function consumeOpenAiCompatibleChatCompletionStream(args: {
  stream: AsyncIterable<ChatCompletionChunk>;
  receiver: LlmStreamReceiver;
  genseq: number;
  abortSignal?: AbortSignal;
}): Promise<LlmStreamResult> {
  let sayingStarted = false;
  let thinkingStarted = false;
  let currentThinkingContent = '';
  type ActiveStream = 'idle' | 'thinking' | 'saying';
  let activeStream: ActiveStream = 'idle';
  let usage: LlmUsageStats = { kind: 'unavailable' };
  let returnedModel: string | undefined;

  const activeCallsByIndex = new Map<number, ActiveFuncCall>();

  const finishThinkingSegment = async (): Promise<void> => {
    if (!thinkingStarted) return;
    await args.receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
    thinkingStarted = false;
    currentThinkingContent = '';
    if (activeStream === 'thinking') activeStream = 'idle';
  };

  const finishSayingSegment = async (): Promise<void> => {
    if (!sayingStarted) return;
    await args.receiver.sayingFinish();
    sayingStarted = false;
    if (activeStream === 'saying') activeStream = 'idle';
  };

  const ensureCanEnterThinking = async (): Promise<void> => {
    if (activeStream !== 'saying') return;
    await finishSayingSegment();
  };

  const ensureCanEnterSaying = async (): Promise<void> => {
    if (activeStream !== 'thinking') return;
    await finishThinkingSegment();
  };

  try {
    for await (const chunk of args.stream) {
      if (args.abortSignal?.aborted) throw new Error('AbortError');

      if (
        returnedModel === undefined &&
        typeof chunk.model === 'string' &&
        chunk.model.length > 0
      ) {
        returnedModel = chunk.model;
      }

      if (chunk.usage) {
        usage = tryExtractChatUsage(chunk.usage);
      }

      const choice = chunk.choices && chunk.choices.length > 0 ? chunk.choices[0] : undefined;
      if (!choice) continue;

      const delta = choice.delta;
      const reasoningDelta = extractReasoningContentField(delta as unknown);
      if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
        await ensureCanEnterThinking();
        if (!thinkingStarted) {
          thinkingStarted = true;
          currentThinkingContent = '';
          await args.receiver.thinkingStart();
          activeStream = 'thinking';
        }
        currentThinkingContent += reasoningDelta;
        await args.receiver.thinkingChunk(reasoningDelta);
      }

      const content = delta.content;
      if (typeof content === 'string' && content.length > 0) {
        await ensureCanEnterSaying();
        if (!sayingStarted) {
          sayingStarted = true;
          await args.receiver.sayingStart();
          activeStream = 'saying';
        }
        await args.receiver.sayingChunk(content);
      }

      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        await finishThinkingSegment();
        await finishSayingSegment();
        for (const call of toolCalls) {
          const rawIndex: unknown = call.index;
          const index =
            typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
              ? rawIndex
              : undefined;
          if (index === undefined) {
            await emitOpenAiCompatibleStreamError({
              receiver: args.receiver,
              detail: `OPENAI-COMPATIBLE invalid tool call index: ${JSON.stringify(rawIndex)}`,
              kind: 'invalid_tool_call',
              errorCode: 'openai_compatible_invalid_tool_call_index',
            });
            continue;
          }
          const rawType: unknown = call.type;
          if (rawType !== undefined && rawType !== 'function') {
            const detail = `OPENAI-COMPATIBLE invalid streamed tool call type for index=${String(index)}: expected function, got ${JSON.stringify(rawType)}`;
            await emitOpenAiCompatibleStreamError({
              receiver: args.receiver,
              detail,
              kind: 'invalid_tool_call',
              errorCode: 'openai_compatible_invalid_tool_call_type',
            });
          }
          const existing = activeCallsByIndex.get(index);
          const rawCallId: unknown = call.id;
          if (
            typeof rawCallId === 'string' &&
            rawCallId.length > 0 &&
            existing !== undefined &&
            existing.callId.length > 0 &&
            existing.callId !== rawCallId
          ) {
            const detail = `OPENAI-COMPATIBLE conflicting streamed tool call id for index=${String(index)}: existing=${existing.callId}, next=${rawCallId}`;
            await emitOpenAiCompatibleStreamError({
              receiver: args.receiver,
              detail,
              kind: 'invalid_tool_call',
              errorCode: 'openai_compatible_conflicting_tool_call_id',
              logMeta: { callId: rawCallId },
            });
          }
          const state: ActiveFuncCall =
            existing ??
            ({
              index,
              callId: '',
              name: '',
              argsJson: '',
              emitted: false,
            } satisfies ActiveFuncCall);

          if (typeof call.id === 'string' && call.id.length > 0) state.callId = call.id;
          if (call.function) {
            if (typeof call.function.name === 'string' && call.function.name.length > 0) {
              if (state.name.length > 0 && state.name !== call.function.name) {
                const detail = `OPENAI-COMPATIBLE conflicting streamed tool function name for callId=${state.callId}: existing=${state.name}, next=${call.function.name}`;
                await emitOpenAiCompatibleStreamError({
                  receiver: args.receiver,
                  detail,
                  kind: 'invalid_tool_call',
                  errorCode: 'openai_compatible_conflicting_tool_call_name',
                  logMeta: { callId: state.callId },
                });
              }
              state.name = call.function.name;
            }
            if (typeof call.function.arguments === 'string' && call.function.arguments.length > 0) {
              applyArgsDelta(state, call.function.arguments);
            }
          }

          activeCallsByIndex.set(index, state);
        }
      }

      if (choice.finish_reason === 'tool_calls') {
        await finishThinkingSegment();
        await finishSayingSegment();
        activeStream = 'idle';
        for (const state of activeCallsByIndex.values()) {
          await maybeEmitFuncCall(state, args.receiver, args.genseq);
        }
        activeCallsByIndex.clear();
      }

      if (
        choice.finish_reason === 'stop' ||
        choice.finish_reason === 'length' ||
        choice.finish_reason === 'content_filter'
      ) {
        await finishThinkingSegment();
        await finishSayingSegment();
        activeStream = 'idle';
      }
    }

    for (const state of activeCallsByIndex.values()) {
      await maybeEmitFuncCall(state, args.receiver, args.genseq);
    }
  } finally {
    if (thinkingStarted) {
      await args.receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
    }
    if (sayingStarted) await args.receiver.sayingFinish();
  }

  return { usage, ...(returnedModel ? { llmGenModel: returnedModel } : {}) };
}

export async function consumeOpenAiCompatibleChatCompletionStreamForTest(args: {
  stream: AsyncIterable<ChatCompletionChunk>;
  receiver: LlmStreamReceiver;
  genseq: number;
  abortSignal?: AbortSignal;
}): Promise<LlmStreamResult> {
  return await consumeOpenAiCompatibleChatCompletionStream({
    stream: args.stream,
    receiver: args.receiver,
    genseq: args.genseq,
    abortSignal: args.abortSignal,
  });
}

function chatCompletionToBatchOutputs(response: ChatCompletion, genseq: number): LlmBatchOutput[] {
  const outputs: LlmBatchOutput[] = [];
  const choice = response.choices && response.choices.length > 0 ? response.choices[0] : undefined;
  const msg = choice ? choice.message : undefined;
  if (!msg) return outputs;

  const reasoningContent = extractReasoningContentField(msg as unknown);
  if (reasoningContent && reasoningContent.length > 0) {
    const message: ChatMessage = {
      type: 'thinking_msg',
      role: 'assistant',
      genseq,
      content: reasoningContent,
      reasoning: buildReasoningPayloadFromText(reasoningContent),
    };
    outputs.push({ kind: 'message', message });
  }

  const content = typeof msg.content === 'string' ? msg.content : null;
  if (content && content.length > 0) {
    const message: ChatMessage = { type: 'saying_msg', role: 'assistant', genseq, content };
    outputs.push({ kind: 'message', message });
  }

  const toolCalls = msg.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      if (!call) {
        throwOpenAiCompatibleMalformedBatchToolCall(`empty tool call at index=${String(index)}`);
      }
      if (call.type !== undefined && call.type !== 'function') {
        throwOpenAiCompatibleMalformedBatchToolCall(
          `invalid tool call type at index=${String(index)}: expected function, got ${JSON.stringify(call.type)}`,
        );
      }
      const callId =
        typeof call.id === 'string' && call.id.trim().length > 0
          ? call.id
          : synthesizeCallId(genseq, index);
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
      if (name.trim().length === 0) {
        const invalidCall = buildInvalidToolFunctionNameCall({
          callId,
          toolCallIndex: index,
          rawArgumentsText: args,
        });
        log.error(invalidCall.detail, new Error('openai_compatible_missing_tool_call_name'), {
          callId,
          index,
        });
        outputs.push({ kind: 'invalid_func_call', call: invalidCall });
        continue;
      }
      const message: ChatMessage = {
        type: 'func_call_msg',
        role: 'assistant',
        genseq,
        id: callId,
        name,
        arguments: args,
      };
      outputs.push({ kind: 'message', message });
    }
  }

  return outputs;
}

function batchOutputsToChatMessages(outputs: ReadonlyArray<LlmBatchOutput>): ChatMessage[] {
  return outputs
    .filter((output): output is Extract<LlmBatchOutput, { kind: 'message' }> => {
      return output.kind === 'message';
    })
    .map((output) => output.message);
}

function chatCompletionToChatMessages(response: ChatCompletion, genseq: number): ChatMessage[] {
  const out = batchOutputsToChatMessages(chatCompletionToBatchOutputs(response, genseq));
  return out;
}

export function chatCompletionToChatMessagesForTest(
  response: ChatCompletion,
  genseq: number,
): ChatMessage[] {
  return chatCompletionToChatMessages(response, genseq);
}

export function chatCompletionToBatchOutputsForTest(
  response: ChatCompletion,
  genseq: number,
): LlmBatchOutput[] {
  return chatCompletionToBatchOutputs(response, genseq);
}

export class OpenAiCompatibleGen implements LlmGenerator {
  get apiType(): string {
    return 'openai-compatible';
  }

  classifyFailure(error: unknown): LlmFailureDisposition | undefined {
    return classifyOpenAiLikeFailure(error);
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
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }

    const client = createOpenAiCompatibleClient({
      apiKey,
      providerConfig,
      agent,
      requestContext,
      requestKind: 'stream',
    });

    const messages = await buildChatCompletionMessages(systemPrompt, context, requestContext, {
      providerConfig,
      onToolResultImageIngest: receiver.toolResultImageIngest,
      onUserImageIngest: receiver.userImageIngest,
    });

    const openAiParams = agent.model_params?.['openai-compatible'] || {};
    const parallelToolCalls = resolveOpenAiCompatibleParallelToolCalls({
      providerConfig,
      openAiParams,
    });
    const responseFormat = buildChatCompletionResponseFormat(openAiParams);
    const requestTools = resolveOpenAiCompatibleRequestTools(funcTools, requestContext);
    const modelInfo = resolveOpenAiCompatibleRequestModelInfo(
      providerConfig,
      agent,
      requestContext,
    );
    const toolChoice = resolveOpenAiCompatibleToolChoice(requestTools, requestContext, modelInfo);
    const openAiCompatibleExtraParams = buildOpenAiCompatibleExtraParams({
      providerConfig,
      agent,
      openAiParams,
      requestContext,
    });

    const payload: ChatCompletionCreateParamsStreaming & OpenAiCompatibleChatExtraParams = {
      model: agent.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(openAiParams.service_tier !== undefined && { service_tier: openAiParams.service_tier }),
      ...(openAiParams.safety_identifier !== undefined && {
        safety_identifier: openAiParams.safety_identifier,
      }),
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...openAiCompatibleExtraParams,
      ...(responseFormat !== undefined && { response_format: responseFormat }),
      ...(requestTools.length > 0
        ? { tools: requestTools.map((tool) => funcToolToChatCompletionTool(tool, providerConfig)) }
        : {}),
      ...(toolChoice !== undefined && { tool_choice: toolChoice }),
      ...(parallelToolCalls !== undefined && { parallel_tool_calls: parallelToolCalls }),
    };

    try {
      const stream: AsyncIterable<ChatCompletionChunk> = await client.chat.completions.create(
        payload,
        {
          ...(abortSignal ? { signal: abortSignal } : {}),
        },
      );
      return await consumeOpenAiCompatibleChatCompletionStream({
        stream,
        receiver,
        genseq,
        abortSignal,
      });
    } catch (error: unknown) {
      const enrichedError = await wrapOpenAiCompatibleRejectedRequestError({
        error,
        providerConfig,
        agent,
        requestContext,
        genseq,
        requestKind: 'stream',
        payload,
      });
      log.warn('OPENAI-COMPATIBLE streaming error', enrichedError, {
        providerKey: requestContext.providerKey ?? providerConfig.name,
        model: requestContext.modelKey ?? agent.model,
        rootId: requestContext.dialogRootId,
        selfId: requestContext.dialogSelfId,
        genseq,
      });
      throw enrichedError;
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
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }

    const client = createOpenAiCompatibleClient({
      apiKey,
      providerConfig,
      agent,
      requestContext,
      requestKind: 'batch',
    });
    const outputs: LlmBatchOutput[] = [];
    const messages = await buildChatCompletionMessages(systemPrompt, context, requestContext, {
      providerConfig,
      onToolResultImageIngest: async (ingest) => {
        outputs.push({ kind: 'tool_result_image_ingest', ingest });
      },
      onUserImageIngest: async (ingest) => {
        outputs.push({ kind: 'user_image_ingest', ingest });
      },
    });

    const openAiParams = agent.model_params?.['openai-compatible'] || {};
    const parallelToolCalls = resolveOpenAiCompatibleParallelToolCalls({
      providerConfig,
      openAiParams,
    });
    const responseFormat = buildChatCompletionResponseFormat(openAiParams);
    const requestTools = resolveOpenAiCompatibleRequestTools(funcTools, requestContext);
    const modelInfo = resolveOpenAiCompatibleRequestModelInfo(
      providerConfig,
      agent,
      requestContext,
    );
    const toolChoice = resolveOpenAiCompatibleToolChoice(requestTools, requestContext, modelInfo);
    const openAiCompatibleExtraParams = buildOpenAiCompatibleExtraParams({
      providerConfig,
      agent,
      openAiParams,
      requestContext,
    });

    const payload: ChatCompletionCreateParamsNonStreaming & OpenAiCompatibleChatExtraParams = {
      model: agent.model,
      messages,
      ...(openAiParams.service_tier !== undefined && { service_tier: openAiParams.service_tier }),
      ...(openAiParams.safety_identifier !== undefined && {
        safety_identifier: openAiParams.safety_identifier,
      }),
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...openAiCompatibleExtraParams,
      ...(responseFormat !== undefined && { response_format: responseFormat }),
      ...(requestTools.length > 0 && {
        tools: requestTools.map((tool) => funcToolToChatCompletionTool(tool, providerConfig)),
      }),
      ...(toolChoice !== undefined && { tool_choice: toolChoice }),
      ...(parallelToolCalls !== undefined && { parallel_tool_calls: parallelToolCalls }),
    };

    try {
      const response = await client.chat.completions.create(payload, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      const batchOutputs = chatCompletionToBatchOutputs(response, genseq);
      const messagesOut = batchOutputsToChatMessages(batchOutputs);
      const orderedOutputs: LlmBatchOutput[] =
        outputs.length > 0
          ? [
              ...outputs,
              ...messagesOut.map((message): LlmBatchOutput => ({ kind: 'message', message })),
              ...batchOutputs.filter((output) => output.kind !== 'message'),
            ]
          : batchOutputs;
      const usage: LlmUsageStats = response.usage
        ? tryExtractChatUsage(response.usage)
        : ({ kind: 'unavailable' } satisfies LlmUsageStats);
      const model =
        typeof response.model === 'string' && response.model.length > 0
          ? response.model
          : undefined;
      return {
        messages: messagesOut,
        ...(orderedOutputs.length > 0 ? { outputs: orderedOutputs } : {}),
        usage,
        ...(model ? { llmGenModel: model } : {}),
      };
    } catch (error: unknown) {
      const enrichedError = await wrapOpenAiCompatibleRejectedRequestError({
        error,
        providerConfig,
        agent,
        requestContext,
        genseq,
        requestKind: 'batch',
        payload,
      });
      log.warn('OPENAI-COMPATIBLE batch error', enrichedError, {
        providerKey: requestContext.providerKey ?? providerConfig.name,
        model: requestContext.modelKey ?? agent.model,
        rootId: requestContext.dialogRootId,
        selfId: requestContext.dialogSelfId,
        genseq,
      });
      throw enrichedError;
    }
  }
}
