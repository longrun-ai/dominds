/**
 * Module: llm/gen/anthropic
 *
 * Anthropic Messages API integration implementing streaming and batch generation.
 */
import type { ClientOptions } from '@anthropic-ai/sdk';
import { Anthropic } from '@anthropic-ai/sdk';
import type {
  ImageBlockParam,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  TextBlockParam,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { createHash } from 'crypto';
import { once } from 'events';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../runtime/i18n-text';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import { normalizeProviderApiQuirks } from '../api-quirks';
import type { ChatMessage, FuncCallMsg, FuncResultMsg, ProviderConfig } from '../client';
import type {
  LlmBatchOutput,
  LlmBatchResult,
  LlmFailureDisposition,
  LlmGenerator,
  LlmRequestContext,
  LlmStreamReceiver,
  LlmStreamResult,
  ToolResultImageIngest,
  UserImageIngest,
} from '../gen';
import { isVisionImageMimeType } from './artifacts';
import { classifyAnthropicFailure } from './failure-classifier';
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
  ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  buildImageBudgetKeyForContentItem,
  buildImageBudgetLimitDetail,
  buildToolResultImageIngest,
  buildUserImageIngest,
  readToolResultImageBytesSafe,
  resolveModelImageInputSupport,
  selectLatestImagesWithinBudget,
} from './tool-result-image-ingest';

const log = createLogger('llm/anthropic');
const ANTHROPIC_JSON_RESPONSE_TOOL_NAME = 'dominds_json_response';
const ANTHROPIC_JSON_RESPONSE_TOOL_DESCRIPTION =
  'Return the final answer as a JSON object. Do not include any non-JSON text.';
const ANTHROPIC_COMPAT_CAPTURE_SSE_ENV = 'DOMINDS_ANTHROPIC_COMPAT_CAPTURE_SSE';
const ANTHROPIC_COMPAT_CAPTURE_DIR_ENV = 'DOMINDS_ANTHROPIC_COMPAT_CAPTURE_DIR';
const GLM_VIA_VOLCANO_API_QUIRK = 'glm-via-volcano';
const VOLCANO_TOOL_USE_API_QUIRK = 'volcano-tool-use';
const VOLCANO_TEXT_TOOL_USE_PATTERN =
  /Function call emitted by the assistant\.\r?\nTool name:\s*([A-Za-z_][A-Za-z0-9_.:-]*)\r?\nCall ID:\s*(call_[A-Za-z0-9_-]+)\r?\nRaw arguments, verbatim:\r?\n<raw_arguments>(?:\r?\n)?([\s\S]*?)(?:\r?\n)?<\/raw_arguments>/g;
const VOLCANO_SEED_TOOL_CALL_PATTERN =
  /<seed:tool_call>\s*<function\s+name="([A-Za-z_][A-Za-z0-9_.:-]*)">\s*([\s\S]*?)<\/function>\s*<\/seed:tool_call>/g;
const VOLCANO_SEED_TOOL_PARAMETER_PATTERN =
  /<parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/parameter>/g;
const ANTHROPIC_JSON_RESPONSE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} satisfies Tool['input_schema'];

type AnthropicMessageContent = Exclude<MessageParam['content'], string>;

type AnthropicContentBlock = AnthropicMessageContent[number];

type AnthropicContextProjectionMessage =
  | Readonly<{ kind: 'chat'; msg: ChatMessage }>
  | Readonly<{ kind: 'function_call_text'; call: FuncCallMsg }>
  | Readonly<{ kind: 'function_result_text'; result: FuncResultMsg }>;

type ActiveToolUse = {
  id: string;
  name: string;
  inputJson: string;
  initialInput: unknown;
};

export type AnthropicStreamConsumeQuirks = {
  normalizeLoneClosingBraceEmptyToolInputDelta: boolean;
  convertVolcanoTextToolUseBlocks: boolean;
};

export type AnthropicStreamConsumeOptions = {
  abortSignal?: AbortSignal;
  forcedJsonToolName?: string;
  quirks?: AnthropicStreamConsumeQuirks;
  genseq?: number;
};

type OfficialAnthropicThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens: number };

type AnthropicCompatibleThinkingConfig = { type: 'enabled' } | { type: 'disabled' };

type AnthropicProviderThinkingConfig =
  | OfficialAnthropicThinkingConfig
  | AnthropicCompatibleThinkingConfig;

type AnthropicRequestBaseParams = Omit<MessageCreateParamsNonStreaming, 'stream' | 'thinking'> & {
  thinking?: AnthropicProviderThinkingConfig;
  reasoning_split?: boolean;
};

type AnthropicStreamingRequestParams = AnthropicRequestBaseParams & {
  stream: true;
  signal?: AbortSignal;
};

type AnthropicNonStreamingRequestParams = AnthropicRequestBaseParams & {
  stream: false;
  signal?: AbortSignal;
};

type AnthropicCompatibleCaptureContext = {
  providerKey: string | undefined;
  providerName: string;
  model: string;
  dialogRootId: string;
  dialogSelfId: string;
  requestKind: 'stream' | 'batch';
};

type AnthropicCompatibleCaptureRecord = {
  id: string;
  dir: string;
  metaPath: string;
  requestBodyPath: string;
  responseBodyPath: string;
  framesPath: string;
  summaryPath: string;
  context: AnthropicCompatibleCaptureContext;
};

type SseFrameParseResult =
  | { kind: 'no_data' }
  | { kind: 'done' }
  | { kind: 'json_ok' }
  | { kind: 'invalid_json'; message: string; data: string };

type SseCaptureState = {
  buffer: string;
  frameCount: number;
  jsonFrameCount: number;
  invalidJsonFrameCount: number;
  invalidFrames: Array<{ frameIndex: number; eventName: string; message: string; data: string }>;
};

class AnthropicCompatibleHttpError extends Error {
  public readonly status: number;
  public readonly headers: Record<string, string>;
  public readonly responseBody: string;

  constructor(args: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    responseBody: string;
  }) {
    const bodyPreview =
      args.responseBody.length > 500 ? `${args.responseBody.slice(0, 500)}...` : args.responseBody;
    super(
      `Anthropic-compatible HTTP request failed: ${args.status} ${args.statusText}; body=${bodyPreview}`,
    );
    this.name = 'AnthropicCompatibleHttpError';
    this.status = args.status;
    this.headers = args.headers;
    this.responseBody = args.responseBody;
  }
}

function isAnthropicCompatibleSseCaptureEnabled(): boolean {
  const configured = process.env[ANTHROPIC_COMPAT_CAPTURE_SSE_ENV]?.trim().toLowerCase();
  return configured === '1' || configured === 'true' || configured === 'yes' || configured === 'on';
}

function resolveAnthropicCompatibleCaptureDir(): string {
  const configured = process.env[ANTHROPIC_COMPAT_CAPTURE_DIR_ENV]?.trim();
  if (configured && configured.length > 0) return path.resolve(configured);
  return path.resolve(process.cwd(), '.dialogs', 'debug', 'anthropic-compatible-sse');
}

function sanitizeCapturePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (sanitized.length === 0) return 'unknown';
  return sanitized.slice(0, 96);
}

function buildAnthropicCompatibleCaptureId(context: AnthropicCompatibleCaptureContext): string {
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

function redactHttpHeader(name: string, value: string): string {
  const normalized = name.toLowerCase();
  if (
    normalized === 'authorization' ||
    normalized === 'x-api-key' ||
    normalized === 'api-key' ||
    normalized === 'anthropic-api-key' ||
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

async function startAnthropicCompatibleCapture(
  context: AnthropicCompatibleCaptureContext,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<AnthropicCompatibleCaptureRecord> {
  const captureRoot = resolveAnthropicCompatibleCaptureDir();
  const id = buildAnthropicCompatibleCaptureId(context);
  const dir = path.join(captureRoot, id);
  await fs.mkdir(dir, { recursive: true });

  const record: AnthropicCompatibleCaptureRecord = {
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
  if (bodyText !== undefined) {
    await fs.writeFile(record.requestBodyPath, bodyText, 'utf-8');
  } else {
    await fs.writeFile(record.requestBodyPath, '', 'utf-8');
  }

  await writeCaptureJson(record.metaPath, {
    id: record.id,
    capturedAt: new Date().toISOString(),
    context,
    env: {
      enabledBy: ANTHROPIC_COMPAT_CAPTURE_SSE_ENV,
      captureDirEnv: process.env[ANTHROPIC_COMPAT_CAPTURE_DIR_ENV]
        ? ANTHROPIC_COMPAT_CAPTURE_DIR_ENV
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

  log.info('ANTH compatible SSE capture started', {
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

function parseSseFrameJson(frame: string): SseFrameParseResult {
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

function buildSseFrameLogLine(frame: string, state: SseCaptureState): string {
  const { eventName, data } = parseSseFrameData(frame);
  const result = parseSseFrameJson(frame);
  if (result.kind === 'json_ok') state.jsonFrameCount += 1;
  if (result.kind === 'invalid_json') {
    state.invalidJsonFrameCount += 1;
    state.invalidFrames.push({
      frameIndex: state.frameCount,
      eventName,
      message: result.message,
      data: result.data,
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
    await once(stream, 'drain');
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
    log.warn('ANTH response reader cancel failed during cleanup', error, context);
  }
}

async function captureAnthropicCompatibleResponseBody(
  record: AnthropicCompatibleCaptureRecord,
  response: Response,
): Promise<void> {
  const responseClone = response.clone();
  const rawStream = createWriteStream(record.responseBodyPath);
  const framesStream = createWriteStream(record.framesPath);
  const decoder = new TextDecoder();
  const state: SseCaptureState = {
    buffer: '',
    frameCount: 0,
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
          await writeAndDrain(rawStream, readResult.value);
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
        const rest = decoder.decode();
        if (rest.length > 0) state.buffer += rest;
        if (state.buffer.trim().length > 0) {
          state.frameCount += 1;
          await writeAndDrain(framesStream, buildSseFrameLogLine(state.buffer, state));
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
  } finally {
    await Promise.all([endWriteStream(rawStream), endWriteStream(framesStream)]);
  }

  await writeCaptureJson(record.summaryPath, {
    id: record.id,
    completedAt: new Date().toISOString(),
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    headers: headersToRedactedRecord(response.headers),
    frameCount: state.frameCount,
    jsonFrameCount: state.jsonFrameCount,
    invalidJsonFrameCount: state.invalidJsonFrameCount,
    invalidFrames: state.invalidFrames,
  });

  if (state.invalidJsonFrameCount > 0) {
    log.warn('ANTH compatible SSE capture found invalid JSON data frame', undefined, {
      captureDir: record.dir,
      invalidJsonFrameCount: state.invalidJsonFrameCount,
      invalidFrames: state.invalidFrames,
      providerKey: record.context.providerKey,
      model: record.context.model,
      rootId: record.context.dialogRootId,
      selfId: record.context.dialogSelfId,
    });
  } else {
    log.info('ANTH compatible SSE capture completed', {
      captureDir: record.dir,
      frameCount: state.frameCount,
      providerKey: record.context.providerKey,
      model: record.context.model,
      rootId: record.context.dialogRootId,
      selfId: record.context.dialogSelfId,
    });
  }
}

function buildAnthropicCompatibleCaptureFetch(
  context: AnthropicCompatibleCaptureContext,
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record = await startAnthropicCompatibleCapture(context, input, init);
    try {
      const response = await fetch(input, init);
      void captureAnthropicCompatibleResponseBody(record, response).catch((error: unknown) => {
        log.error('ANTH compatible SSE capture failed while reading response clone', error, {
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

function createAnthropicClient(args: {
  apiKey: string;
  providerConfig: ProviderConfig;
  agent: Team.Member;
  requestContext: LlmRequestContext;
  requestKind: 'stream' | 'batch';
}): Anthropic {
  const options: ClientOptions = {
    apiKey: args.apiKey,
    baseURL: args.providerConfig.baseUrl,
  };
  if (
    args.providerConfig.apiType === 'anthropic-compatible' &&
    isAnthropicCompatibleSseCaptureEnabled()
  ) {
    options.fetch = buildAnthropicCompatibleCaptureFetch({
      providerKey: args.requestContext.providerKey,
      providerName: args.providerConfig.name,
      model: args.agent.model ?? args.requestContext.modelKey ?? 'unknown',
      dialogRootId: args.requestContext.dialogRootId,
      dialogSelfId: args.requestContext.dialogSelfId,
      requestKind: args.requestKind,
    });
  }
  return new Anthropic(options);
}

function resolveAnthropicStreamConsumeQuirks(
  providerConfig: ProviderConfig,
): AnthropicStreamConsumeQuirks {
  const apiQuirks = normalizeProviderApiQuirks(providerConfig);
  return {
    normalizeLoneClosingBraceEmptyToolInputDelta: apiQuirks.has(GLM_VIA_VOLCANO_API_QUIRK),
    convertVolcanoTextToolUseBlocks: apiQuirks.has(VOLCANO_TOOL_USE_API_QUIRK),
  };
}

function buildAnthropicCompatibleMessagesUrl(providerConfig: ProviderConfig): string {
  if (!providerConfig.baseUrl) {
    throw new Error(`Provider '${providerConfig.name}' is missing baseUrl.`);
  }
  const baseUrl = providerConfig.baseUrl.endsWith('/')
    ? providerConfig.baseUrl
    : `${providerConfig.baseUrl}/`;
  return new URL('v1/messages', baseUrl).toString();
}

function stringifySseDataPreview(data: string): string {
  return data.length > 500 ? `${data.slice(0, 500)}...` : data;
}

function parseAnthropicCompatibleSseFrame(frame: string): MessageStreamEvent | null {
  const { eventName, data } = parseSseFrameData(frame);
  if (data === undefined) return null;
  if (data === '[DONE]') return null;
  if (eventName === 'ping') return null;
  if (eventName === 'error') {
    throw new Error(`Anthropic-compatible SSE error event: ${stringifySseDataPreview(data)}`);
  }
  try {
    return JSON.parse(data) as MessageStreamEvent;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Anthropic-compatible SSE data is not valid JSON (event=${eventName || '<none>'}): ${message}; data=${JSON.stringify(
        stringifySseDataPreview(data),
      )}`,
    );
  }
}

async function* streamAnthropicCompatibleRawSse(args: {
  apiKey: string;
  providerConfig: ProviderConfig;
  agent: Team.Member;
  requestContext: LlmRequestContext;
  params: AnthropicStreamingRequestParams;
}): AsyncIterable<MessageStreamEvent> {
  const { signal, ...bodyParams } = args.params;
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'x-api-key': args.apiKey,
  });
  const fetchImpl =
    args.providerConfig.apiType === 'anthropic-compatible' &&
    isAnthropicCompatibleSseCaptureEnabled()
      ? buildAnthropicCompatibleCaptureFetch({
          providerKey: args.requestContext.providerKey,
          providerName: args.providerConfig.name,
          model: args.agent.model ?? args.requestContext.modelKey ?? 'unknown',
          dialogRootId: args.requestContext.dialogRootId,
          dialogSelfId: args.requestContext.dialogSelfId,
          requestKind: 'stream',
        })
      : fetch;

  const response = await fetchImpl(buildAnthropicCompatibleMessagesUrl(args.providerConfig), {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyParams),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new AnthropicCompatibleHttpError({
      status: response.status,
      statusText: response.statusText,
      headers: headersToRedactedRecord(response.headers),
      responseBody,
    });
  }

  if (!response.body) {
    throw new Error('Anthropic-compatible SSE response body is empty.');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let done = false;
  let sawSseDataFrame = false;
  try {
    for (;;) {
      const readResult = await reader.read();
      if (readResult.done) {
        done = true;
        break;
      }
      buffer += decoder.decode(readResult.value, { stream: true });
      for (;;) {
        const separator = buffer.match(/\r?\n\r?\n/);
        if (!separator || separator.index === undefined) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (frame.trim().length === 0) continue;
        if (parseSseFrameData(frame).data !== undefined) sawSseDataFrame = true;
        const event = parseAnthropicCompatibleSseFrame(frame);
        if (event) yield event;
      }
    }
    const rest = decoder.decode();
    if (rest.length > 0) buffer += rest;
    if (buffer.trim().length > 0) {
      if (parseSseFrameData(buffer).data !== undefined) sawSseDataFrame = true;
      const event = parseAnthropicCompatibleSseFrame(buffer);
      if (event) yield event;
    }
    if (!sawSseDataFrame) {
      throw new Error('Anthropic-compatible SSE stream ended without any data frames.');
    }
  } finally {
    if (!done) {
      await cancelReadableStreamReader(reader, {
        providerKey: args.requestContext.providerKey,
        model: args.agent.model ?? args.requestContext.modelKey,
      });
    }
    reader.releaseLock();
  }
}

function limitAnthropicToolOutputText(
  text: string,
  msg: FuncResultMsg,
  limitChars: number,
): string {
  const limited = truncateProviderToolOutputText(text, limitChars);
  if (limited.truncated) {
    log.warn('ANTH tool output truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalChars: limited.originalChars,
      limitChars: limited.limitChars,
    });
  }
  return limited.text;
}

function limitAnthropicToolOutputBlocks(
  content: Array<TextBlockParam | ImageBlockParam>,
  msg: FuncResultMsg,
  limitChars: number,
): Array<TextBlockParam | ImageBlockParam> {
  let remainingChars = limitChars;
  let truncated = false;
  const limited: Array<TextBlockParam | ImageBlockParam> = [];

  for (const block of content) {
    if (block.type !== 'text') {
      limited.push(block);
      continue;
    }

    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    const next = truncateProviderToolOutputText(block.text, remainingChars);
    limited.push({ type: 'text', text: next.text });
    remainingChars -= next.text.length;
    if (next.truncated) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    const originalChars = content.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
      0,
    );
    log.warn('ANTH tool output blocks truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalTextChars: originalChars,
      limitChars,
    });
  }

  return limited;
}

function countAnthropicTextBlockChars(content: readonly AnthropicContentBlock[]): number {
  return content.reduce((sum, block) => {
    if (block.type !== 'text') {
      return sum;
    }
    return sum + block.text.length;
  }, 0);
}

export type AnthropicStreamConsumeResult = {
  usage: LlmUsageStats;
  llmGenModel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonArrayRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function isLlmRequestContext(value: unknown): value is LlmRequestContext {
  return (
    isNonArrayRecord(value) &&
    typeof value.dialogSelfId === 'string' &&
    typeof value.dialogRootId === 'string' &&
    typeof value.providerKey === 'string' &&
    typeof value.modelKey === 'string'
  );
}

function tryExtractApiReturnedModel(value: unknown): string | undefined {
  // NOTE: External API payload; a runtime check is unavoidable.
  if (!isRecord(value)) return undefined;
  if (!('model' in value)) return undefined;
  const model = value.model;
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isRecord(value) &&
    value.type === 'tool_use' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string'
  );
}

function isTextOrImageBlockParam(value: unknown): value is TextBlockParam | ImageBlockParam {
  return isRecord(value) && (value.type === 'text' || value.type === 'image');
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

function resolveAnthropicParams(
  providerConfig: ProviderConfig,
  agent: Team.Member,
):
  | NonNullable<Team.ModelParams['anthropic']>
  | NonNullable<Team.ModelParams['anthropic-compatible']> {
  if (providerConfig.apiType === 'anthropic-compatible') {
    return agent.model_params?.['anthropic-compatible'] || {};
  }
  return agent.model_params?.anthropic || {};
}

function resolveAnthropicJsonResponseEnabled(
  providerConfig: ProviderConfig,
  agent: Team.Member,
): boolean {
  const anthropicParams = resolveAnthropicParams(providerConfig, agent);
  const providerSpecific = anthropicParams.json_response;
  if (providerSpecific !== undefined) return providerSpecific;
  return agent.model_params?.json_response === true;
}

function buildAnthropicForcedJsonTool(): Tool {
  return {
    name: ANTHROPIC_JSON_RESPONSE_TOOL_NAME,
    description: ANTHROPIC_JSON_RESPONSE_TOOL_DESCRIPTION,
    input_schema: ANTHROPIC_JSON_RESPONSE_TOOL_INPUT_SCHEMA,
  };
}

function buildAnthropicToolList(funcTools: FuncTool[], forceJsonResponse: boolean): Tool[] {
  const tools = funcTools.map(funcToolToAnthropic);
  if (!forceJsonResponse) return tools;
  if (tools.some((tool) => tool.name === ANTHROPIC_JSON_RESPONSE_TOOL_NAME)) {
    throw new Error(
      `Anthropic tool name collision: '${ANTHROPIC_JSON_RESPONSE_TOOL_NAME}' is reserved for json_response mode.`,
    );
  }
  tools.push(buildAnthropicForcedJsonTool());
  return tools;
}

function buildAnthropicThinkingConfig(
  anthropicParams:
    | NonNullable<Team.ModelParams['anthropic']>
    | NonNullable<Team.ModelParams['anthropic-compatible']>,
  providerConfig: ProviderConfig,
): AnthropicProviderThinkingConfig | undefined {
  const configured = anthropicParams.thinking;
  if (configured === undefined) return undefined;

  if (providerConfig.apiType === 'anthropic-compatible') {
    if (configured === true) return { type: 'enabled' };
    if (configured === false) return { type: 'disabled' };
    throw new Error(
      `Invalid model_params.anthropic-compatible.thinking for provider '${providerConfig.name}' (apiType=anthropic-compatible): expected boolean.`,
    );
  }

  if (typeof configured === 'boolean') {
    throw new Error(
      `Invalid model_params.anthropic.thinking for provider '${providerConfig.name}' (apiType=anthropic): expected Anthropic thinking object.`,
    );
  }
  return configured;
}

function serializeAnthropicForcedJsonObject(input: unknown, at: string): string {
  if (!isNonArrayRecord(input)) {
    throw new Error(`Invalid ${at}: expected JSON object output in json_response mode.`);
  }
  return JSON.stringify(input);
}

function extractJsonObjectCandidate(text: string): string | null {
  const markdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (markdownMatch && typeof markdownMatch[1] === 'string' && markdownMatch[1].trim().length > 0) {
    return markdownMatch[1].trim();
  }
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject !== -1 && lastObject !== -1 && lastObject > firstObject) {
    return text.slice(firstObject, lastObject + 1).trim();
  }
  return null;
}

function parseForcedJsonToolInput(rawJson: string, fallbackInput: unknown, at: string): unknown {
  const trimmed = rawJson.trim();
  if (trimmed.length === 0) return fallbackInput;

  const candidates: string[] = [trimmed];
  const extracted = extractJsonObjectCandidate(trimmed);
  if (extracted && extracted !== trimmed) {
    candidates.push(extracted);
  }
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}') && trimmed.length > 4) {
    candidates.push(trimmed.slice(1, -1).trim());
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      lastError = error;
    }
  }

  const errorText = lastError instanceof Error ? lastError.message : String(lastError);
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  if (isNonArrayRecord(fallbackInput)) {
    log.warn(
      'ANTH malformed forced-json tool input; using initialInput fallback',
      new Error(errorText),
      {
        at,
        rawPreview: preview,
      },
    );
    return fallbackInput;
  }
  throw new Error(`Invalid ${at}: ${errorText}; raw=${JSON.stringify(preview)}`);
}

async function funcResultToAnthropicToolResultBlock(
  chatMsg: FuncResultMsg,
  limitChars: number,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
): Promise<Extract<AnthropicContentBlock, { type: 'tool_result' }>> {
  const items = chatMsg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return {
      type: 'tool_result',
      tool_use_id: chatMsg.id,
      content: limitAnthropicToolOutputText(chatMsg.content, chatMsg, limitChars),
    };
  }

  const content: Array<TextBlockParam | ImageBlockParam> = [];
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      content.push({ type: 'text', text: item.text });
      continue;
    }

    if (item.type === 'input_image') {
      if (!supportsImageInput) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: chatMsg.id,
              toolName: chatMsg.name,
              artifact: item.artifact,
              disposition: 'filtered_model_unsupported',
              providerPathLabel: 'Anthropic Messages path',
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
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: chatMsg.id,
              toolName: chatMsg.name,
              artifact: item.artifact,
              disposition: 'filtered_mime_unsupported',
              mimeType: item.mimeType,
              providerPathLabel: 'Anthropic Messages path',
            }),
          );
        }
        content.push({
          type: 'text',
          text: `[image omitted: unsupported mimeType=${item.mimeType}]`,
        });
        continue;
      }
      if (
        !allowedImageKeys.has(
          buildImageBudgetKeyForContentItem({ msg: chatMsg, itemIndex, artifact: item.artifact }),
        )
      ) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: chatMsg.id,
              toolName: chatMsg.name,
              artifact: item.artifact,
              disposition: 'filtered_size_limit',
              detail: buildImageBudgetLimitDetail({
                byteLength: item.byteLength,
                budgetBytes: ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'Anthropic Messages path',
            }),
          );
        }
        content.push({
          type: 'text',
          text: `[image omitted: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              toolCallId: chatMsg.id,
              toolName: chatMsg.name,
              artifact: item.artifact,
              disposition: 'filtered_missing',
              providerPathLabel: 'Anthropic Messages path',
            }),
          );
        }
        content.push({ type: 'text', text: `[image missing: ${item.artifact.relPath}]` });
        continue;
      }
      if (bytesResult.kind === 'read_failed') {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: chatMsg.id,
              toolName: chatMsg.name,
              artifact: item.artifact,
              disposition: 'filtered_read_failed',
              detail: bytesResult.detail,
              providerPathLabel: 'Anthropic Messages path',
            }),
          );
        }
        content.push({ type: 'text', text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      if (onToolResultImageIngest) {
        await onToolResultImageIngest(
          buildToolResultImageIngest({
            requestContext,
            toolCallId: chatMsg.id,
            toolName: chatMsg.name,
            artifact: item.artifact,
            disposition: 'fed_native',
            providerPathLabel: 'Anthropic Messages path',
          }),
        );
      }
      const bytes = bytesResult.bytes;
      const base64 = bytes.toString('base64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: item.mimeType,
          data: base64,
        },
      });
      continue;
    }

    const _exhaustive: never = item;
    content.push({ type: 'text', text: `[unknown content item: ${String(_exhaustive)}]` });
  }

  if (content.length === 0) {
    return {
      type: 'tool_result',
      tool_use_id: chatMsg.id,
      content: limitAnthropicToolOutputText(chatMsg.content, chatMsg, limitChars),
    };
  }

  return {
    type: 'tool_result',
    tool_use_id: chatMsg.id,
    content: limitAnthropicToolOutputBlocks(content, chatMsg, limitChars),
  };
}

async function chatMessageToContentBlocksAsync(
  chatMsg: ChatMessage,
  limitChars: number,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<AnthropicContentBlock[]> {
  if (
    (chatMsg.type === 'prompting_msg' ||
      chatMsg.type === 'tellask_result_msg' ||
      chatMsg.type === 'tellask_carryover_msg') &&
    Array.isArray(chatMsg.contentItems) &&
    chatMsg.contentItems.length > 0
  ) {
    const content: Array<TextBlockParam | ImageBlockParam> = [
      { type: 'text', text: chatMsg.content },
    ];
    for (const [itemIndex, item] of chatMsg.contentItems.entries()) {
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
                ...(chatMsg.type === 'prompting_msg' ? { msgId: chatMsg.msgId } : {}),
                artifact: item.artifact,
                disposition: 'filtered_model_unsupported',
                providerPathLabel: 'Anthropic Messages path',
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
                ...(chatMsg.type === 'prompting_msg' ? { msgId: chatMsg.msgId } : {}),
                artifact: item.artifact,
                disposition: 'filtered_mime_unsupported',
                mimeType: item.mimeType,
                providerPathLabel: 'Anthropic Messages path',
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
            buildImageBudgetKeyForContentItem({ msg: chatMsg, itemIndex, artifact: item.artifact }),
          )
        ) {
          if (onUserImageIngest) {
            await onUserImageIngest(
              buildUserImageIngest({
                requestContext,
                ...(chatMsg.type === 'prompting_msg' ? { msgId: chatMsg.msgId } : {}),
                artifact: item.artifact,
                disposition: 'filtered_size_limit',
                detail: buildImageBudgetLimitDetail({
                  byteLength: item.byteLength,
                  budgetBytes: ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
                }),
                providerPathLabel: 'Anthropic Messages path',
              }),
            );
          }
          content.push({
            type: 'text',
            text: `[image not sent: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
              ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
                ...(chatMsg.type === 'prompting_msg' ? { msgId: chatMsg.msgId } : {}),
                artifact: item.artifact,
                disposition: 'filtered_missing',
                providerPathLabel: 'Anthropic Messages path',
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
                ...(chatMsg.type === 'prompting_msg' ? { msgId: chatMsg.msgId } : {}),
                artifact: item.artifact,
                disposition: 'filtered_read_failed',
                detail: bytesResult.detail,
                providerPathLabel: 'Anthropic Messages path',
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
              ...(chatMsg.type === 'prompting_msg' ? { msgId: chatMsg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'fed_native',
              providerPathLabel: 'Anthropic Messages path',
            }),
          );
        }
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: item.mimeType,
            data: bytesResult.bytes.toString('base64'),
          },
        });
        continue;
      }
      const _exhaustive: never = item;
      throw new Error(`Unsupported user content item: ${String(_exhaustive)}`);
    }
    return content;
  }

  if (chatMsg.type !== 'func_result_msg') {
    return chatMessageToContentBlocks(chatMsg);
  }
  return [
    await funcResultToAnthropicToolResultBlock(
      chatMsg,
      limitChars,
      requestContext,
      allowedImageKeys,
      supportsImageInput,
      onToolResultImageIngest,
    ),
  ];
}

async function chatMessageToAnthropicAsync(
  chatMsg: ChatMessage,
  limitChars: number,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<MessageParam> {
  const contentBlocks = await chatMessageToContentBlocksAsync(
    chatMsg,
    limitChars,
    requestContext,
    allowedImageKeys,
    supportsImageInput,
    onToolResultImageIngest,
    onUserImageIngest,
  );
  if (contentBlocks.length === 0) {
    throw new Error(`No content blocks generated for message: ${JSON.stringify(chatMsg)}`);
  }

  let role: 'user' | 'assistant' = 'assistant';
  if ('role' in chatMsg) {
    role = chatMsg.role === 'tool' ? 'user' : chatMsg.role;
  }
  return {
    role,
    content: contentBlocks.length === 1 ? contentBlocks : contentBlocks,
  };
}

async function funcResultToAnthropicTextBlocks(
  result: FuncResultMsg,
  limitChars: number,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
): Promise<AnthropicContentBlock[]> {
  const resultText = limitAnthropicToolOutputText(
    formatFunctionCallResultForAnthropicTextContext(result),
    result,
    limitChars,
  );
  const contentBlocks: AnthropicContentBlock[] = [
    {
      type: 'text',
      text: resultText,
    },
  ];
  if (!Array.isArray(result.contentItems) || result.contentItems.length === 0) {
    return contentBlocks;
  }

  const remainingTextChars = Math.max(0, limitChars - countAnthropicTextBlockChars(contentBlocks));
  const toolResultBlock = await funcResultToAnthropicToolResultBlock(
    result,
    remainingTextChars,
    requestContext,
    allowedImageKeys,
    supportsImageInput,
    onToolResultImageIngest,
  );
  const toolResultContent = toolResultBlock.content;
  if (typeof toolResultContent === 'string') {
    if (toolResultContent.length > 0) {
      contentBlocks.push({ type: 'text', text: toolResultContent });
    }
    return contentBlocks;
  }
  if (!Array.isArray(toolResultContent)) {
    return contentBlocks;
  }
  contentBlocks.push(...toolResultContent.filter(isTextOrImageBlockParam));
  return contentBlocks;
}

async function anthropicProjectionToMessageAsync(
  projection: AnthropicContextProjectionMessage,
  limitChars: number,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<MessageParam> {
  switch (projection.kind) {
    case 'chat':
      return await chatMessageToAnthropicAsync(
        projection.msg,
        limitChars,
        requestContext,
        allowedImageKeys,
        supportsImageInput,
        onToolResultImageIngest,
        onUserImageIngest,
      );
    case 'function_call_text':
      return {
        role: 'assistant',
        content: [{ type: 'text', text: formatFunctionCallForAnthropicTextContext(projection) }],
      };
    case 'function_result_text':
      return {
        role: 'user',
        content: await funcResultToAnthropicTextBlocks(
          projection.result,
          limitChars,
          requestContext,
          allowedImageKeys,
          supportsImageInput,
          onToolResultImageIngest,
        ),
      };
    default: {
      const _exhaustive: never = projection;
      return _exhaustive;
    }
  }
}

async function buildAnthropicRequestMessages(
  context: ChatMessage[],
  requestContext: LlmRequestContext,
  providerConfig?: ProviderConfig,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<MessageParam[]> {
  // Anthropic's native tool_use.input requires structured JSON. Historical Dominds function-call
  // arguments are opaque raw strings, so persisted call/result pairs are projected as text while
  // preserving the original tool-result image handling path.
  const normalized = normalizeToolCallPairs(context);
  const violation = findFirstToolCallAdjacencyViolation(normalized);
  if (violation) {
    const detail = formatToolCallAdjacencyViolation(violation, 'ANTH provider projection');
    log.error(detail, new Error('anthropic_tool_call_adjacency_violation'), {
      callId: violation.callId,
      toolName: violation.toolName,
      violationKind: violation.kind,
      index: violation.index,
    });
    throw new Error(detail);
  }
  const messages: MessageParam[] = [];
  const toolResultMaxChars = resolveProviderToolResultMaxChars(providerConfig);
  const projectedContext = projectFunctionCallPairsForAnthropicTextContext(normalized);
  const allowedImageKeys = selectLatestImagesWithinBudget(
    normalized,
    ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  );
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    true,
  );

  for (const msg of projectedContext) {
    messages.push(
      await anthropicProjectionToMessageAsync(
        msg,
        toolResultMaxChars,
        requestContext,
        allowedImageKeys,
        supportsImageInput,
        onToolResultImageIngest,
        onUserImageIngest,
      ),
    );
  }

  return assembleAnthropicTurns(messages);
}

export async function buildAnthropicRequestMessagesWrapper(
  context: ChatMessage[],
  requestContextOrProviderConfig?: LlmRequestContext | ProviderConfig,
  providerConfigMaybe?: ProviderConfig,
): Promise<MessageParam[]> {
  const requestContext = isLlmRequestContext(requestContextOrProviderConfig)
    ? requestContextOrProviderConfig
    : {
        dialogSelfId: '',
        dialogRootId: '',
        providerKey: 'anthropic',
        modelKey: 'unknown',
      };
  const providerConfig = isLlmRequestContext(requestContextOrProviderConfig)
    ? providerConfigMaybe
    : requestContextOrProviderConfig;
  return await buildAnthropicRequestMessages(context, requestContext, providerConfig);
}

/**
 * Reconstruct Anthropic context from persisted messages.
 * Relies on natural storage order - func_result always follows func_call.
 */
function reconstructAnthropicContext(persistedMessages: ChatMessage[]): MessageParam[] {
  return buildAnthropicRequestMessagesSync(persistedMessages);
}

function contentToBlocks(content: MessageParam['content']): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content as unknown as AnthropicContentBlock[];
}

function assembleAnthropicTurns(messages: MessageParam[]): MessageParam[] {
  // Provider payload projection (turn assembly)
  //
  // Dominds persists fine-grained events (thinking/saying/tool-use/tool-result as separate
  // ChatMessage entries). Many Anthropic-compatible endpoints are strict about role alternation and
  // reject consecutive messages with the same role.
  //
  // Instead of treating persisted entries as 1:1 provider messages, we assemble them into provider
  // turns by coalescing consecutive messages with the same role.
  //
  // Ideal future: provider SDKs should support a dedicated role='environment' for environment/system
  // messages. Today most providers accept only user/assistant (and tool via special-casing), so those
  // messages must be projected as role='user'.
  const turns: MessageParam[] = [];

  for (const msg of messages) {
    const contentBlocks = contentToBlocks(msg.content);
    if (contentBlocks.length === 0) continue;

    const prev = turns.length > 0 ? turns[turns.length - 1] : null;
    if (prev && prev.role === msg.role) {
      const prevBlocks = contentToBlocks(prev.content);
      prev.content = [...prevBlocks, ...contentBlocks];
      continue;
    }

    turns.push({ role: msg.role, content: contentBlocks });
  }

  return turns;
}

function formatFunctionCallForAnthropicTextContext(args: {
  call: Extract<ChatMessage, { type: 'func_call_msg' }>;
}): string {
  return (
    'Function call emitted by the assistant.\n' +
    `Tool name: ${args.call.name}\n` +
    `Call ID: ${args.call.id}\n` +
    'Raw arguments, verbatim:\n' +
    '<raw_arguments>\n' +
    `${args.call.arguments}\n` +
    '</raw_arguments>'
  );
}

function formatFunctionCallResultForAnthropicTextContext(
  result: Extract<ChatMessage, { type: 'func_result_msg' }>,
): string {
  return (
    'Function call result.\n' +
    `Tool name: ${result.name}\n` +
    `Call ID: ${result.id}\n` +
    'Result content:\n' +
    result.content
  );
}

function projectFunctionCallPairsForAnthropicTextContext(
  context: readonly ChatMessage[],
): AnthropicContextProjectionMessage[] {
  const projected: AnthropicContextProjectionMessage[] = [];

  for (let index = 0; index < context.length; index += 1) {
    const msg = context[index];
    if (msg.type !== 'func_call_msg') {
      projected.push({ kind: 'chat', msg });
      continue;
    }

    const result = context[index + 1];
    if (result === undefined || result.type !== 'func_result_msg' || result.id !== msg.id) {
      throw new Error(
        `ANTH function call text projection invariant violation: missing adjacent result for callId=${msg.id}, tool=${msg.name}`,
      );
    }

    projected.push({ kind: 'function_call_text', call: msg });
    projected.push({ kind: 'function_result_text', result });
    index += 1;
  }

  return projected;
}

function anthropicProjectionToMessageSync(
  projection: AnthropicContextProjectionMessage,
  toolResultMaxChars: number,
): MessageParam {
  switch (projection.kind) {
    case 'chat':
      return chatMessageToAnthropic(projection.msg);
    case 'function_call_text':
      return {
        role: 'assistant',
        content: [{ type: 'text', text: formatFunctionCallForAnthropicTextContext(projection) }],
      };
    case 'function_result_text':
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: limitAnthropicToolOutputText(
              formatFunctionCallResultForAnthropicTextContext(projection.result),
              projection.result,
              toolResultMaxChars,
            ),
          },
        ],
      };
    default: {
      const _exhaustive: never = projection;
      return _exhaustive;
    }
  }
}

function buildAnthropicRequestMessagesSync(context: ChatMessage[]): MessageParam[] {
  const normalized = normalizeToolCallPairs(context);
  const violation = findFirstToolCallAdjacencyViolation(normalized);
  if (violation) {
    const detail = formatToolCallAdjacencyViolation(violation, 'ANTH sync context reconstruction');
    log.error(detail, new Error('anthropic_tool_call_adjacency_violation'), {
      callId: violation.callId,
      toolName: violation.toolName,
      violationKind: violation.kind,
      index: violation.index,
    });
    throw new Error(detail);
  }
  const toolResultMaxChars = resolveProviderToolResultMaxChars(undefined);
  const projectedContext = projectFunctionCallPairsForAnthropicTextContext(normalized);
  const messages: MessageParam[] = [];

  for (const msg of projectedContext) {
    messages.push(anthropicProjectionToMessageSync(msg, toolResultMaxChars));
  }

  return assembleAnthropicTurns(messages);
}

function applyInputJsonDelta(state: ActiveToolUse, partialJson: string): void {
  if (partialJson.length === 0) return;
  if (state.inputJson.length === 0) {
    state.inputJson = partialJson;
    return;
  }

  // Some Anthropic-compatible providers stream `partial_json` as the full JSON accumulated so far
  // (cumulative), while Anthropic streams deltas. Support both.
  if (partialJson.startsWith(state.inputJson)) {
    state.inputJson = partialJson;
    return;
  }
  if (state.inputJson.startsWith(partialJson)) {
    return;
  }

  state.inputJson += partialJson;
}

function stringifyToolUseInitialInput(input: unknown): string {
  const stringified = JSON.stringify(input);
  return typeof stringified === 'string' && stringified.length > 0 ? stringified : '{}';
}

function isEmptyJsonObject(value: unknown): boolean {
  return isNonArrayRecord(value) && Object.keys(value).length === 0;
}

function resolveToolUseArgumentsJson(
  state: ActiveToolUse,
  quirks: AnthropicStreamConsumeQuirks,
): string {
  const trimmed = state.inputJson.trim();
  if (trimmed.length === 0) {
    return stringifyToolUseInitialInput(state.initialInput);
  }

  if (
    quirks.normalizeLoneClosingBraceEmptyToolInputDelta &&
    trimmed === '}' &&
    isEmptyJsonObject(state.initialInput)
  ) {
    log.warn(
      'ANTH quirk normalized lone closing-brace tool input delta to empty object',
      undefined,
      {
        quirk: GLM_VIA_VOLCANO_API_QUIRK,
        callId: state.id,
        toolName: state.name,
      },
    );
    return '{}';
  }

  try {
    JSON.parse(trimmed);
    return state.inputJson;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      'ANTH malformed tool_use input_json_delta; preserving raw arguments for tool feedback',
      error,
      {
        callId: state.id,
        toolName: state.name,
        rawPreview: trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed,
        parseError: message,
      },
    );
    return state.inputJson;
  }
}

type VolcanoTextToolUsePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; rawArgumentsText: string };

function decodeVolcanoSeedXmlText(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function createVolcanoSeedToolCallId(args: {
  name: string;
  rawParametersText: string;
  textIndex: number;
  blockIndex?: number;
  genseq?: number;
}): string {
  const hash = createHash('sha256')
    .update(args.name)
    .update('\0')
    .update(args.rawParametersText)
    .update('\0')
    .update(String(args.textIndex))
    .update('\0')
    .update(args.blockIndex === undefined ? '' : String(args.blockIndex))
    .digest('hex')
    .slice(0, 24);
  if (args.genseq !== undefined) {
    return `call_volcano_seed_g${String(args.genseq)}_${hash}`;
  }
  return `call_volcano_seed_${hash}`;
}

function assertValidAnthropicStreamGenseq(genseq: number | undefined): void {
  if (genseq === undefined) return;
  if (!Number.isInteger(genseq) || genseq <= 0) {
    throw new Error(`Invalid Anthropic stream genseq for tool-call correlation: ${String(genseq)}`);
  }
}

function parseVolcanoSeedParameterValue(args: {
  name: string;
  stringFlag: 'true' | 'false';
  rawValueText: string;
}): unknown {
  const decoded = decodeVolcanoSeedXmlText(args.rawValueText);
  if (args.stringFlag === 'true') return decoded;

  try {
    return JSON.parse(decoded) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call parameter JSON for ${args.name}: ${message}`,
    );
  }
}

function parseVolcanoSeedToolArgumentsJson(rawParametersText: string): string {
  const parameters: Record<string, unknown> = {};
  let cursor = 0;
  VOLCANO_SEED_TOOL_PARAMETER_PATTERN.lastIndex = 0;
  for (;;) {
    const match = VOLCANO_SEED_TOOL_PARAMETER_PATTERN.exec(rawParametersText);
    if (!match) break;
    if (rawParametersText.slice(cursor, match.index).trim().length > 0) {
      throw new Error(
        `Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call: unexpected text between parameters`,
      );
    }

    const rawName = match[1];
    const stringFlag = match[2];
    const rawValueText = match[3];
    if (rawName === undefined || stringFlag === undefined || rawValueText === undefined) {
      throw new Error(`Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call parameter`);
    }
    if (stringFlag !== 'true' && stringFlag !== 'false') {
      throw new Error(`Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call string flag`);
    }

    const name = decodeVolcanoSeedXmlText(rawName);
    if (Object.prototype.hasOwnProperty.call(parameters, name)) {
      throw new Error(
        `Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call: duplicate parameter ${name}`,
      );
    }
    parameters[name] = parseVolcanoSeedParameterValue({
      name,
      stringFlag,
      rawValueText,
    });
    cursor = VOLCANO_SEED_TOOL_PARAMETER_PATTERN.lastIndex;
  }

  if (cursor === 0 && rawParametersText.trim().length > 0) {
    throw new Error(`Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call parameters`);
  }
  if (rawParametersText.slice(cursor).trim().length > 0) {
    throw new Error(
      `Malformed ${VOLCANO_TOOL_USE_API_QUIRK} seed tool_call: unexpected trailing parameter text`,
    );
  }

  return JSON.stringify(parameters);
}

function splitVolcanoTextToolUseParts(args: {
  text: string;
  genseq?: number;
  blockIndex?: number;
}): VolcanoTextToolUsePart[] {
  const parts: VolcanoTextToolUsePart[] = [];
  const matches: Array<{
    index: number;
    endIndex: number;
    id: string;
    name: string;
    rawArgumentsText: string;
  }> = [];

  VOLCANO_TEXT_TOOL_USE_PATTERN.lastIndex = 0;
  for (;;) {
    const match = VOLCANO_TEXT_TOOL_USE_PATTERN.exec(args.text);
    if (!match) break;
    const name = match[1];
    const id = match[2];
    const rawArguments = match[3];
    if (name === undefined || id === undefined || rawArguments === undefined) {
      continue;
    }
    matches.push({
      index: match.index,
      endIndex: VOLCANO_TEXT_TOOL_USE_PATTERN.lastIndex,
      id,
      name,
      rawArgumentsText: rawArguments,
    });
  }

  VOLCANO_SEED_TOOL_CALL_PATTERN.lastIndex = 0;
  for (;;) {
    const match = VOLCANO_SEED_TOOL_CALL_PATTERN.exec(args.text);
    if (!match) break;
    const name = match[1];
    const rawParametersText = match[2];
    if (name === undefined || rawParametersText === undefined) {
      continue;
    }
    matches.push({
      index: match.index,
      endIndex: VOLCANO_SEED_TOOL_CALL_PATTERN.lastIndex,
      id: createVolcanoSeedToolCallId({
        name,
        rawParametersText,
        textIndex: match.index,
        blockIndex: args.blockIndex,
        genseq: args.genseq,
      }),
      name,
      rawArgumentsText: parseVolcanoSeedToolArgumentsJson(rawParametersText),
    });
  }

  matches.sort((a, b) => a.index - b.index);
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) {
      throw new Error(`Malformed ${VOLCANO_TOOL_USE_API_QUIRK} text tool_call: overlapping blocks`);
    }
    if (match.index > cursor) {
      parts.push({ kind: 'text', text: args.text.slice(cursor, match.index) });
    }
    parts.push({
      kind: 'tool_use',
      id: match.id,
      name: match.name,
      rawArgumentsText: match.rawArgumentsText,
    });
    cursor = match.endIndex;
  }
  if (cursor === 0) return [{ kind: 'text', text: args.text }];
  if (cursor < args.text.length) {
    parts.push({ kind: 'text', text: args.text.slice(cursor) });
  }
  return parts;
}

async function emitTextWithVolcanoToolUseQuirk(args: {
  text: string;
  receiver: LlmStreamReceiver;
  quirks: AnthropicStreamConsumeQuirks;
  sayingStarted: boolean;
  thinkingStarted: boolean;
  genseq?: number;
  blockIndex?: number;
}): Promise<{ sayingStarted: boolean; thinkingStarted: boolean }> {
  let sayingStarted = args.sayingStarted;
  let thinkingStarted = args.thinkingStarted;
  const parts = args.quirks.convertVolcanoTextToolUseBlocks
    ? splitVolcanoTextToolUseParts({
        text: args.text,
        genseq: args.genseq,
        blockIndex: args.blockIndex,
      })
    : [{ kind: 'text' as const, text: args.text }];

  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text.length === 0) continue;
      if (thinkingStarted) {
        log.error(
          'ANTH stream ordering violation: received text_delta while thinking stream still active',
          new Error('anthropic_stream_order_violation'),
        );
        await args.receiver.thinkingFinish();
        thinkingStarted = false;
      }
      if (!sayingStarted) {
        sayingStarted = true;
        await args.receiver.sayingStart();
      }
      await args.receiver.sayingChunk(part.text);
      continue;
    }

    if (sayingStarted) {
      await args.receiver.sayingFinish();
      sayingStarted = false;
    }
    log.warn('ANTH quirk converted text-rendered tool use to function call', undefined, {
      quirk: VOLCANO_TOOL_USE_API_QUIRK,
      callId: part.id,
      toolName: part.name,
    });
    await args.receiver.funcCall(part.id, part.name, part.rawArgumentsText);
  }
  return { sayingStarted, thinkingStarted };
}

async function flushPendingVolcanoTextToolUseBlocks(args: {
  pendingBlocks: Map<number, string>;
  receiver: LlmStreamReceiver;
  quirks: AnthropicStreamConsumeQuirks;
  sayingStarted: boolean;
  thinkingStarted: boolean;
  genseq?: number;
}): Promise<{ sayingStarted: boolean; thinkingStarted: boolean }> {
  let sayingStarted = args.sayingStarted;
  let thinkingStarted = args.thinkingStarted;
  const pendingEntries = [...args.pendingBlocks.entries()];
  args.pendingBlocks.clear();
  for (const [blockIndex, pendingText] of pendingEntries) {
    const updated = await emitTextWithVolcanoToolUseQuirk({
      text: pendingText,
      receiver: args.receiver,
      quirks: args.quirks,
      sayingStarted,
      thinkingStarted,
      genseq: args.genseq,
      blockIndex,
    });
    sayingStarted = updated.sayingStarted;
    thinkingStarted = updated.thinkingStarted;
  }
  return { sayingStarted, thinkingStarted };
}

/**
 * Convert a single ChatMessage to content blocks for Anthropic SDK.
 * Returns array of content blocks (may contain multiple for complex messages).
 * Call/result pairing is handled before this point by Anthropic context projection.
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
    const block: AnthropicContentBlock = {
      type: 'text',
      text: formatFunctionCallForAnthropicTextContext({ call: chatMsg }),
    };
    return [block];
  }

  // Fallback for direct conversion; normal persisted call/result pairs are projected as text first.
  if (chatMsg.type === 'func_result_msg') {
    const block: AnthropicContentBlock = {
      type: 'tool_result',
      tool_use_id: chatMsg.id,
      content: chatMsg.content,
    };
    return [block];
  }

  // Handle tellask call results (NOT LLM-native tool use; represented as role='user' text)
  if (chatMsg.type === 'tellask_result_msg' || chatMsg.type === 'tellask_carryover_msg') {
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

function anthropicToChatMessages(
  message: unknown,
  genseq: number,
  forcedJsonToolName?: string,
): ChatMessage[] {
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
      if (forcedJsonToolName && block.name === forcedJsonToolName) {
        const jsonText = serializeAnthropicForcedJsonObject(
          block.input,
          `tool_use:${block.id}:${block.name}`,
        );
        results.push({
          type: 'saying_msg',
          role: 'assistant',
          content: jsonText,
          genseq: genseq,
        });
        return;
      }
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

async function emitAnthropicStreamReadError(
  receiver: LlmStreamReceiver,
  error: unknown,
): Promise<void> {
  const errorText = error instanceof Error ? error.message : String(error);
  const detail = `ANTH stream read failed: ${errorText}`;
  log.warn(detail, error);
  if (receiver.streamError) {
    await receiver.streamError(detail);
  }
}

async function* streamWithReadDiagnostics(
  stream: AsyncIterable<MessageStreamEvent>,
  receiver: LlmStreamReceiver,
): AsyncIterable<MessageStreamEvent> {
  const iterator = stream[Symbol.asyncIterator]();
  let done = false;
  try {
    for (;;) {
      let next: IteratorResult<MessageStreamEvent>;
      try {
        next = await iterator.next();
      } catch (error: unknown) {
        await emitAnthropicStreamReadError(receiver, error);
        throw error;
      }
      if (next.done === true) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done && iterator.return) {
      try {
        await iterator.return();
      } catch (error: unknown) {
        log.warn('ANTH stream iterator return failed during cleanup', error);
      }
    }
  }
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

export async function consumeAnthropicStream(
  stream: AsyncIterable<MessageStreamEvent>,
  receiver: LlmStreamReceiver,
  options: AnthropicStreamConsumeOptions = {},
): Promise<AnthropicStreamConsumeResult> {
  const quirks = options.quirks ?? {
    normalizeLoneClosingBraceEmptyToolInputDelta: false,
    convertVolcanoTextToolUseBlocks: false,
  };
  const { abortSignal, forcedJsonToolName, genseq } = options;
  assertValidAnthropicStreamGenseq(genseq);

  // Stream lifecycle management using SDK start/stop events
  const activeContentBlocks = new Map<number, AnthropicMessageContent[number]>();
  const activeToolUses = new Map<number, ActiveToolUse>();
  const pendingVolcanoTextToolUseBlocks = new Map<number, string>();
  let sayingStarted = false;
  let thinkingStarted = false;
  let messageStarted = false;
  let messageStopped = false;
  let usage: LlmUsageStats = { kind: 'unavailable' };
  let returnedModel: string | undefined;

  for await (const event of streamWithReadDiagnostics(stream, receiver)) {
    if (abortSignal?.aborted) {
      throw new Error('AbortError');
    }
    switch (event.type) {
      case 'content_block_start': {
        const blockIndex = event.index;
        const contentBlock = event.content_block;
        const existingBlock = activeContentBlocks.get(blockIndex);
        if (existingBlock) {
          log.warn(
            'ANTH content_block_start replacing active content block at index',
            new Error('content_block_start_without_stop'),
            {
              index: blockIndex,
              prevType: existingBlock.type,
              nextType: contentBlock.type,
            },
          );
          activeToolUses.delete(blockIndex);
          pendingVolcanoTextToolUseBlocks.delete(blockIndex);
        }
        activeContentBlocks.set(blockIndex, contentBlock);

        // Track tool use so we can emit function calls once JSON is complete
        if (contentBlock.type === 'tool_use') {
          activeToolUses.set(blockIndex, {
            id: contentBlock.id,
            name: contentBlock.name,
            inputJson: '',
            initialInput: contentBlock.input,
          });
        } else if (contentBlock.type === 'text' && quirks.convertVolcanoTextToolUseBlocks) {
          pendingVolcanoTextToolUseBlocks.set(blockIndex, contentBlock.text ?? '');
        }

        break;
      }

      case 'content_block_delta': {
        const blockIndex = event.index;
        const activeContentBlock = activeContentBlocks.get(blockIndex);
        // Only process deltas for known content blocks
        if (!activeContentBlock) {
          log.warn(
            'ANTH unexpected content_block_delta without active content block',
            new Error('Delta received before content_block_start'),
            {
              index: blockIndex,
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
            const pendingText = pendingVolcanoTextToolUseBlocks.get(blockIndex);
            if (pendingText !== undefined) {
              pendingVolcanoTextToolUseBlocks.set(blockIndex, `${pendingText}${textDelta}`);
            } else {
              const updated = await emitTextWithVolcanoToolUseQuirk({
                text: textDelta,
                receiver,
                quirks,
                sayingStarted,
                thinkingStarted,
                genseq,
                blockIndex,
              });
              sayingStarted = updated.sayingStarted;
              thinkingStarted = updated.thinkingStarted;
            }
          }
        } else if (delta.type === 'thinking_delta') {
          const thinkingDelta = delta.thinking ?? '';
          if (thinkingDelta) {
            if (sayingStarted) {
              log.error(
                'ANTH stream ordering violation: received thinking_delta while saying stream still active',
                new Error('anthropic_stream_order_violation'),
              );
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            // Same rationale as text blocks: close thinking only on `message_stop`.
            if (!thinkingStarted) {
              thinkingStarted = true;
              await receiver.thinkingStart();
            }
            await receiver.thinkingChunk(thinkingDelta);
          }
        } else if (delta.type === 'citations_delta') {
          // Handle CitationsDelta - typically just logging for now
        } else if (delta.type === 'signature_delta') {
          // Handle SignatureDelta - typically just logging for now
        } else if (delta.type === 'input_json_delta') {
          const partialJson = delta.partial_json;
          const activeToolUse = activeToolUses.get(blockIndex);
          if (activeToolUse) {
            applyInputJsonDelta(activeToolUse, partialJson);
          } else if (partialJson.length > 0) {
            log.warn(
              'ANTH input_json_delta without active tool_use',
              new Error('Input JSON delta received without active tool_use block'),
              {
                hasCurrentBlock: true,
                blockIndex,
                blockType: activeContentBlock.type,
              },
            );
          }
        }
        break;
      }

      case 'content_block_stop': {
        const blockIndex = event.index;
        const activeContentBlock = activeContentBlocks.get(blockIndex);
        if (!activeContentBlock) {
          break;
        }

        // Close thinking as soon as the thinking block ends so downstream UI/persistence reflects
        // strict generation order (thinking first, then saying). This also avoids emitting
        // thinking_finish after the main message has already completed.
        if (activeContentBlock.type === 'thinking' && thinkingStarted) {
          await receiver.thinkingFinish();
          thinkingStarted = false;
        }

        if (activeContentBlock.type === 'tool_use') {
          const activeToolUse = activeToolUses.get(blockIndex);
          if (!activeToolUse) {
            log.warn(
              'ANTH tool_use stop without active tool_use',
              new Error('Tool_use block stopped without active tool tracking'),
              {
                blockIndex,
              },
            );
          } else {
            if (forcedJsonToolName && activeToolUse.name === forcedJsonToolName) {
              const forcedInput = parseForcedJsonToolInput(
                activeToolUse.inputJson,
                activeToolUse.initialInput,
                `tool_use:${activeToolUse.id}:${activeToolUse.name}`,
              );
              const jsonText = serializeAnthropicForcedJsonObject(
                forcedInput,
                `tool_use:${activeToolUse.id}:${activeToolUse.name}`,
              );
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
              }
              await receiver.sayingChunk(jsonText);
              await receiver.sayingFinish();
              sayingStarted = false;
            } else {
              const argsJson = resolveToolUseArgumentsJson(activeToolUse, quirks);
              await receiver.funcCall(activeToolUse.id, activeToolUse.name, argsJson);
            }
          }
          activeToolUses.delete(blockIndex);
        } else if (activeContentBlock.type === 'text') {
          const pendingText = pendingVolcanoTextToolUseBlocks.get(blockIndex);
          if (pendingText !== undefined) {
            const updated = await emitTextWithVolcanoToolUseQuirk({
              text: pendingText,
              receiver,
              quirks,
              sayingStarted,
              thinkingStarted,
              genseq,
              blockIndex,
            });
            sayingStarted = updated.sayingStarted;
            thinkingStarted = updated.thinkingStarted;
            pendingVolcanoTextToolUseBlocks.delete(blockIndex);
          }
        }

        activeContentBlocks.delete(blockIndex);
        break;
      }

      case 'message_start': {
        messageStarted = true;
        messageStopped = false;
        if (returnedModel === undefined) {
          returnedModel = tryExtractApiReturnedModel(event.message);
        }
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
        messageStopped = true;
        const updated = await flushPendingVolcanoTextToolUseBlocks({
          pendingBlocks: pendingVolcanoTextToolUseBlocks,
          receiver,
          quirks,
          sayingStarted,
          thinkingStarted,
          genseq,
        });
        sayingStarted = updated.sayingStarted;
        thinkingStarted = updated.thinkingStarted;
        activeContentBlocks.clear();
        activeToolUses.clear();

        if (thinkingStarted) {
          await receiver.thinkingFinish();
          thinkingStarted = false;
        }
        if (sayingStarted) {
          await receiver.sayingFinish();
          sayingStarted = false;
        }

        break;
      }

      // Note: input_json_delta is handled within content_block_delta as part of input_json_delta delta type

      default: {
        // Handle unexpected events with proper type checking
        const unknownEvent: unknown = event;
        const eventType =
          isRecord(unknownEvent) && typeof unknownEvent.type === 'string' ? unknownEvent.type : '';
        log.warn('ANTH unexpected llm event', new Error('Unknown event type'), {
          eventType: eventType.length > 0 ? eventType : 'unknown',
        });
        break;
      }
    }
  }

  if (
    (messageStarted && !messageStopped) ||
    activeContentBlocks.size > 0 ||
    activeToolUses.size > 0 ||
    pendingVolcanoTextToolUseBlocks.size > 0 ||
    thinkingStarted ||
    sayingStarted
  ) {
    const detail =
      'ANTH incomplete stream: provider event stream ended before a complete message lifecycle ' +
      `(messageStarted=${String(messageStarted)}, messageStopped=${String(messageStopped)}, ` +
      `activeContentBlocks=${String(activeContentBlocks.size)}, activeToolUses=${String(
        activeToolUses.size,
      )}, thinkingStarted=${String(thinkingStarted)}, sayingStarted=${String(sayingStarted)})`;
    log.error(detail, new Error('anthropic_incomplete_stream_state'));
    if (receiver.streamError) {
      await receiver.streamError(detail);
    }
    throw new Error(detail);
  }

  return { usage, llmGenModel: returnedModel };
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

export async function reconstructAnthropicContextWrapperAsync(
  persistedMessages: ChatMessage[],
): Promise<MessageParam[]> {
  const reconstructed = await buildAnthropicRequestMessages(persistedMessages, {
    dialogSelfId: '',
    dialogRootId: '',
    providerKey: 'anthropic',
    modelKey: 'unknown',
  });

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
  constructor(
    private readonly generatorApiType: 'anthropic' | 'anthropic-compatible' = 'anthropic',
  ) {}

  get apiType() {
    return this.generatorApiType;
  }

  classifyFailure(error: unknown): LlmFailureDisposition | undefined {
    return classifyAnthropicFailure(error);
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

    const requestMessages: MessageParam[] = await buildAnthropicRequestMessages(
      context,
      requestContext,
      providerConfig,
      receiver.toolResultImageIngest,
      receiver.userImageIngest,
    );

    const anthropicParams = resolveAnthropicParams(providerConfig, agent);
    const forceJsonResponse = resolveAnthropicJsonResponseEnabled(providerConfig, agent);

    // Safety check: model should never be undefined at this point due to validation in driver
    if (!agent.model) {
      throw new Error(
        `Internal error: Model is undefined for agent '${agent.id}' after validation`,
      );
    }

    // Get model info from provider config for output_length
    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxTokens = anthropicParams.max_tokens ?? outputLength ?? 1024;
    const thinking = buildAnthropicThinkingConfig(anthropicParams, providerConfig);

    const anthropicTools = buildAnthropicToolList(funcTools, forceJsonResponse);
    const baseParams = {
      model: agent.model,
      messages: requestMessages,
      system: systemPrompt.length > 0 ? systemPrompt : undefined,
      max_tokens: maxTokens,
      ...(thinking !== undefined && { thinking }),
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      ...(forceJsonResponse && {
        tool_choice: {
          type: 'tool' as const,
          name: ANTHROPIC_JSON_RESPONSE_TOOL_NAME,
          disable_parallel_tool_use: true,
        },
      }),
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

    const streamParams: AnthropicStreamingRequestParams = {
      ...baseParams,
      stream: true,
      ...(abortSignal ? { signal: abortSignal } : {}),
    };

    const stream: AsyncIterable<MessageStreamEvent> =
      providerConfig.apiType === 'anthropic-compatible'
        ? streamAnthropicCompatibleRawSse({
            apiKey,
            providerConfig,
            agent,
            requestContext,
            params: streamParams,
          })
        : createAnthropicClient({
            apiKey,
            providerConfig,
            agent,
            requestContext,
            requestKind: 'stream',
          }).messages.stream(streamParams as unknown as MessageCreateParamsStreaming);
    return consumeAnthropicStream(stream, receiver, {
      abortSignal,
      forcedJsonToolName: forceJsonResponse ? ANTHROPIC_JSON_RESPONSE_TOOL_NAME : undefined,
      quirks: resolveAnthropicStreamConsumeQuirks(providerConfig),
      genseq,
    });
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

    const client = createAnthropicClient({
      apiKey,
      providerConfig,
      agent,
      requestContext,
      requestKind: 'batch',
    });

    const outputs: LlmBatchOutput[] = [];
    const requestMessages: MessageParam[] = await buildAnthropicRequestMessages(
      context,
      requestContext,
      providerConfig,
      async (ingest) => {
        outputs.push({ kind: 'tool_result_image_ingest', ingest });
      },
      async (ingest) => {
        outputs.push({ kind: 'user_image_ingest', ingest });
      },
    );

    const anthropicParams = resolveAnthropicParams(providerConfig, agent);
    const forceJsonResponse = resolveAnthropicJsonResponseEnabled(providerConfig, agent);

    // Safety check: model should never be undefined at this point due to validation in driver
    if (!agent.model) {
      throw new Error(
        `Internal error: Model is undefined for agent '${agent.id}' after validation`,
      );
    }

    // Get model info from provider config for output_length
    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxTokens = anthropicParams.max_tokens ?? outputLength ?? 1024;
    const thinking = buildAnthropicThinkingConfig(anthropicParams, providerConfig);

    const anthropicTools = buildAnthropicToolList(funcTools, forceJsonResponse);
    const baseParams = {
      model: agent.model,
      messages: requestMessages,
      system: systemPrompt.length > 0 ? systemPrompt : undefined,
      max_tokens: maxTokens,
      ...(thinking !== undefined && { thinking }),
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      ...(forceJsonResponse && {
        tool_choice: {
          type: 'tool' as const,
          name: ANTHROPIC_JSON_RESPONSE_TOOL_NAME,
          disable_parallel_tool_use: true,
        },
      }),
      ...(anthropicParams.temperature !== undefined && {
        temperature: anthropicParams.temperature,
      }),
      ...(anthropicParams.top_p !== undefined && { top_p: anthropicParams.top_p }),
      ...(anthropicParams.top_k !== undefined && { top_k: anthropicParams.top_k }),
      ...(anthropicParams.stop_sequences !== undefined && {
        stop_sequences: anthropicParams.stop_sequences,
      }),
    };

    const createParams: AnthropicNonStreamingRequestParams = {
      ...baseParams,
      stream: false,
      ...(abortSignal ? { signal: abortSignal } : {}),
    };

    const response = await client.messages.create(
      createParams as unknown as MessageCreateParamsNonStreaming,
    );

    if (!response) {
      throw new Error('No response from Anthropic API');
    }
    const returnedModel = typeof response.model === 'string' ? response.model : undefined;

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

    return {
      messages: anthropicToChatMessages(
        response,
        genseq,
        forceJsonResponse ? ANTHROPIC_JSON_RESPONSE_TOOL_NAME : undefined,
      ),
      ...(outputs.length > 0 ? { outputs } : {}),
      usage,
      llmGenModel: returnedModel,
    };
  }
}
