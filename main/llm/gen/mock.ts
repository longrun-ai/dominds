/**
 * Module: llm/gen/mock
 *
 * Mock LLM generator that uses a static response database for testing and development.
 *
 * === MOCK DATABASE FORMAT (YAML) ===
 *
 * ```yaml
 * responses:
 *   # Comments are supported! Explain which test step uses each entry.
 *   # E.g., # docs/e2e-story-test/basics/reminders.md: Step 1
 *   - message: "hello"
 *     role: "user"
 *     response: "Hi there!"
 *     delayMs: 200
 *     chunkDelayMs: 20
 *   - message: "error text"
 *     role: "tool"
 *     response: "corrected response"
 * ```
 *
 * === EXPLICIT ROLE-BASED MATCHING ===
 *
 * The mock looks at the last *input-like* message in context (no fallback):
 * - role='user' from prompting_msg → matches entries with role='user'
 * - role='tool' from func_result_msg / tellask_result_msg → matches entries with role='tool'
 *
 * Notes:
 * - Context tails may include reminders / transient guides; these are ignored for matching.
 *
 * Matching rules (configured entries only, NO inferred responses):
 * 1. Exact: "tool:error text" matches response with message="error text" AND role="tool"
 * 2. Exact: "user:hello" matches response with message="hello" AND role="user"
 * 3. Input matching ignores case and surrounding whitespace; known runtime wrappers/status are stripped.
 * 4. No match or invalid database: throws a fatal fixture error with repair context.
 *    Diagnostics are never emitted as assistant content or inferred tool calls.
 *
 * === BENEFITS OF YAML FORMAT ===
 *
 * - Comments: Document which test step uses each entry
 * - Easy cleanup: Identify unused entries by checking test step references
 * - Maintainability: Update comments when tests change, never lose referenced entries
 *
 * === EXAMPLE: TOOL ERROR RECOVERY ===
 *
 * // Turn 1: User asks, LLM makes syntax error
 * # docs/e2e-story-test/reminders.md: User creates reminders
 * - message: "create reminders"
 *   role: "user"
 *   response: "Call the function tool `add_reminder` with {\"content\":\"goals...\"}"
 *
 * // Turn 2: Tool error (func_result_msg with role='tool'), LLM self-corrects
 * # docs/e2e-story-test/reminders.md: Tool syntax error recovery
 * - message: "Error: Invalid args. Use: add_reminder({ content: string, scope?: \"dialog\" | \"task\" | \"agent\" }) (omitting scope means task)."
 *   role: "tool"
 *   response: "Call the function tool `add_reminder` with {\"content\":\"Goals...\",\"scope\":\"task\"}"
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import {
  ACTIVE_REPLY_TOOL_PREFIX_EN,
  ACTIVE_REPLY_TOOL_PREFIX_ZH,
  ANSWERING_REPLY_REMINDER_PREFIX_EN,
  ANSWERING_REPLY_REMINDER_PREFIX_ZH,
  NO_ACTIVE_REPLY_PREFIX_EN,
  NO_ACTIVE_REPLY_PREFIX_ZH,
  REPLY_SUPPRESSION_PREFIX_EN,
  REPLY_SUPPRESSION_PREFIX_ZH,
} from '../../runtime/reply-prompt-copy';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncCallMsg, ProviderConfig, SayingMsg } from '../client';
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
} from '../gen';
import { buildHumanSystemStopReasonTextI18n } from '../stop-reason-i18n';

interface MockResponse {
  /** The input message to match (required) */
  message: string;

  /** Expected role of input: 'user', 'tool', 'assistant' */
  role: string;

  /** Mock LLM response */
  response: string;

  /** Optional thinking content override; set response to "" to produce thinking only. */
  thinkingResponse?: string;

  /** Optional structured answer-to-human output. */
  answeringResponse?: string;

  /** Suppress the mock provider's default thinking prelude for this response. */
  omitDefaultThinking?: boolean;

  /**
   * Optional function calls emitted after saying content.
   * Useful to drive deterministic tool-round tests with the mock provider.
   */
  funcCalls?: ReadonlyArray<{
    id?: string;
    name: string;
    arguments?: unknown;
  }>;

  /**
   * Optional malformed provider/tool-call payloads surfaced through the runtime recovery path.
   */
  invalidFuncCalls?: ReadonlyArray<LlmInvalidFuncCall>;

  /**
   * Optional extra matcher: every string in this list must be present in at least
   * one context message content; otherwise this response does not match.
   */
  contextContains?: ReadonlyArray<string>;

  /** If set, throws error instead of returning response */
  streamError?: string;

  /** Emit receiver.streamError(detail) before throwing streamError. */
  emitStreamErrorBeforeThrow?: boolean;

  /**
   * When true, the mock generator reports usage as unavailable.
   * Used to validate the UI "unknown usage" path without external APIs.
   */
  usageUnavailable?: boolean;

  /**
   * When set, overrides the usage stats reported by the mock generator.
   * Used to validate context-health behavior deterministically.
   */
  usage?: {
    promptTokens: number;
    completionTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };

  /**
   * Optional response latency before generation output starts.
   * Useful for interruption and timeout tests.
   */
  delayMs?: number;

  /**
   * Optional delay between streamed saying chunks (genToReceiver only).
   * Useful for stream-ordering and interruption timing tests.
   */
  chunkDelayMs?: number;
}

interface ResponseDatabase {
  lookupMap: Map<string, MockResponse[]>;
}

class MockFixtureError extends Error {
  constructor(
    readonly code: 'mock_database_unavailable' | 'mock_database_invalid' | 'mock_response_missing',
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'MockFixtureError';
  }
}

const RUNTIME_PROMPT_WRAPPER_PREFIXES = [
  '[System notice] Context state: 🔴 critical; user interjection received',
  '【系统提示】 上下文状态：🔴 告急；收到用户插话',
  ACTIVE_REPLY_TOOL_PREFIX_EN,
  ACTIVE_REPLY_TOOL_PREFIX_ZH,
  ANSWERING_REPLY_REMINDER_PREFIX_EN,
  ANSWERING_REPLY_REMINDER_PREFIX_ZH,
  NO_ACTIVE_REPLY_PREFIX_EN,
  NO_ACTIVE_REPLY_PREFIX_ZH,
  REPLY_SUPPRESSION_PREFIX_EN,
  REPLY_SUPPRESSION_PREFIX_ZH,
] as const;

function normalizeDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

async function delayWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  const normalized = normalizeDelayMs(ms);
  if (normalized <= 0) return;
  if (abortSignal?.aborted) {
    throw new Error('AbortError');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, normalized);

    const onAbort = (): void => {
      clearTimeout(timeout);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      reject(new Error('AbortError'));
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class MockGen implements LlmGenerator {
  get apiType(): string {
    return 'mock';
  }

  classifyFailure(error: unknown): LlmFailureDisposition | undefined {
    return error instanceof MockFixtureError
      ? { kind: 'fatal', code: error.code, message: error.message }
      : undefined;
  }

  private resolveInputForMatching(context: ReadonlyArray<ChatMessage>): {
    content: string;
    role: string;
  } {
    for (let i = context.length - 1; i >= 0; i--) {
      const msg = context[i];
      if (!msg) continue;
      switch (msg.type) {
        case 'prompting_msg':
        case 'func_result_msg':
        case 'tellask_result_msg':
        case 'tellask_carryover_msg':
          return { content: msg.content, role: msg.role };
        case 'environment_msg':
        case 'transient_guide_msg':
        case 'saying_msg':
        case 'thinking_msg':
        case 'func_call_msg':
          break;
        default: {
          const _exhaustive: never = msg;
          throw new Error(`Unsupported chat message while selecting mock input: ${_exhaustive}`);
        }
      }
    }

    const lastMsg = context[context.length - 1];
    if (!lastMsg) {
      return { content: '', role: '' };
    }

    const content = (() => {
      switch (lastMsg.type) {
        case 'environment_msg':
        case 'transient_guide_msg':
        case 'prompting_msg':
        case 'saying_msg':
        case 'thinking_msg':
        case 'func_result_msg':
        case 'tellask_result_msg':
        case 'tellask_carryover_msg':
          return lastMsg.content;
        case 'func_call_msg':
          return '';
        default: {
          const _exhaustive: never = lastMsg;
          throw new Error(`Unsupported chat message while selecting mock input: ${_exhaustive}`);
        }
      }
    })();

    return { content, role: lastMsg.role };
  }

  private async loadResponseDatabase(dbPath: string, modelName: string): Promise<ResponseDatabase> {
    const dbFilePath = path.join(dbPath, `${modelName}.yaml`);
    let content: string;
    try {
      content = await fs.readFile(dbFilePath, 'utf-8');
    } catch (cause) {
      throw new MockFixtureError(
        'mock_database_unavailable',
        `Cannot read mock response database ${JSON.stringify(dbFilePath)}. Configure an accessible YAML database before running this scenario. No assistant response or tool call was generated.`,
        cause,
      );
    }
    try {
      const database: unknown = yaml.parse(content);
      if (
        !database ||
        typeof database !== 'object' ||
        !('responses' in database) ||
        !Array.isArray(database.responses)
      ) {
        throw new Error('Expected a responses array');
      }
      const lookupMap = new Map<string, MockResponse[]>();
      for (const [index, entry] of database.responses.entries()) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.message !== 'string' ||
          typeof entry.role !== 'string' ||
          entry.role.trim() === '' ||
          typeof entry.response !== 'string'
        ) {
          throw new Error(
            `responses[${index}] requires string message, non-empty role, and string response`,
          );
        }
        for (const field of ['thinkingResponse', 'answeringResponse', 'streamError'] as const) {
          if (entry[field] !== undefined && typeof entry[field] !== 'string')
            throw new Error(`responses[${index}].${field} must be a string`);
        }
        if (
          entry.contextContains !== undefined &&
          (!Array.isArray(entry.contextContains) ||
            !entry.contextContains.every((value: unknown) => typeof value === 'string'))
        ) {
          throw new Error(`responses[${index}].contextContains must be an array of strings`);
        }
        if (
          entry.funcCalls !== undefined &&
          (!Array.isArray(entry.funcCalls) ||
            !entry.funcCalls.every(
              (call: unknown) =>
                call &&
                typeof call === 'object' &&
                'name' in call &&
                typeof call.name === 'string' &&
                call.name.trim() !== '',
            ))
        ) {
          throw new Error(`responses[${index}].funcCalls requires a non-empty name for each call`);
        }
        for (const field of [
          'omitDefaultThinking',
          'emitStreamErrorBeforeThrow',
          'usageUnavailable',
        ] as const) {
          if (entry[field] !== undefined && typeof entry[field] !== 'boolean')
            throw new Error(`responses[${index}].${field} must be a boolean`);
        }
        for (const field of ['delayMs', 'chunkDelayMs'] as const) {
          if (
            entry[field] !== undefined &&
            (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]) || entry[field] < 0)
          )
            throw new Error(`responses[${index}].${field} must be a finite non-negative number`);
        }
        if (entry.usage !== undefined) {
          if (
            !entry.usage ||
            typeof entry.usage !== 'object' ||
            typeof entry.usage.promptTokens !== 'number'
          )
            throw new Error(`responses[${index}].usage requires numeric promptTokens`);
          for (const field of [
            'promptTokens',
            'completionTokens',
            'reasoningTokens',
            'totalTokens',
          ] as const) {
            const value: unknown = entry.usage[field];
            if (
              value !== undefined &&
              (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            )
              throw new Error(
                `responses[${index}].usage.${field} must be a finite non-negative number`,
              );
          }
        }
        if (
          entry.invalidFuncCalls !== undefined &&
          (!Array.isArray(entry.invalidFuncCalls) ||
            !entry.invalidFuncCalls.every(
              (call: unknown) =>
                call &&
                typeof call === 'object' &&
                'provider' in call &&
                typeof call.provider === 'string' &&
                'detail' in call &&
                typeof call.detail === 'string',
            ))
        ) {
          throw new Error(
            `responses[${index}].invalidFuncCalls must be an array of provider/detail payloads`,
          );
        }
        // Raw argument strings may intentionally contain invalid JSON for recovery scenarios.
        // Other values must serialize before any provider content is emitted.
        for (const call of entry.funcCalls ?? []) {
          if (call.id !== undefined && typeof call.id !== 'string')
            throw new Error(`responses[${index}].funcCalls.id must be a string`);
          this.normalizeFuncCallArgs(call.arguments);
        }
        const response = entry as MockResponse;
        const key = `${response.role}:${response.message.trim().toLowerCase()}`;
        const existing = lookupMap.get(key);
        if (existing) existing.push(response);
        else lookupMap.set(key, [response]);
      }
      return { lookupMap };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new MockFixtureError(
        'mock_database_invalid',
        `Invalid mock response database ${JSON.stringify(dbFilePath)}: ${detail}. Repair the fixture before running this scenario. No assistant response or tool call was generated.`,
        cause,
      );
    }
  }

  private responseMatchesContext(resp: MockResponse, context: ReadonlyArray<ChatMessage>): boolean {
    if (!resp.contextContains || resp.contextContains.length === 0) {
      return true;
    }
    const availableContents: string[] = [];
    for (const msg of context) {
      switch (msg.type) {
        case 'environment_msg':
        case 'transient_guide_msg':
        case 'prompting_msg':
        case 'saying_msg':
        case 'thinking_msg':
        case 'func_result_msg':
        case 'tellask_result_msg':
        case 'tellask_carryover_msg':
          availableContents.push(msg.content);
          break;
        case 'func_call_msg':
          break;
        default: {
          const _exhaustive: never = msg;
          throw new Error(`Unsupported chat message while matching mock context: ${_exhaustive}`);
        }
      }
    }
    return resp.contextContains.every((required) =>
      availableContents.some((content) => content.includes(required)),
    );
  }

  private normalizeFuncCallArgs(args: unknown): string {
    if (typeof args === 'string') {
      return args;
    }
    if (args === undefined) {
      return '{}';
    }
    return JSON.stringify(args);
  }

  /** Match only configured entries; never infer provider behavior from guidance. */
  private findMatchingResponse(
    database: ResponseDatabase,
    input: string,
    role: string,
    context: ReadonlyArray<ChatMessage>,
  ): MockResponse | null {
    if (!role) {
      return null;
    }

    const normalizedInputs = (() => {
      const variants = new Set<string>();
      const trimmed = input.trim();
      if (trimmed !== '') {
        variants.add(trimmed.toLowerCase());
      }
      const tellaskStatusPrefixes = [
        '\n[Dominds 诉请状态]\n',
        '\n[Dominds tellask status]\n',
        '\n[Dominds 等待人类回复]\n',
        '\n[Dominds waiting for human answer]\n',
        '\n[Dominds 等待诉请回复]\n',
        '\n[Dominds waiting for Tellask reply]\n',
        '\n[Dominds 诉请结果状态]\n',
        '\n[Dominds Tellask result status]\n',
        '\n[Dominds 人类回答结果状态]\n',
        '\n[Dominds human answer result status]\n',
      ];
      const tellaskStatusIndex = Math.max(
        ...tellaskStatusPrefixes.map((prefix) => trimmed.lastIndexOf(prefix)),
      );
      if (tellaskStatusIndex >= 0) {
        const strippedTellaskStatus = trimmed.slice(0, tellaskStatusIndex).trim();
        if (strippedTellaskStatus !== '') {
          variants.add(strippedTellaskStatus.toLowerCase());
        }
      }
      const hasRuntimeWrapper = RUNTIME_PROMPT_WRAPPER_PREFIXES.some((prefix) =>
        trimmed.startsWith(prefix),
      );
      if (!hasRuntimeWrapper) {
        return [...variants];
      }
      const separatorIndex = trimmed.indexOf('\n\n');
      if (separatorIndex < 0) {
        return [...variants];
      }
      const stripped = trimmed.slice(separatorIndex + 2).trim();
      if (stripped !== '') {
        variants.add(stripped.toLowerCase());
      }
      return [...variants];
    })();

    for (const normalizedInput of normalizedInputs) {
      const exactKey = `${role}:${normalizedInput}`;
      const candidates = database.lookupMap.get(exactKey);
      if (!candidates || candidates.length === 0) {
        continue;
      }
      for (let i = candidates.length - 1; i >= 0; i--) {
        const candidate = candidates[i];
        if (candidate && this.responseMatchesContext(candidate, context)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private missingResponseError(
    dbPath: string,
    input: string,
    role: string,
    modelName: string,
  ): MockFixtureError {
    return new MockFixtureError(
      'mock_response_missing',
      `Mock scenario has no configured response.

Input role: ${JSON.stringify(role)}
No assistant response or tool call was generated. Configure an explicit response for this input.

Database: \`${path.join(dbPath, `${modelName}.yaml`)}\`

Add to database:
\`\`\`yaml
responses:
  - message: ${JSON.stringify(input.trim())}
    role: ${JSON.stringify(role)}
    response: "Your response here"
\`\`\``,
    );
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    _funcTools: FuncTool[],
    _requestContext: LlmRequestContext,
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    _genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const dbPath = providerConfig.baseUrl;
    if (!agent.model) {
      throw new Error('Model undefined for agent: ' + agent.id);
    }

    const modelName = agent.model;
    const { content, role } = this.resolveInputForMatching(context);

    if (abortSignal?.aborted) {
      throw new Error('AbortError');
    }

    const db = await this.loadResponseDatabase(dbPath, modelName);
    const matched = this.findMatchingResponse(db, content, role, context);
    if (!matched) throw this.missingResponseError(dbPath, content, role, modelName);
    await delayWithAbort(matched?.delayMs ?? 0, abortSignal);

    const thinkingText =
      matched?.omitDefaultThinking === true
        ? (matched.thinkingResponse ?? '')
        : (matched?.thinkingResponse ?? `[${modelName}] ${content.substring(0, 50) || '(empty)'}`);
    if (thinkingText !== '') {
      await receiver.thinkingStart();
      await receiver.thinkingChunk(thinkingText);
      await receiver.thinkingFinish();
    }

    if (matched?.streamError) {
      if (matched.emitStreamErrorBeforeThrow && receiver.streamError) {
        await receiver.streamError(matched.streamError);
        throw new LlmStreamErrorEmittedError({
          detail: matched.streamError,
          i18nStopReason: buildHumanSystemStopReasonTextI18n({
            detail: matched.streamError,
            fallbackKind: 'request_failed',
          }),
        });
      }
      throw new Error(matched.streamError);
    }

    const responseText = matched.response;

    let usage: LlmUsageStats = { kind: 'unavailable' };
    if (matched && matched.usageUnavailable === true) {
      usage = { kind: 'unavailable' };
    } else if (matched && matched.usage) {
      const promptTokens = matched.usage.promptTokens;
      const completionTokens =
        typeof matched.usage.completionTokens === 'number' ? matched.usage.completionTokens : 0;
      const reasoningTokens =
        typeof matched.usage.reasoningTokens === 'number'
          ? matched.usage.reasoningTokens
          : undefined;
      const totalTokens =
        typeof matched.usage.totalTokens === 'number'
          ? matched.usage.totalTokens
          : promptTokens + completionTokens;
      usage = {
        kind: 'available',
        promptTokens,
        completionTokens,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        totalTokens,
      };
    } else {
      const promptChars =
        systemPrompt.length +
        context.reduce((acc, msg) => {
          switch (msg.type) {
            case 'environment_msg':
            case 'transient_guide_msg':
            case 'prompting_msg':
            case 'saying_msg':
            case 'thinking_msg':
            case 'func_result_msg':
            case 'tellask_result_msg':
            case 'tellask_carryover_msg':
              return acc + msg.content.length;
            case 'func_call_msg':
              return acc + msg.name.length + msg.arguments.length;
            default: {
              const _exhaustive: never = msg;
              throw new Error(`Unsupported chat message: ${_exhaustive}`);
            }
          }
        }, 0);
      const promptTokens = Math.ceil(promptChars / 4);
      const completionTokens = Math.ceil(responseText.length / 4);
      usage = {
        kind: 'available',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    }

    if (responseText !== '') {
      await receiver.sayingStart();
      const chunkDelayMs = normalizeDelayMs(matched?.chunkDelayMs ?? 0);
      const words = responseText.split(/(\s+)/);
      for (const word of words) {
        if (abortSignal?.aborted) {
          throw new Error('AbortError');
        }
        await receiver.sayingChunk(word);
        if (chunkDelayMs > 0) {
          await delayWithAbort(chunkDelayMs, abortSignal);
        }
      }
      await receiver.sayingFinish();
    }

    if (matched?.answeringResponse !== undefined && matched.answeringResponse.trim() !== '') {
      await receiver.answering?.(matched.answeringResponse);
    }

    const funcCalls = matched?.funcCalls ?? [];
    for (let i = 0; i < funcCalls.length; i++) {
      const call = funcCalls[i];
      if (!call || typeof call.name !== 'string' || call.name.trim() === '') {
        throw new Error(`Invalid mock funcCalls[${String(i)}].name`);
      }
      const callId =
        typeof call.id === 'string' && call.id.trim() !== ''
          ? call.id
          : `mock_func_${String(i + 1)}_${call.name}`;
      await receiver.funcCall(callId, call.name, this.normalizeFuncCallArgs(call.arguments));
    }
    const invalidFuncCalls = matched?.invalidFuncCalls ?? [];
    for (const call of invalidFuncCalls) {
      await receiver.invalidFuncCall?.(call);
    }

    return { usage, llmGenModel: modelName };
  }

  async genMoreMessages(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    _funcTools: FuncTool[],
    _requestContext: LlmRequestContext,
    context: ChatMessage[],
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmBatchResult> {
    if (abortSignal?.aborted) {
      throw new Error('AbortError');
    }
    const dbPath = providerConfig.baseUrl;
    if (!agent.model) {
      throw new Error('Model undefined for agent: ' + agent.id);
    }

    const modelName = agent.model;
    const { content, role } = this.resolveInputForMatching(context);

    const db = await this.loadResponseDatabase(dbPath, modelName);
    const matched = this.findMatchingResponse(db, content, role, context);
    if (!matched) throw this.missingResponseError(dbPath, content, role, modelName);
    await delayWithAbort(matched?.delayMs ?? 0, abortSignal);

    if (matched.streamError) throw new Error(matched.streamError);
    const responseText = matched.response;

    const thinkingText =
      matched?.omitDefaultThinking === true
        ? (matched.thinkingResponse ?? '')
        : (matched?.thinkingResponse ?? `[${modelName}] ${content.substring(0, 100)}`);
    const thinking: ChatMessage | undefined =
      thinkingText === ''
        ? undefined
        : {
            type: 'thinking_msg',
            role: 'assistant',
            genseq,
            content: thinkingText,
          };

    const saying: SayingMsg | undefined =
      responseText !== ''
        ? {
            type: 'saying_msg',
            role: 'assistant',
            genseq,
            content: responseText,
          }
        : undefined;

    let usage: LlmUsageStats = { kind: 'unavailable' };
    if (matched && matched.usageUnavailable === true) {
      usage = { kind: 'unavailable' };
    } else if (matched && matched.usage) {
      const promptTokens = matched.usage.promptTokens;
      const completionTokens =
        typeof matched.usage.completionTokens === 'number' ? matched.usage.completionTokens : 0;
      const reasoningTokens =
        typeof matched.usage.reasoningTokens === 'number'
          ? matched.usage.reasoningTokens
          : undefined;
      const totalTokens =
        typeof matched.usage.totalTokens === 'number'
          ? matched.usage.totalTokens
          : promptTokens + completionTokens;
      usage = {
        kind: 'available',
        promptTokens,
        completionTokens,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        totalTokens,
      };
    } else {
      const promptChars =
        systemPrompt.length +
        context.reduce((acc, msg) => {
          switch (msg.type) {
            case 'environment_msg':
            case 'transient_guide_msg':
            case 'prompting_msg':
            case 'saying_msg':
            case 'thinking_msg':
            case 'func_result_msg':
            case 'tellask_result_msg':
            case 'tellask_carryover_msg':
              return acc + msg.content.length;
            case 'func_call_msg':
              return acc + msg.name.length + msg.arguments.length;
            default: {
              const _exhaustive: never = msg;
              throw new Error(`Unsupported chat message: ${_exhaustive}`);
            }
          }
        }, 0);
      const promptTokens = Math.ceil(promptChars / 4);
      const completionTokens = Math.ceil(responseText.length / 4);
      usage = {
        kind: 'available',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    }

    const funcMsgs: FuncCallMsg[] =
      matched?.funcCalls?.map((call, idx) => {
        if (!call || typeof call.name !== 'string' || call.name.trim() === '') {
          throw new Error(`Invalid mock funcCalls[${String(idx)}].name`);
        }
        return {
          type: 'func_call_msg',
          role: 'assistant',
          genseq,
          id:
            typeof call.id === 'string' && call.id.trim() !== ''
              ? call.id
              : `mock_func_${String(idx + 1)}_${call.name}`,
          name: call.name,
          arguments: this.normalizeFuncCallArgs(call.arguments),
        };
      }) ?? [];
    const invalidFuncCalls = matched?.invalidFuncCalls ?? [];
    const invalidFuncCallOutputs: LlmBatchOutput[] = invalidFuncCalls.map((call) => ({
      kind: 'invalid_func_call',
      call,
    }));
    const answeringOutputs: LlmBatchOutput[] =
      matched?.answeringResponse !== undefined && matched.answeringResponse.trim() !== ''
        ? [{ kind: 'answering', content: matched.answeringResponse }]
        : [];
    const messages =
      thinking !== undefined
        ? saying
          ? [thinking, saying, ...funcMsgs]
          : [thinking, ...funcMsgs]
        : saying
          ? [saying, ...funcMsgs]
          : [...funcMsgs];

    return {
      messages,
      ...(invalidFuncCallOutputs.length > 0 || answeringOutputs.length > 0
        ? {
            outputs: [
              ...messages.map((message): LlmBatchOutput => ({ kind: 'message', message })),
              ...answeringOutputs,
              ...invalidFuncCallOutputs,
            ],
          }
        : {}),
      usage,
      llmGenModel: modelName,
    };
  }
}
