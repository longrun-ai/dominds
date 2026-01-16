import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Dispatcher, RequestInit, Response as UndiciResponse } from 'undici';
import { Headers, ProxyAgent, fetch } from 'undici';

import { AuthManager } from '../auth/manager.js';
import {
  AuthState,
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR,
  DEFAULT_CHATGPT_BASE_URL,
  DEFAULT_ORIGINATOR,
} from '../auth/schema.js';
import { resolveCodexHome } from '../auth/storage.js';

export interface ChatGptCredentials {
  accessToken: string;
  accountId: string;
}

export interface ChatGptClientOptions {
  baseUrl?: string;
  useCodex?: boolean;
  originator?: string;
  userAgent?: string;
  codexHome?: string;
  proxyUrl?: string;
  useEnvProxy?: boolean;
}

export interface ChatGptRequestInit extends RequestInit {
  json?: unknown;
}

export type ChatGptJsonValue =
  | null
  | boolean
  | number
  | string
  | ChatGptJsonValue[]
  | { [key: string]: ChatGptJsonValue };

export type ChatGptReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ChatGptReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface ChatGptReasoning {
  effort?: ChatGptReasoningEffort;
  summary?: ChatGptReasoningSummary;
}

export type ChatGptVerbosity = 'low' | 'medium' | 'high';

export interface ChatGptTextFormat {
  type: 'json_schema';
  strict: boolean;
  schema: ChatGptJsonValue;
  name: string;
}

export interface ChatGptTextControls {
  verbosity?: ChatGptVerbosity;
  format?: ChatGptTextFormat;
}

export type ChatGptInclude = 'reasoning.encrypted_content';

export type ChatGptToolChoice = 'auto';

export type ChatGptJsonSchema = Record<string, unknown>;

export interface ChatGptFunctionTool {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: ChatGptJsonSchema;
}

export interface ChatGptLocalShellTool {
  type: 'local_shell';
}

export interface ChatGptWebSearchTool {
  type: 'web_search';
  external_web_access?: boolean;
}

export interface ChatGptFreeformToolFormat {
  type: string;
  syntax: string;
  definition: string;
}

export interface ChatGptFreeformTool {
  type: 'custom';
  name: string;
  description: string;
  format: ChatGptFreeformToolFormat;
}

export type ChatGptTool =
  | ChatGptFunctionTool
  | ChatGptLocalShellTool
  | ChatGptWebSearchTool
  | ChatGptFreeformTool;

export type ChatGptMessageRole = 'user' | 'assistant' | 'system';

export interface ChatGptOutputTextContent {
  type: 'output_text';
  text: string;
  annotations?: ChatGptJsonValue[];
  logprobs?: ChatGptJsonValue[];
}

export type ChatGptContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | ChatGptOutputTextContent;

export type ChatGptContentPart = ChatGptOutputTextContent;

export interface ChatGptMessageItem {
  type: 'message';
  role: ChatGptMessageRole;
  content: ChatGptContentItem[];
  id?: string;
}

export type ChatGptReasoningSummaryItem = { type: 'summary_text'; text: string };

export type ChatGptReasoningContentItem =
  | { type: 'reasoning_text'; text: string }
  | { type: 'text'; text: string };

export interface ChatGptReasoningItem {
  type: 'reasoning';
  summary: ChatGptReasoningSummaryItem[];
  content?: ChatGptReasoningContentItem[];
  encrypted_content?: string | null;
  id?: string;
}

export type ChatGptLocalShellStatus = 'completed' | 'in_progress' | 'incomplete';

export interface ChatGptLocalShellExecAction {
  type: 'exec';
  command: string[];
  timeout_ms?: number;
  working_directory?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface ChatGptLocalShellCallItem {
  type: 'local_shell_call';
  call_id?: string | null;
  status: ChatGptLocalShellStatus;
  action: ChatGptLocalShellExecAction;
  id?: string;
}

export interface ChatGptFunctionCallItem {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
  id?: string;
}

export type ChatGptFunctionCallOutputContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };

export type ChatGptFunctionCallOutput =
  | string
  | ChatGptFunctionCallOutputContentItem[]
  | { content: string; success?: boolean };

export interface ChatGptFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: ChatGptFunctionCallOutput;
}

export interface ChatGptCustomToolCallItem {
  type: 'custom_tool_call';
  status?: string;
  call_id: string;
  name: string;
  input: string;
  id?: string;
}

export interface ChatGptCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string;
}

export type ChatGptWebSearchAction =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export interface ChatGptWebSearchCallItem {
  type: 'web_search_call';
  status?: string;
  action: ChatGptWebSearchAction;
  id?: string;
}

export interface ChatGptGhostCommit {
  id: string;
  parent: string | null;
  preexisting_untracked_files: string[];
  preexisting_untracked_dirs: string[];
}

export interface ChatGptGhostSnapshotItem {
  type: 'ghost_snapshot';
  ghost_commit: ChatGptGhostCommit;
}

export interface ChatGptCompactionItem {
  type: 'compaction' | 'compaction_summary';
  encrypted_content: string;
}

export type ChatGptResponseItem =
  | ChatGptMessageItem
  | ChatGptReasoningItem
  | ChatGptLocalShellCallItem
  | ChatGptFunctionCallItem
  | ChatGptFunctionCallOutputItem
  | ChatGptCustomToolCallItem
  | ChatGptCustomToolCallOutputItem
  | ChatGptWebSearchCallItem
  | ChatGptGhostSnapshotItem
  | ChatGptCompactionItem;

export interface ChatGptResponsesRequest {
  model: string;
  instructions: string;
  input: ChatGptResponseItem[];
  tools: ChatGptTool[];
  tool_choice: ChatGptToolChoice;
  parallel_tool_calls: boolean;
  reasoning: ChatGptReasoning | null;
  store: boolean;
  stream: true;
  include: ChatGptInclude[];
  prompt_cache_key?: string;
  text?: ChatGptTextControls;
}

export type ChatGptResponsesPayload = ChatGptResponsesRequest;

export interface ChatGptConversationConfig {
  model: string;
  instructions: string;
  tools?: ChatGptTool[];
  parallel_tool_calls?: boolean;
  reasoning?: ChatGptReasoning | null;
  store?: boolean;
  include?: ChatGptInclude[];
  prompt_cache_key?: string;
  text?: ChatGptTextControls;
}

export type ChatGptUserInput =
  | { userText: string; userContent?: never }
  | { userContent: ChatGptContentItem[]; userText?: never };

export type ChatGptStartConversationOptions = ChatGptConversationConfig & ChatGptUserInput;

export type ChatGptContinueConversationOptions = ChatGptConversationConfig &
  ChatGptUserInput & {
    history: ChatGptResponseItem[];
  };

export function createChatGptStartRequest(
  options: ChatGptStartConversationOptions,
): ChatGptResponsesRequest {
  return buildChatGptRequest(options, [buildUserMessage(options)]);
}

export function createChatGptContinuationRequest(
  options: ChatGptContinueConversationOptions,
): ChatGptResponsesRequest {
  const nextInput = buildUserMessage(options);
  return buildChatGptRequest(options, [...options.history, nextInput]);
}

function hasUserText(
  options: ChatGptUserInput,
): options is { userText: string; userContent?: never } {
  return 'userText' in options;
}

function buildUserMessage(options: ChatGptUserInput): ChatGptMessageItem {
  const content: ChatGptContentItem[] = hasUserText(options)
    ? [{ type: 'input_text', text: options.userText }]
    : options.userContent;
  return {
    type: 'message',
    role: 'user',
    content,
  };
}

function buildChatGptRequest(
  options: ChatGptConversationConfig,
  input: ChatGptResponseItem[],
): ChatGptResponsesRequest {
  return {
    model: options.model,
    instructions: options.instructions,
    input,
    tools: options.tools ?? [],
    tool_choice: 'auto',
    parallel_tool_calls: options.parallel_tool_calls ?? false,
    reasoning: options.reasoning ?? null,
    store: options.store ?? false,
    stream: true,
    include: options.include ?? [],
    prompt_cache_key: options.prompt_cache_key,
    text: options.text,
  };
}

export interface ChatGptUsageInputTokensDetails {
  cached_tokens: number;
}

export interface ChatGptUsageOutputTokensDetails {
  reasoning_tokens: number;
}

export interface ChatGptResponseUsage {
  input_tokens: number;
  input_tokens_details?: ChatGptUsageInputTokensDetails | null;
  output_tokens: number;
  output_tokens_details?: ChatGptUsageOutputTokensDetails | null;
  total_tokens: number;
}

export interface ChatGptResponseCreated {
  id?: string;
}

export interface ChatGptResponseCompleted {
  id: string;
  usage?: ChatGptResponseUsage | null;
}

export interface ChatGptResponseError {
  type?: string;
  code?: string;
  message?: string;
  plan_type?: string;
  resets_at?: number;
}

export interface ChatGptResponseFailed {
  id?: string;
  error?: ChatGptResponseError;
}

export interface ChatGptResponseCreatedEvent {
  type: 'response.created';
  response: ChatGptResponseCreated;
}

export interface ChatGptResponseInProgressEvent {
  type: 'response.in_progress';
  response: ChatGptResponseCreated;
}

export interface ChatGptResponseCompletedEvent {
  type: 'response.completed';
  response: ChatGptResponseCompleted;
}

export interface ChatGptResponseFailedEvent {
  type: 'response.failed';
  response: ChatGptResponseFailed;
}

export interface ChatGptResponseOutputItemAddedEvent {
  type: 'response.output_item.added';
  item: ChatGptResponseItem;
}

export interface ChatGptResponseOutputItemDoneEvent {
  type: 'response.output_item.done';
  item: ChatGptResponseItem;
}

export interface ChatGptResponseOutputTextDeltaEvent {
  type: 'response.output_text.delta';
  delta: string;
}

export interface ChatGptResponseOutputTextDoneEvent {
  type: 'response.output_text.done';
  output_index: number;
  content_index: number;
  item_id: string;
  text: string;
  logprobs?: ChatGptJsonValue[];
  annotations?: ChatGptJsonValue[];
  sequence_number?: number;
}

export interface ChatGptResponseContentPartAddedEvent {
  type: 'response.content_part.added';
  output_index: number;
  content_index: number;
  item_id: string;
  part: ChatGptContentPart;
  sequence_number?: number;
}

export interface ChatGptResponseContentPartDoneEvent {
  type: 'response.content_part.done';
  output_index: number;
  content_index: number;
  item_id: string;
  part: ChatGptContentPart;
  sequence_number?: number;
}

export interface ChatGptResponseReasoningSummaryTextDeltaEvent {
  type: 'response.reasoning_summary_text.delta';
  delta: string;
  summary_index: number;
}

export interface ChatGptResponseReasoningTextDeltaEvent {
  type: 'response.reasoning_text.delta';
  delta: string;
  content_index: number;
}

export interface ChatGptResponseReasoningSummaryPartAddedEvent {
  type: 'response.reasoning_summary_part.added';
  summary_index: number;
}

export type ChatGptResponsesStreamEvent =
  | ChatGptResponseCreatedEvent
  | ChatGptResponseInProgressEvent
  | ChatGptResponseCompletedEvent
  | ChatGptResponseFailedEvent
  | ChatGptResponseOutputItemAddedEvent
  | ChatGptResponseOutputItemDoneEvent
  | ChatGptResponseOutputTextDeltaEvent
  | ChatGptResponseOutputTextDoneEvent
  | ChatGptResponseContentPartAddedEvent
  | ChatGptResponseContentPartDoneEvent
  | ChatGptResponseReasoningSummaryTextDeltaEvent
  | ChatGptResponseReasoningTextDeltaEvent
  | ChatGptResponseReasoningSummaryPartAddedEvent;

export interface ChatGptEventReceiver {
  onEvent(event: ChatGptResponsesStreamEvent): void | Promise<void>;
}

export class ChatGptTriggerError extends Error {
  readonly status: number;
  readonly body: string;
  readonly statusText: string;

  constructor(status: number, body: string, statusText: string) {
    super(`ChatGPT responses request failed (${status}): ${body || statusText || 'unknown error'}`);
    this.name = 'ChatGptTriggerError';
    this.status = status;
    this.body = body;
    this.statusText = statusText;
  }
}

export type ChatGptResponsesStreamResponse = UndiciResponse;

async function emitChatGptEvents(
  response: UndiciResponse,
  receiver: ChatGptEventReceiver,
): Promise<void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const emit = async () => {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    if (!data) {
      return;
    }
    let event: ChatGptResponsesStreamEvent;
    try {
      event = JSON.parse(data) as ChatGptResponsesStreamEvent;
    } catch {
      return;
    }
    await receiver.onEvent(event);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line === '') {
        await emit();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (done) {
      break;
    }
  }

  if (buffer.length > 0) {
    dataLines.push(buffer.trim());
  }
  await emit();
}

export class ChatGptClient {
  private readonly baseUrl: string;
  private readonly codexBaseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly dispatcher?: Dispatcher;

  constructor(credentials: ChatGptCredentials, options: ChatGptClientOptions = {}) {
    const normalizedBaseUrl = normalizeChatgptBaseUrl(options.baseUrl ?? DEFAULT_CHATGPT_BASE_URL);
    this.baseUrl = normalizedBaseUrl;
    this.codexBaseUrl = ensureCodexBaseUrl(normalizedBaseUrl);

    const originator =
      options.originator ??
      process.env[CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR] ??
      DEFAULT_ORIGINATOR;
    const userAgent =
      options.userAgent ?? buildUserAgent(originator, resolveCodexHome(options.codexHome));
    this.headers = {
      Authorization: `Bearer ${credentials.accessToken}`,
      'ChatGPT-Account-ID': credentials.accountId,
      originator,
      'User-Agent': userAgent,
    };

    this.dispatcher = resolveProxyAgent(this.baseUrl, options);
  }

  async request(path: string, init: ChatGptRequestInit = {}): Promise<UndiciResponse> {
    return this.requestAtBase(this.baseUrl, path, init);
  }

  async responses(
    payload: ChatGptResponsesRequest,
    init: ChatGptRequestInit = {},
  ): Promise<ChatGptResponsesStreamResponse> {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('accept')) {
      const stream = Boolean(payload.stream);
      headers.set('accept', stream ? 'text/event-stream' : 'application/json');
    }
    return this.requestAtBase(this.codexBaseUrl, 'responses', {
      ...init,
      method: init.method ?? 'POST',
      headers,
      json: payload,
    });
  }

  async trigger(
    payload: ChatGptResponsesRequest,
    receiver: ChatGptEventReceiver,
    init: ChatGptRequestInit = {},
  ): Promise<number> {
    const response = await this.responsesWithRetry(payload, init);
    if (!response.ok) {
      const body = await response.text();
      throw new ChatGptTriggerError(response.status, body, response.statusText);
    }
    await emitChatGptEvents(response, receiver);
    return response.status;
  }

  private async responsesWithRetry(
    payload: ChatGptResponsesRequest,
    init: ChatGptRequestInit,
  ): Promise<ChatGptResponsesStreamResponse> {
    try {
      return await this.responses(payload, init);
    } catch (err: unknown) {
      if (!isRetriableFetchError(err)) {
        throw err;
      }
      await delay(250);
      return await this.responses(payload, init);
    }
  }

  private async requestAtBase(
    baseUrl: string,
    path: string,
    init: ChatGptRequestInit,
  ): Promise<UndiciResponse> {
    const url = new URL(path, baseUrl);
    const headers = new Headers(init.headers ?? {});

    for (const [key, value] of Object.entries(this.headers)) {
      headers.set(key, value);
    }

    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }

    const { json, ...rest } = init;
    return fetch(url.toString(), {
      ...rest,
      headers,
      body,
      dispatcher: this.dispatcher,
    });
  }
}

function isRetriableFetchError(err: unknown): err is TypeError {
  if (!(err instanceof TypeError)) return false;
  return err.message.toLowerCase().includes('fetch failed');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function credentialsFromAuthState(auth: AuthState): ChatGptCredentials {
  if (auth.mode !== 'chatgpt' || !auth.tokens) {
    throw new Error('ChatGPT token data is not available.');
  }
  if (!auth.tokens.accountId) {
    throw new Error('ChatGPT account id is missing.');
  }
  return {
    accessToken: auth.tokens.accessToken,
    accountId: auth.tokens.accountId,
  };
}

export async function createChatGptClientFromManager(
  manager: AuthManager,
  options: ChatGptClientOptions = {},
): Promise<ChatGptClient> {
  const auth = await manager.auth();
  if (!auth) {
    throw new Error('Auth data is not available.');
  }
  const credentials = credentialsFromAuthState(auth);
  return new ChatGptClient(credentials, options);
}

function normalizeChatgptBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  const needsBackendApi =
    (normalized.startsWith('https://chatgpt.com') ||
      normalized.startsWith('https://chat.openai.com')) &&
    !normalized.includes('/backend-api');
  if (needsBackendApi) {
    normalized = `${normalized}/backend-api`;
  }
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function ensureCodexBaseUrl(baseUrl: string): string {
  const normalized = normalizeChatgptBaseUrl(baseUrl);
  if (normalized.includes('/codex/')) {
    return normalized;
  }
  return normalized.endsWith('/') ? `${normalized}codex/` : `${normalized}/codex/`;
}

function buildUserAgent(originator: string, codexHome: string): string {
  const version = resolveClientVersion(codexHome);
  const osType = resolveOsType();
  const osVersion = os.release();
  const arch = resolveArchitecture();
  const terminal = resolveTerminalToken();
  const candidate = `${originator}/${version} (${osType} ${osVersion}; ${arch}) ${terminal}`;
  return sanitizeHeaderValue(candidate);
}

function resolveClientVersion(codexHome: string): string {
  const version = readCodexVersionFromHome(codexHome);
  if (!version) {
    return '0.0.0';
  }
  return normalizeClientVersion(version) ?? '0.0.0';
}

function readCodexVersionFromHome(codexHome: string): string | undefined {
  try {
    const versionPath = path.join(codexHome, 'version.json');
    const raw = readFileSync(versionPath, 'utf8');
    const parsed = JSON.parse(raw) as { latest_version?: string; version?: string };
    return parsed.latest_version ?? parsed.version;
  } catch {
    return undefined;
  }
}

function normalizeClientVersion(version: string): string | undefined {
  const match = version.match(/(\\d+)\\.(\\d+)\\.(\\d+)/);
  if (!match) {
    return undefined;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function resolveOsType(): string {
  switch (os.type()) {
    case 'Darwin':
      return 'Mac OS';
    case 'Windows_NT':
      return 'Windows';
    default:
      return os.type();
  }
}

function resolveArchitecture(): string {
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    default:
      return process.arch;
  }
}

function resolveTerminalToken(): string {
  const termProgram = process.env.TERM_PROGRAM;
  if (termProgram) {
    const version = process.env.TERM_PROGRAM_VERSION;
    return version ? `${termProgram}/${version}` : termProgram;
  }
  const term = process.env.TERM;
  if (term) {
    return term;
  }
  return 'unknown';
}

function sanitizeHeaderValue(value: string): string {
  return Array.from(value)
    .map((ch) => {
      if (ch >= ' ' && ch <= '~') {
        return ch;
      }
      return '_';
    })
    .join('');
}

function getEnvProxy(upper: string, lower: string): string | undefined {
  return process.env[upper] ?? process.env[lower];
}

function shouldBypassProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) {
    return false;
  }
  const entries = noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return false;
  }
  if (entries.includes('*')) {
    return true;
  }
  return entries.some((entry) => {
    if (entry.startsWith('.')) {
      return host.endsWith(entry);
    }
    return host === entry;
  });
}

function resolveProxyAgent(baseUrl: string, options: ChatGptClientOptions): ProxyAgent | undefined {
  if (options.useEnvProxy === false) {
    return undefined;
  }

  if (options.proxyUrl) {
    return new ProxyAgent(options.proxyUrl);
  }

  const url = new URL(baseUrl);
  const host = url.hostname;
  const noProxy = getEnvProxy('NO_PROXY', 'no_proxy');
  if (shouldBypassProxy(host, noProxy)) {
    return undefined;
  }

  const httpsProxy = getEnvProxy('HTTPS_PROXY', 'https_proxy');
  const httpProxy = getEnvProxy('HTTP_PROXY', 'http_proxy');
  const proxyUrl =
    url.protocol === 'https:' ? (httpsProxy ?? httpProxy) : (httpProxy ?? httpsProxy);

  if (!proxyUrl) {
    return undefined;
  }

  return new ProxyAgent(proxyUrl);
}
