#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Response as UndiciResponse } from 'undici';
import {
  AuthDotJson,
  DEFAULT_CHATGPT_BASE_URL,
  TOKEN_REFRESH_INTERVAL_DAYS,
} from '../auth/schema.js';
import {
  authFilePath,
  readAuthFile,
  resolveCodexHome,
  updateStoredTokens,
} from '../auth/storage.js';
import {
  ChatGptClient,
  ChatGptEventReceiver,
  ChatGptTriggerError,
  createChatGptStartRequest,
  type ChatGptResponsesRequest,
  type ChatGptResponsesStreamEvent,
} from '../llm/chatgpt.js';
import { loadCodexPromptSync } from '../prompts.js';
import { tryRefreshToken } from '../oauth/refresh.js';
import { parseIdToken } from '../oauth/tokenParsing.js';

interface DoctorOptions {
  codexHome?: string;
  refresh: boolean;
  json: boolean;
  verify: boolean;
  verbose: boolean;
  probeReasoning: boolean;
  model?: string;
  chatgptBaseUrl?: string;
  chatgptModel?: string;
}

function parseArgs(argv: string[]): DoctorOptions {
  const options: DoctorOptions = {
    refresh: false,
    json: false,
    verify: true,
    verbose: false,
    probeReasoning: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--refresh') {
      options.refresh = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--verify') {
      options.verify = true;
      continue;
    }
    if (arg === '--no-verify') {
      options.verify = false;
      continue;
    }
    if (arg === '--verbose' || arg === '-verbose' || arg === '-v') {
      options.verbose = true;
      continue;
    }
    if (arg === '--probe-reasoning' || arg === '--probe-thinking') {
      options.probeReasoning = true;
      continue;
    }
    if (arg === '--no-probe-reasoning' || arg === '--no-probe-thinking') {
      options.probeReasoning = false;
      continue;
    }
    if (arg === '--model') {
      options.model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--base-url') {
      options.chatgptBaseUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--chatgpt-base-url') {
      options.chatgptBaseUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--chatgpt-model') {
      options.chatgptModel = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--codex-home') {
      options.codexHome = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    console.error(`Unknown argument: ${arg}`);
    printHelp();
    process.exit(2);
  }

  return options;
}

function printHelp(): void {
  console.log(`codex-auth doctor

Usage:
  codex-auth [--codex-home PATH] [--refresh] [--json] [--no-verify] [--verbose] [--probe-reasoning]

Options:
  --codex-home PATH   Override CODEX_HOME
  --refresh           Refresh ChatGPT tokens if possible
  --json              Emit JSON output
  --verbose           Dump SSE events as pretty-printed JSON (aliases: -v, -verbose)
  --probe-reasoning   Extra probe request enabling reasoning + include to check whether the
                      backend streams response.reasoning_* events (aliases: --probe-thinking)
  --model NAME        Override ChatGPT verification model (alias for --chatgpt-model)
  --base-url URL      Alias for --chatgpt-base-url
  --chatgpt-base-url URL  Override ChatGPT base URL
  --chatgpt-model NAME    Override ChatGPT model used for the chat probe
  --no-verify         Skip the LLM verification request
  -h, --help          Show this help
`);
}

function isStale(lastRefresh: Date | undefined): boolean | undefined {
  if (!lastRefresh) {
    return undefined;
  }
  const cutoff = Date.now() - TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  return lastRefresh.getTime() < cutoff;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

interface VerifyResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  error?: string;
  responseId?: string;
  models?: string[];
}

type EventCountByType = Partial<Record<ChatGptResponsesStreamEvent['type'], number>>;

interface StreamProbeResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  error?: string;
  x_reasoning_included?: boolean | null;
  reasoning_tokens?: number | null;
  saw_output_text_delta?: boolean;
  saw_reasoning_summary_text_delta?: boolean;
  saw_reasoning_text_delta?: boolean;
  saw_reasoning_summary_part_added?: boolean;
  saw_reasoning_item?: boolean;
  saw_any_reasoning_event?: boolean;
  event_counts?: EventCountByType;
}

function buildReport(codexHome: string, auth: AuthDotJson | null) {
  const report: Record<string, unknown> = {
    codex_home: codexHome,
    auth_file: authFilePath(codexHome),
    auth_present: Boolean(auth),
    proxy: proxyReport(),
  };

  if (!auth) {
    return report;
  }

  report.auth_mode = auth.OPENAI_API_KEY ? 'api_key' : 'chatgpt';
  report.has_api_key = Boolean(auth.OPENAI_API_KEY);

  if (auth.tokens) {
    report.has_tokens = true;
    report.has_access_token = Boolean(auth.tokens.access_token);
    report.has_refresh_token = Boolean(auth.tokens.refresh_token);
    report.account_id = auth.tokens.account_id;

    try {
      const info = parseIdToken(auth.tokens.id_token);
      report.id_token_email = info.email;
      report.id_token_plan = info.chatgpt_plan_type;
      report.id_token_account_id = info.chatgpt_account_id;
    } catch (error) {
      report.id_token_error = error instanceof Error ? error.message : String(error);
    }
  } else {
    report.has_tokens = false;
  }

  const lastRefresh = parseDate(auth.last_refresh);
  report.last_refresh = lastRefresh ? lastRefresh.toISOString() : undefined;
  report.tokens_stale = isStale(lastRefresh);

  return report;
}

let configModelOverride: string | undefined;

function readConfigModel(codexHome: string): string | undefined {
  try {
    const configPath = path.join(codexHome, 'config.toml');
    const raw = readFileSync(configPath, 'utf8');
    return extractModelFromToml(raw);
  } catch {
    return undefined;
  }
}

function extractModelFromToml(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^model\s*=\s*["']([^"']+)["']/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function resolveLocalInstructions(model: string): string | undefined {
  return loadCodexPromptSync(model) ?? undefined;
}

function summarizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return 'empty response body';
  }
  if (trimmed.length <= 400) {
    return trimmed;
  }
  return `${trimmed.slice(0, 400)}...`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message || error.name || 'Unknown error';
    const details = describeErrorDetails(error);
    if (details) {
      return `${message} (${details})`;
    }
    return message;
  }
  return String(error);
}

function describeErrorDetails(error: Error): string | undefined {
  const parts: string[] = [];
  const errorDetails = formatErrnoDetails(error);
  if (errorDetails) {
    parts.push(errorDetails);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause) {
    parts.push(`cause: ${describeCause(cause)}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const message = cause.message || cause.name || 'Unknown error';
    const details = formatErrnoDetails(cause);
    return details ? `${message} (${details})` : message;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  if (cause && typeof cause === 'object') {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
}

function formatErrnoDetails(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.code === 'string') {
    parts.push(`code=${record.code}`);
  }
  if (typeof record.errno === 'string' || typeof record.errno === 'number') {
    parts.push(`errno=${record.errno}`);
  }
  if (typeof record.syscall === 'string') {
    parts.push(`syscall=${record.syscall}`);
  }
  if (typeof record.address === 'string') {
    parts.push(`address=${record.address}`);
  }
  if (typeof record.port === 'number') {
    parts.push(`port=${record.port}`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

async function refreshTokensIfRequested(
  options: DoctorOptions,
  codexHome: string,
  auth: AuthDotJson | null,
): Promise<void> {
  if (!options.refresh) {
    return;
  }
  if (!auth || !auth.tokens?.refresh_token) {
    throw new Error('No refresh token available to refresh.');
  }

  const refreshed = await tryRefreshToken(auth.tokens.refresh_token);
  updateStoredTokens(
    codexHome,
    {
      idToken: refreshed.id_token ?? null,
      accessToken: refreshed.access_token ?? null,
      refreshToken: refreshed.refresh_token ?? null,
    },
    'file',
  );
}

function proxyReport(): Record<string, string | undefined> {
  return {
    http_proxy: getEnvProxy('HTTP_PROXY', 'http_proxy'),
    https_proxy: getEnvProxy('HTTPS_PROXY', 'https_proxy'),
    no_proxy: getEnvProxy('NO_PROXY', 'no_proxy'),
  };
}

function getEnvProxy(upper: string, lower: string): string | undefined {
  return process.env[upper] ?? process.env[lower];
}

function formatChatGptEventTag(event: ChatGptResponsesStreamEvent): string {
  switch (event.type) {
    case 'response.created':
      return `response.created id=${event.response.id ?? ''}`.trim();
    case 'response.in_progress':
      return `response.in_progress id=${event.response.id ?? ''}`.trim();
    case 'response.completed':
      return `response.completed id=${event.response.id}`.trim();
    case 'response.failed':
      return `response.failed ${event.response.error?.message ?? ''}`.trim();
    case 'response.output_item.added':
    case 'response.output_item.done':
      return `${event.type} item=${event.item.type}`.trim();
    case 'response.output_text.delta':
      return `response.output_text.delta ${event.delta}`.trim();
    case 'response.output_text.done':
      return `response.output_text.done item=${event.item_id} out=${event.output_index} idx=${event.content_index}`.trim();
    case 'response.content_part.added':
    case 'response.content_part.done':
      return `${event.type} item=${event.item_id} out=${event.output_index} idx=${event.content_index} part=${event.part.type}`.trim();
    case 'response.reasoning_summary_text.delta':
      return `response.reasoning_summary_text.delta idx=${event.summary_index} ${event.delta}`.trim();
    case 'response.reasoning_text.delta':
      return `response.reasoning_text.delta idx=${event.content_index} ${event.delta}`.trim();
    case 'response.reasoning_summary_part.added':
      return `response.reasoning_summary_part.added idx=${event.summary_index}`.trim();
  }

  const _exhaustive: never = event;
  throw new Error(`Unhandled ChatGPT event: ${JSON.stringify(_exhaustive)}`);
}

function logChatGptEvent(event: ChatGptResponsesStreamEvent): void {
  const tag = formatChatGptEventTag(event);
  console.log(`[sse] ${tag}`.trim());
  console.log(JSON.stringify(event, null, 2));
}

function incrementCount(counts: EventCountByType, eventType: ChatGptResponsesStreamEvent['type']) {
  const previous = counts[eventType] ?? 0;
  counts[eventType] = previous + 1;
}

function parseTruthyHeader(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return null;
}

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

function selectChatGptModel(
  options: DoctorOptions,
): { model: string; instructions: string } | undefined {
  const override =
    options.chatgptModel ??
    options.model ??
    process.env.CODEX_AUTH_DOCTOR_CHATGPT_MODEL ??
    configModelOverride ??
    undefined;
  if (override) {
    const localInstructions = resolveLocalInstructions(override);
    return {
      model: override,
      instructions: localInstructions ?? 'You are Codex CLI.',
    };
  }

  const fallbackModels = ['gpt-5.2-codex', 'gpt-5.2'];
  for (const model of fallbackModels) {
    const instructions = resolveLocalInstructions(model);
    if (instructions) {
      return { model, instructions };
    }
  }

  return {
    model: 'gpt-5.2-codex',
    instructions: 'You are Codex CLI.',
  };
}

async function verifyChatGptConversation(
  options: DoctorOptions,
  codexHome: string,
  auth: AuthDotJson | null,
  selection: { model: string; instructions: string } | undefined,
): Promise<VerifyResult> {
  if (!options.verify) {
    return { ok: false, skipped: true };
  }
  if (!auth) {
    return { ok: false, error: 'auth.json missing' };
  }
  if (!selection) {
    return { ok: false, skipped: true };
  }

  const accessToken = auth.tokens?.access_token;
  const accountId = getAccountId(auth);
  if (!accessToken) {
    return { ok: false, error: 'chatgpt access token missing' };
  }
  if (!accountId) {
    return { ok: false, error: 'chatgpt account id missing' };
  }

  const baseUrl =
    options.chatgptBaseUrl ??
    process.env.CODEX_AUTH_DOCTOR_CHATGPT_BASE_URL ??
    DEFAULT_CHATGPT_BASE_URL;
  const model = selection.model;
  const instructions = selection.instructions;
  const conversationId = randomUUID();
  const client = new ChatGptClient(
    { accessToken, accountId },
    {
      baseUrl,
      codexHome,
    },
  );
  const req: ChatGptResponsesRequest = createChatGptStartRequest({
    model,
    instructions,
    userText: 'hello',
    prompt_cache_key: conversationId,
  });
  const receiver: ChatGptEventReceiver =
    options.verbose && !options.json ? { onEvent: logChatGptEvent } : { onEvent: () => {} };

  try {
    const status = await client.trigger(req, receiver, {
      headers: {
        conversation_id: conversationId,
        session_id: conversationId,
      },
    });
    return { ok: true, status };
  } catch (error) {
    if (error instanceof ChatGptTriggerError) {
      const body = error.body || error.statusText;
      return { ok: false, status: error.status, error: summarizeErrorBody(body) };
    }
    return { ok: false, error: describeError(error) };
  }
}

async function probeChatGptReasoningStream(
  options: DoctorOptions,
  codexHome: string,
  auth: AuthDotJson | null,
  selection: { model: string; instructions: string } | undefined,
): Promise<StreamProbeResult> {
  if (!options.verify || !options.probeReasoning) {
    return { ok: false, skipped: true };
  }
  if (!auth) {
    return { ok: false, error: 'auth.json missing' };
  }
  if (!selection) {
    return { ok: false, skipped: true };
  }

  const accessToken = auth.tokens?.access_token;
  const accountId = getAccountId(auth);
  if (!accessToken) {
    return { ok: false, error: 'chatgpt access token missing' };
  }
  if (!accountId) {
    return { ok: false, error: 'chatgpt account id missing' };
  }

  const baseUrl =
    options.chatgptBaseUrl ??
    process.env.CODEX_AUTH_DOCTOR_CHATGPT_BASE_URL ??
    DEFAULT_CHATGPT_BASE_URL;
  const model = selection.model;
  const instructions = selection.instructions;
  const conversationId = randomUUID();
  const client = new ChatGptClient(
    { accessToken, accountId },
    {
      baseUrl,
      codexHome,
    },
  );

  const req: ChatGptResponsesRequest = createChatGptStartRequest({
    model,
    instructions,
    // This probe is specifically for diagnosing whether "thinking" / reasoning events stream.
    // We request a reasoning summary and include encrypted reasoning (Codex Rust does this when
    // reasoning is enabled).
    reasoning: { effort: 'high', summary: 'detailed' },
    include: ['reasoning.encrypted_content'],
    userText:
      'Puzzle: I have a two-digit number. The sum of its digits is 9. Reversing the digits increases the number by 27. What is the number? Output only the number.',
    prompt_cache_key: conversationId,
  });

  const eventCounts: EventCountByType = {};
  let sawOutputTextDelta = false;
  let sawReasoningSummaryTextDelta = false;
  let sawReasoningTextDelta = false;
  let sawReasoningSummaryPartAdded = false;
  let sawReasoningItem = false;
  let reasoningTokens: number | null = null;

  const receiver: ChatGptEventReceiver = {
    onEvent: async (event: ChatGptResponsesStreamEvent) => {
      incrementCount(eventCounts, event.type);

      switch (event.type) {
        case 'response.completed': {
          const usage = event.response.usage;
          const details = usage?.output_tokens_details;
          if (details && typeof details.reasoning_tokens === 'number') {
            reasoningTokens = details.reasoning_tokens;
          }
          break;
        }
        case 'response.output_text.delta':
          if (event.delta.length > 0) {
            sawOutputTextDelta = true;
          }
          break;
        case 'response.reasoning_summary_text.delta':
          if (event.delta.length > 0) {
            sawReasoningSummaryTextDelta = true;
          }
          break;
        case 'response.reasoning_text.delta':
          if (event.delta.length > 0) {
            sawReasoningTextDelta = true;
          }
          break;
        case 'response.reasoning_summary_part.added':
          sawReasoningSummaryPartAdded = true;
          break;
        case 'response.output_item.added':
        case 'response.output_item.done':
          if (event.item.type === 'reasoning') {
            sawReasoningItem = true;
          }
          break;
        default:
          break;
      }

      if (options.verbose && !options.json) {
        logChatGptEvent(event);
      }
    },
  };

  try {
    const response = await client.responses(req, {
      headers: {
        conversation_id: conversationId,
        session_id: conversationId,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: summarizeErrorBody(body || response.statusText),
      };
    }

    const xReasoningIncluded = parseTruthyHeader(response.headers.get('x-reasoning-included'));
    await emitChatGptEvents(response, receiver);

    const sawAnyReasoningEvent =
      sawReasoningSummaryTextDelta ||
      sawReasoningTextDelta ||
      sawReasoningSummaryPartAdded ||
      sawReasoningItem;

    return {
      ok: true,
      status: response.status,
      x_reasoning_included: xReasoningIncluded,
      reasoning_tokens: reasoningTokens,
      saw_output_text_delta: sawOutputTextDelta,
      saw_reasoning_summary_text_delta: sawReasoningSummaryTextDelta,
      saw_reasoning_text_delta: sawReasoningTextDelta,
      saw_reasoning_summary_part_added: sawReasoningSummaryPartAdded,
      saw_reasoning_item: sawReasoningItem,
      saw_any_reasoning_event: sawAnyReasoningEvent,
      event_counts: eventCounts,
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function getAccountId(auth: AuthDotJson): string | undefined {
  if (auth.tokens?.account_id) {
    return auth.tokens.account_id;
  }
  if (auth.tokens?.id_token) {
    try {
      return parseIdToken(auth.tokens.id_token).chatgpt_account_id;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const codexHome = resolveCodexHome(options.codexHome);
  configModelOverride = readConfigModel(codexHome);

  let auth: AuthDotJson | null = null;
  try {
    auth = readAuthFile(codexHome, 'file');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read auth file: ${message}`);
    process.exit(1);
  }

  try {
    await refreshTokensIfRequested(options, codexHome, auth);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Refresh failed: ${message}`);
    process.exit(1);
  }

  if (options.refresh) {
    auth = readAuthFile(codexHome, 'file');
  }

  const report = buildReport(codexHome, auth);
  let chatgptVerify: VerifyResult | undefined;
  let chatgptReasoningProbe: StreamProbeResult | undefined;
  try {
    const selection = selectChatGptModel(options);
    chatgptVerify = await verifyChatGptConversation(options, codexHome, auth, selection);
    chatgptReasoningProbe = await probeChatGptReasoningStream(options, codexHome, auth, selection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    chatgptVerify = { ok: false, error: message };
  }
  report.chatgpt_verify = chatgptVerify;
  report.chatgpt_reasoning_probe = chatgptReasoningProbe;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Codex Auth Doctor');
  console.log(`- CODEX_HOME: ${report.codex_home}`);
  console.log(`- auth.json: ${report.auth_file}`);
  console.log(`- auth present: ${report.auth_present ? 'yes' : 'no'}`);
  const proxy = report.proxy as Record<string, string | undefined> | undefined;
  if (proxy) {
    const httpProxy = proxy.http_proxy ?? 'unset';
    const httpsProxy = proxy.https_proxy ?? 'unset';
    const noProxy = proxy.no_proxy ?? 'unset';
    console.log(`- http_proxy: ${httpProxy}`);
    console.log(`- https_proxy: ${httpsProxy}`);
    console.log(`- no_proxy: ${noProxy}`);
  }

  if (!auth) {
    console.log('- status: no auth file found');
    return;
  }

  console.log(`- auth mode: ${report.auth_mode}`);
  console.log(`- api key present: ${report.has_api_key ? 'yes' : 'no'}`);

  if (report.has_tokens) {
    console.log(`- access token present: ${report.has_access_token ? 'yes' : 'no'}`);
    console.log(`- refresh token present: ${report.has_refresh_token ? 'yes' : 'no'}`);
    if (report.id_token_error) {
      console.log(`- id_token parse error: ${report.id_token_error}`);
    } else {
      if (report.id_token_email) {
        console.log(`- id_token email: ${report.id_token_email}`);
      }
      if (report.id_token_plan) {
        console.log(`- id_token plan: ${report.id_token_plan}`);
      }
      if (report.id_token_account_id) {
        console.log(`- id_token account id: ${report.id_token_account_id}`);
      }
    }
  }

  if (report.last_refresh) {
    console.log(`- last refresh: ${report.last_refresh}`);
  } else {
    console.log('- last refresh: unknown');
  }

  if (typeof report.tokens_stale === 'boolean') {
    console.log(`- tokens stale: ${report.tokens_stale ? 'yes' : 'no'}`);
  }

  if (chatgptVerify) {
    if (chatgptVerify.skipped) {
      console.log('- chatgpt verify: skipped');
    } else if (chatgptVerify.ok) {
      console.log('- chatgpt verify: success');
    } else {
      console.log('- chatgpt verify: failed');
      if (chatgptVerify.status) {
        console.log(`- chatgpt status: ${chatgptVerify.status}`);
      }
      if (chatgptVerify.error) {
        console.log(`- chatgpt error: ${chatgptVerify.error}`);
      }
    }
  }

  if (chatgptReasoningProbe) {
    if (chatgptReasoningProbe.skipped) {
      console.log('- chatgpt reasoning probe: skipped');
    } else if (chatgptReasoningProbe.ok) {
      console.log('- chatgpt reasoning probe: success');
      if (chatgptReasoningProbe.x_reasoning_included !== null) {
        console.log(
          `- x-reasoning-included: ${chatgptReasoningProbe.x_reasoning_included ? 'true' : 'false'}`,
        );
      } else {
        console.log('- x-reasoning-included: unset/unknown');
      }
      if (typeof chatgptReasoningProbe.reasoning_tokens === 'number') {
        console.log(`- reasoning tokens: ${chatgptReasoningProbe.reasoning_tokens}`);
      }
      console.log(
        `- saw reasoning events: ${chatgptReasoningProbe.saw_any_reasoning_event ? 'yes' : 'no'}`,
      );
      if (!chatgptReasoningProbe.saw_any_reasoning_event) {
        console.log(
          '- hint: reasoning events require `reasoning` + (usually) `include: ["reasoning.encrypted_content"]`; model/account may also disable them.',
        );
      }
    } else {
      console.log('- chatgpt reasoning probe: failed');
      if (chatgptReasoningProbe.status) {
        console.log(`- chatgpt status: ${chatgptReasoningProbe.status}`);
      }
      if (chatgptReasoningProbe.error) {
        console.log(`- chatgpt error: ${chatgptReasoningProbe.error}`);
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`auth doctor failed: ${message}`);
  process.exit(1);
});
