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
 * === ROLE-BASED MATCHING (EXACT ONLY) ===
 *
 * The mock looks at the EXACT last message in context (no fallback):
 * - role='user' from prompting_msg → matches entries with role='user'
 * - role='tool' from func_result_msg → matches entries with role='tool'
 *
 * Matching rules (strict exact matching, NO fallback):
 * 1. Exact: "tool:error text" matches response with message="error text" AND role="tool"
 * 2. Exact: "user:hello" matches response with message="hello" AND role="user"
 * 3. No match: returns fallback response explaining how to add mocks
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
 * - message: "Error: Invalid args. Use: add_reminder({ content: string, position: number }) (position=0 means append)."
 *   role: "tool"
 *   response: "Call the function tool `add_reminder` with {\"content\":\"Goals...\",\"position\":1}"
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

import { log } from '../../log';
import type { LlmUsageStats } from '../../shared/types/context-health';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, ProviderConfig, SayingMsg } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';

interface MockResponse {
  /** The input message to match (required) */
  message: string;

  /** Expected role of input: 'user', 'tool', 'assistant' */
  role?: string;

  /** Mock LLM response */
  response: string;

  /** If set, throws error instead of returning response */
  streamError?: string;

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

interface MockDatabase {
  responses: MockResponse[];
}

interface CachedDatabase {
  filePath: string;
  lastModified: number;
  /** Key format: "role:message" for exact matching only (no fallback) */
  lookupMap: Map<string, MockResponse>;
}

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

  private databaseCache = new Map<string, CachedDatabase>();

  private async loadResponseDatabase(dbPath: string, modelName: string): Promise<CachedDatabase> {
    const cacheKey = `${dbPath}:${modelName}`;
    const dbFilePath = path.join(dbPath, `${modelName}.yaml`);

    const cached = this.databaseCache.get(cacheKey);
    if (cached) {
      try {
        const stats = await fs.stat(dbFilePath);
        if (stats.mtimeMs === cached.lastModified) {
          return cached;
        }
      } catch {
        // Continue to reload
      }
    }

    try {
      const content = await fs.readFile(dbFilePath, 'utf-8');
      const rawDatabase = yaml.parse(content) as MockDatabase;

      // EXACT MATCHING ONLY: Store entries with role prefix
      // No fallback to message-only entries
      const lookupMap = new Map<string, MockResponse>();
      for (const resp of rawDatabase.responses) {
        if (typeof resp.message !== 'string') {
          throw new Error('message is required for mock response matching');
        }
        if (!resp.role) {
          log.warn(`⚠️  Mock response without role: "${resp.message.substring(0, 50)}..."`);
          log.warn('💡 All mock responses should have a "role" field (e.g., "user" or "tool")');
        }
        const key = resp.role
          ? `${resp.role}:${resp.message.trim().toLowerCase()}`
          : resp.message.trim().toLowerCase();
        lookupMap.set(key, resp);
      }

      const stats = await fs.stat(dbFilePath);
      const cachedDb: CachedDatabase = {
        filePath: dbFilePath,
        lastModified: stats.mtimeMs,
        lookupMap,
      };

      this.databaseCache.set(cacheKey, cachedDb);
      return cachedDb;
    } catch {
      log.warn(`⚠️  Mock database not found: ${dbFilePath}`);
      log.warn(
        '💡 Create the file with: responses: [{ message: "...", role: "...", response: "..." }]',
      );

      const emptyDb: CachedDatabase = {
        filePath: dbFilePath,
        lastModified: Date.now(),
        lookupMap: new Map(),
      };
      this.databaseCache.set(cacheKey, emptyDb);
      return emptyDb;
    }
  }

  /**
   * Find matching response using EXACT last message only.
   * NO fallback to message-only matching - if exact match fails, return null.
   */
  private findMatchingResponse(
    database: CachedDatabase,
    input: string,
    role: string,
  ): MockResponse | null {
    if (!role) {
      throw new Error('role is required for mock response matching');
    }

    const normalizedInput = input.trim().toLowerCase();
    const lookupMap = database.lookupMap;

    // Exact match only: "role:message"
    const exactKey = `${role}:${normalizedInput}`;
    return lookupMap.get(exactKey) || null;
  }

  private makeFallbackResponse(
    dbPath: string,
    input: string,
    role: string,
    modelName: string,
  ): string {
    return `🤖 **Mock Response Not Found**

No mock response for the specified message with role=${JSON.stringify(role)} !!

Database: \`${path.join(dbPath, `${modelName}.yaml`)}\`

Add to database:
\`\`\`yaml
responses:
  - message: ${JSON.stringify(input.trim())}
    role: ${JSON.stringify(role)}
    response: "Your response here"
\`\`\``;
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    _funcTools: FuncTool[],
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
    const lastMsg = context[context.length - 1];
    const content = lastMsg && 'content' in lastMsg ? (lastMsg as { content: string }).content : '';
    const role = lastMsg?.role ?? '';

    if (abortSignal?.aborted) {
      throw new Error('AbortError');
    }

    const db = await this.loadResponseDatabase(dbPath, modelName);
    const matched = this.findMatchingResponse(db, content, role);
    await delayWithAbort(matched?.delayMs ?? 0, abortSignal);

    await receiver.thinkingStart();
    await receiver.thinkingChunk(`[${modelName}] `);
    await receiver.thinkingChunk(content.substring(0, 50) || '(empty)');
    await receiver.thinkingFinish();

    if (matched?.streamError) {
      throw new Error(matched.streamError);
    }

    const responseText =
      matched?.response ?? this.makeFallbackResponse(dbPath, content, role, modelName);

    let usage: LlmUsageStats = { kind: 'unavailable' };
    if (matched && matched.usageUnavailable === true) {
      usage = { kind: 'unavailable' };
    } else if (matched && matched.usage) {
      const promptTokens = matched.usage.promptTokens;
      const completionTokens =
        typeof matched.usage.completionTokens === 'number' ? matched.usage.completionTokens : 0;
      const totalTokens =
        typeof matched.usage.totalTokens === 'number'
          ? matched.usage.totalTokens
          : promptTokens + completionTokens;
      usage = {
        kind: 'available',
        promptTokens,
        completionTokens,
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
            case 'ui_only_markdown_msg':
            case 'thinking_msg':
            case 'func_result_msg':
            case 'tellask_result_msg':
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

    return { usage, llmGenModel: modelName };
  }

  async genMoreMessages(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    _funcTools: FuncTool[],
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
    const lastMsg = context[context.length - 1];
    const content = lastMsg && 'content' in lastMsg ? (lastMsg as { content: string }).content : '';
    const role = lastMsg?.role ?? '';

    try {
      const db = await this.loadResponseDatabase(dbPath, modelName);
      const matched = this.findMatchingResponse(db, content, role);
      await delayWithAbort(matched?.delayMs ?? 0, abortSignal);

      const responseText =
        matched?.response ?? this.makeFallbackResponse(dbPath, content, role, modelName);

      const thinking: ChatMessage = {
        type: 'thinking_msg',
        role: 'assistant',
        genseq,
        content: `[${modelName}] ${content.substring(0, 100)}`,
      };

      const saying: SayingMsg = {
        type: 'saying_msg',
        role: 'assistant',
        genseq,
        content: matched?.streamError ? `❌ Mock Error: ${matched.streamError}` : responseText,
      };

      let usage: LlmUsageStats = { kind: 'unavailable' };
      if (matched && matched.usageUnavailable === true) {
        usage = { kind: 'unavailable' };
      } else if (matched && matched.usage) {
        const promptTokens = matched.usage.promptTokens;
        const completionTokens =
          typeof matched.usage.completionTokens === 'number' ? matched.usage.completionTokens : 0;
        const totalTokens =
          typeof matched.usage.totalTokens === 'number'
            ? matched.usage.totalTokens
            : promptTokens + completionTokens;
        usage = {
          kind: 'available',
          promptTokens,
          completionTokens,
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
              case 'ui_only_markdown_msg':
              case 'thinking_msg':
              case 'func_result_msg':
              case 'tellask_result_msg':
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

      return { messages: [thinking, saying], usage, llmGenModel: modelName };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const saying: SayingMsg = {
        type: 'saying_msg',
        role: 'assistant',
        genseq,
        content: `❌ Mock Error: ${errMsg}`,
      };

      const thinking: ChatMessage = {
        type: 'thinking_msg',
        role: 'assistant',
        content: `[${modelName}] error: ${errMsg}`,
        genseq,
      };
      return {
        messages: [thinking, saying],
        usage: { kind: 'unavailable' },
        llmGenModel: modelName,
      };
    }
  }
}
