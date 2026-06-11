import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { LlmRetryEvent } from '@longrun-ai/kernel/types/dialog';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { Dialog, DialogID } from '../../main/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';
import {
  createLlmFailureQuirkHandlerSession,
  KIMI_CODE_API_QUIRK,
  type LlmFailureSummary,
  VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK,
  XCODE_BEST_STREAM_INTERNAL_ERROR_CODE,
} from '../../main/llm/api-quirks';
import type { ProviderConfig } from '../../main/llm/client';
import { classifyOpenAiLikeFailure } from '../../main/llm/gen/failure-classifier';
import {
  LlmRequestFailedError,
  LlmRetryStoppedError,
  runLlmRequestWithRetry,
} from '../../main/llm/kernel-driver/runtime';
import { DomindsPersistenceFileError } from '../../main/persistence-errors';

function buildProviderConfig(): ProviderConfig {
  return {
    name: 'xcode.best - test',
    apiType: 'openai',
    apiQuirks: 'xcode.best',
    baseUrl: 'https://api.xcode.best/v1',
    apiKeyEnvVar: 'XCODE_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

function buildPlainProviderConfig(): ProviderConfig {
  return {
    name: 'plain-openai - test',
    apiType: 'openai',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnvVar: 'PLAIN_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

function buildOpenAiCompatibleSameContextEmptyProviderConfig(): ProviderConfig {
  return {
    name: 'openai-compatible same-context-empty-response - test',
    apiType: 'openai-compatible',
    apiQuirks: 'same-context-empty-response',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnvVar: 'OPENAI_COMPAT_EMPTY_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

function buildVolcengineInvalidParameterProviderConfig(): ProviderConfig {
  return {
    name: 'Volcano Ark Coding Plan - test',
    apiType: 'openai-compatible',
    apiQuirks: VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    apiKeyEnvVar: 'ARK_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

function buildKimiCodeProviderConfig(): ProviderConfig {
  return {
    name: 'Kimi Code - test',
    apiType: 'openai-compatible',
    apiQuirks: KIMI_CODE_API_QUIRK,
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyEnvVar: 'KIMI_CODE_TEST_API_KEY',
    models: {
      test: {
        name: 'Kimi For Coding',
      },
    },
  };
}

function makeFailure(code: string, message: string): LlmFailureSummary {
  return {
    kind: 'retriable',
    code,
    message,
  };
}

function makeKimiCodeHighRiskError(): { status: number; code: string; message: string } {
  return {
    status: 400,
    code: 'OPENAI_COMPATIBLE_REJECTED_REQUEST',
    message: '400 The request was rejected because it was considered high risk',
  };
}

function makeGatewayHtml502Error(): { status: number; message: string } {
  return {
    status: 502,
    message:
      '502 <!DOCTYPE html>\n' +
      '<html lang="en-US">\n' +
      '<head><title>18181899.xyz | 502: Bad gateway</title></head>\n' +
      '<body>Cloudflare Bad gateway</body>\n' +
      '</html>',
  };
}

function makeAuthUnavailableError(): { status: number; code: string; message: string } {
  return {
    status: 500,
    code: 'internal_server_error',
    message: '500 auth_unavailable: no auth available',
  };
}

function makeXcodeBestMisreported403Error(): { status: number; code: string; message: string } {
  return {
    status: 403,
    code: 'forbidden',
    message: '403 Forbidden',
  };
}

function makeXcodeBestMisreported403WithNested429Error(): {
  status: number;
  code: string;
  message: string;
  response: {
    status: number;
    headers: Record<string, string>;
  };
} {
  return {
    status: 403,
    code: 'forbidden',
    message: '403 Forbidden',
    response: {
      status: 429,
      headers: {
        'retry-after': '0.01',
      },
    },
  };
}

function makeVolcengineInvalidParameterError(): { status: number; code: string; message: string } {
  return {
    status: 400,
    code: 'InvalidParameter',
    message:
      '400 A parameter specified in the request is not valid: %s Request id: 021778429772930a9c6544091777d16bd21be5aab8209d34efbd2',
  };
}

function makeVolcengineNestedInvalidParameterWith429Error(): {
  status: number;
  code: string;
  message: string;
  response: { status: number };
} {
  return {
    ...makeVolcengineInvalidParameterError(),
    response: { status: 429 },
  };
}

function makeWrappedVolcengineInvalidParameterError(): Error & {
  cause: { status: number; code: string; message: string };
  code: string;
  status: number;
} {
  const cause = makeVolcengineInvalidParameterError();
  const error = new Error(
    'OPENAI-compatible provider rejected stream request with HTTP 400.',
  ) as Error & {
    cause: { status: number; code: string; message: string };
    code: string;
    status: number;
  };
  error.cause = cause;
  error.code = cause.code;
  error.status = cause.status;
  return error;
}

function makeXcodeBestStreamInternalError(args: { status?: number; retryAfter?: string }): {
  status?: number;
  code: string;
  message: string;
  headers?: Record<string, string>;
} {
  const error: {
    status?: number;
    code: string;
    message: string;
    headers?: Record<string, string>;
  } = {
    code: XCODE_BEST_STREAM_INTERNAL_ERROR_CODE,
    message: 'stream error: internal_error received from peer',
  };
  if (args.status !== undefined) {
    error.status = args.status;
  }
  if (args.retryAfter !== undefined) {
    error.headers = {
      'retry-after': args.retryAfter,
    };
  }
  return error;
}

function makeXcodeBestStreamInternalResponseStatusError(args: {
  status: number;
  retryAfter?: string;
}): {
  code: string;
  message: string;
  response: {
    status: number;
    headers?: Record<string, string>;
  };
} {
  const response: {
    status: number;
    headers?: Record<string, string>;
  } = {
    status: args.status,
  };
  if (args.retryAfter !== undefined) {
    response.headers = {
      'retry-after': args.retryAfter,
    };
  }
  return {
    code: XCODE_BEST_STREAM_INTERNAL_ERROR_CODE,
    message: 'stream error: internal_error received from peer',
    response,
  };
}

function makeNestedXcodeBestStreamInternalResponseStatusError(args: {
  status: number;
  retryAfter?: string;
}): {
  error: {
    code: string;
    message: string;
    response: {
      status: number;
      headers?: Record<string, string>;
    };
  };
} {
  return {
    error: makeXcodeBestStreamInternalResponseStatusError(args),
  };
}

function makeUnexpectedEofError(): Error {
  return new Error('unexpected EOF');
}

function makeWrappedUnexpectedEofError(): Error {
  return new Error('fetch failed', { cause: makeUnexpectedEofError() });
}

function buildFakeDialog(language: LanguageCode): Dialog {
  const dialogId = new DialogID('quirk-retry-test');
  const fakeDialog = {
    id: dialogId,
    currentCourse: 1,
    activeGenCourseOrUndefined: 1,
    activeGenSeq: 1,
    status: 'active',
    async streamError(_detail: string): Promise<void> {},
    getLastUserLanguageCode(): LanguageCode {
      return language;
    },
  };
  return fakeDialog as unknown as Dialog;
}

async function readRetryEvents(dialogId: DialogID, count: number): Promise<LlmRetryEvent[]> {
  const subChan = dialogEventRegistry.createSubChan(dialogId);
  const events: LlmRetryEvent[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const event = await subChan.read();
      assert.notEqual(event, EndOfStream, 'Unexpected end of retry event stream');
      assert.equal(event.type, 'llm_retry_evt');
      events.push(event);
    }
  } finally {
    subChan.cancel();
  }
  return events;
}

async function verifyQuirkSessionStateMachine(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected xcode.best quirk handler session');

  const emptyFailure = makeFailure('DOMINDS_LLM_EMPTY_RESPONSE', 'empty response');
  const firstEmpty = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: emptyFailure,
    error: new Error('empty response'),
  });
  assert.equal(firstEmpty.kind, 'single_retry');
  if (firstEmpty.kind !== 'single_retry') {
    throw new Error(`Expected single_retry, got ${firstEmpty.kind}`);
  }
  assert.equal(firstEmpty.delayMs, 3000);
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: makeFailure('RATE_LIMIT', 'requests per min exceeded'),
      error: {
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'RPM exceeded: requests per min exceeded',
      },
    }).kind,
    'default',
    'Expected non-empty-response failures to fall back to default handling',
  );
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'single_retry',
  );
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'single_retry',
  );
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'single_retry',
  );
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'single_retry',
  );
  const giveUpHandling = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: emptyFailure,
    error: new Error('empty response'),
  });
  assert.equal(giveUpHandling.kind, 'give_up');
  if (giveUpHandling.kind !== 'give_up') {
    throw new Error(`Expected give_up, got ${giveUpHandling.kind}`);
  }
  assert.equal(giveUpHandling.recoveryAction?.kind, 'diligence_push_once');
  assert.equal(giveUpHandling.sourceQuirk, 'xcode.best');

  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: makeFailure('ECONNRESET', 'socket hang up'),
      error: new Error('socket hang up'),
    }).kind,
    'default',
  );
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'single_retry',
    'Expected non-empty-response failure to reset the xcode.best empty-response streak',
  );

  const gatewayHtmlHandling = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: {
      kind: 'fatal',
      status: 502,
      message: makeGatewayHtml502Error().message,
    },
    error: makeGatewayHtml502Error(),
  });
  assert.equal(gatewayHtmlHandling.kind, 'retry_strategy');
  if (gatewayHtmlHandling.kind !== 'retry_strategy') {
    throw new Error(`Expected retry_strategy, got ${gatewayHtmlHandling.kind}`);
  }
  assert.equal(gatewayHtmlHandling.retryStrategy, 'conservative');
  assert.match(gatewayHtmlHandling.message ?? '', /html 502 bad gateway page/iu);

  const authUnavailableHandling = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: {
      kind: 'fatal',
      status: 500,
      message: makeAuthUnavailableError().message,
    },
    error: makeAuthUnavailableError(),
  });
  assert.equal(authUnavailableHandling.kind, 'retry_strategy');
  if (authUnavailableHandling.kind !== 'retry_strategy') {
    throw new Error(`Expected retry_strategy, got ${authUnavailableHandling.kind}`);
  }
  assert.equal(authUnavailableHandling.retryStrategy, 'conservative');
  assert.match(authUnavailableHandling.message ?? '', /auth_unavailable/iu);

  const unexpectedEofHandling = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: {
      kind: 'fatal',
      message: 'unexpected EOF',
    },
    error: makeUnexpectedEofError(),
  });
  assert.equal(unexpectedEofHandling.kind, 'retry_strategy');
  if (unexpectedEofHandling.kind !== 'retry_strategy') {
    throw new Error(`Expected retry_strategy, got ${unexpectedEofHandling.kind}`);
  }
  assert.equal(unexpectedEofHandling.retryStrategy, 'conservative');
  assert.match(unexpectedEofHandling.message ?? '', /unexpected eof/iu);

  const wrappedUnexpectedEofHandling = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: {
      kind: 'fatal',
      message: 'fetch failed',
    },
    error: makeWrappedUnexpectedEofError(),
  });
  assert.equal(wrappedUnexpectedEofHandling.kind, 'retry_strategy');
  if (wrappedUnexpectedEofHandling.kind !== 'retry_strategy') {
    throw new Error(`Expected retry_strategy, got ${wrappedUnexpectedEofHandling.kind}`);
  }
  assert.equal(wrappedUnexpectedEofHandling.retryStrategy, 'conservative');

  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: {
        kind: 'fatal',
        message: 'unexpected EOF',
      },
      error: new DomindsPersistenceFileError({
        message: 'Invalid latest.yaml in /tmp/latest.yaml',
        source: 'dialog_latest',
        operation: 'parse',
        format: 'yaml',
        filePath: '/tmp/latest.yaml',
        eofLike: true,
        cause: makeUnexpectedEofError(),
      }),
    }).kind,
    'default',
    'Expected local file-context EOFs to stay out of xcode.best infrastructure retry quirks',
  );

  const providerHttpPathUnexpectedEofHandling = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: {
      kind: 'fatal',
      message: 'unexpected EOF',
    },
    error: {
      message: 'unexpected EOF',
      path: '/v1/responses',
      status: 502,
    },
  });
  assert.equal(providerHttpPathUnexpectedEofHandling.kind, 'retry_strategy');
  if (providerHttpPathUnexpectedEofHandling.kind !== 'retry_strategy') {
    throw new Error(
      `Expected retry_strategy for provider http-path EOF, got ${providerHttpPathUnexpectedEofHandling.kind}`,
    );
  }
  assert.equal(providerHttpPathUnexpectedEofHandling.retryStrategy, 'conservative');
}

async function verifySingleRetryBypassesAggressiveBurstLimit(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('zh');
  const retryEventsPromise = readRetryEvents(dialog.id, 9);
  let attempts = 0;

  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'xcode1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        canRetry: () => true,
        doRequest: async () => {
          attempts += 1;
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => {
      assert.equal(attempts, 5, 'Expected four quirk-granted single retries before give_up');
      assert.ok(
        error instanceof LlmRetryStoppedError,
        'Expected LlmRetryStoppedError to be thrown',
      );
      assert.equal(error.reason.kind, 'llm_retry_stopped');
      assert.equal(error.reason.recoveryAction.kind, 'diligence_push_once');
      assert.equal(
        error.reason.display.summaryTextI18n.zh?.includes('如果不引入新的信息或新的指令'),
        true,
      );
      assert.equal(error.reason.display.titleTextI18n.zh, '重试已停止');
      assert.match(error.reason.error, /LLM returned empty response/u);
      assert.match(error.message, /不引入新的信息或新的指令/u);
      assert.match(error.message, /最后错误：LLM returned empty response/u);
      assert.doesNotMatch(error.message, /若想增加重试次数/u);
      return true;
    },
  );
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    [
      'waiting',
      'running',
      'waiting',
      'running',
      'waiting',
      'running',
      'waiting',
      'running',
      'stopped',
    ],
  );
  const stopped = retryEvents.at(-1);
  assert.ok(stopped, 'Expected final retry event');
  assert.equal(stopped.phase, 'stopped');
  if (stopped.phase !== 'stopped') {
    throw new Error(`Expected stopped event, got ${stopped.phase}`);
  }
  assert.equal(stopped.continueEnabled, false);
  assert.equal(stopped.reason.kind, 'llm_retry_stopped');
  assert.equal(stopped.reason.recoveryAction.kind, 'diligence_push_once');
  assert.equal(stopped.reason.display.titleTextI18n.zh, '重试已停止');
  assert.equal(
    stopped.reason.display.summaryTextI18n.zh?.includes('如果不引入新的信息或新的指令'),
    true,
  );
}

async function verifyOpenAiCompatibleSameContextEmptyResponseQuirk(): Promise<void> {
  const providerConfig = buildOpenAiCompatibleSameContextEmptyProviderConfig();
  const dialog = buildFakeDialog('zh');
  const retryEventsPromise = readRetryEvents(dialog.id, 9);
  let attempts = 0;

  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'volcano-engine-coding-plan',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        canRetry: () => true,
        doRequest: async () => {
          attempts += 1;
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message:
              'LLM returned empty response (provider=volcano-engine-coding-plan, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => {
      assert.equal(attempts, 5, 'Expected four quirk-granted single retries before give_up');
      assert.ok(
        error instanceof LlmRetryStoppedError,
        'Expected LlmRetryStoppedError to be thrown',
      );
      assert.equal(error.reason.recoveryAction.kind, 'diligence_push_once');
      assert.match(error.message, /同一对话上下文中连续返回 empty response/u);
      return true;
    },
  );

  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    [
      'waiting',
      'running',
      'waiting',
      'running',
      'waiting',
      'running',
      'waiting',
      'running',
      'stopped',
    ],
  );
  const stopped = retryEvents.at(-1);
  assert.ok(stopped, 'Expected stopped event');
  assert.equal(stopped.phase, 'stopped');
  if (stopped.phase !== 'stopped') {
    throw new Error(`Expected stopped event, got ${stopped.phase}`);
  }
  assert.equal(stopped.reason.recoveryAction.kind, 'diligence_push_once');
  assert.equal(
    stopped.reason.display.summaryTextI18n.zh?.includes('同一对话上下文中连续返回 empty response'),
    true,
  );
}

function verifyVolcengineInvalidParameterQuirkUsesAggressiveRetry(): void {
  const providerConfig = buildVolcengineInvalidParameterProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected Volcano InvalidParameter quirk handler session');

  const error = makeVolcengineInvalidParameterError();
  const handling = session.onFailure({
    provider: 'volcano-engine-coding-plan',
    providerConfig,
    failure: {
      kind: 'rejected',
      status: error.status,
      code: error.code,
      message: error.message,
    },
    error,
  });

  assert.equal(handling.kind, 'retry_strategy');
  if (handling.kind !== 'retry_strategy') {
    throw new Error(`Expected retry_strategy, got ${handling.kind}`);
  }
  assert.equal(handling.retryStrategy, 'aggressive');
  assert.match(handling.message ?? '', /transient 400 InvalidParameter/u);

  const wrappedError = makeWrappedVolcengineInvalidParameterError();
  const wrappedHandling = session.onFailure({
    provider: 'volcano-engine-coding-plan',
    providerConfig,
    failure: {
      kind: 'rejected',
      status: wrappedError.status,
      code: wrappedError.code,
      message: wrappedError.message,
    },
    error: wrappedError,
  });
  assert.equal(wrappedHandling.kind, 'retry_strategy');
  if (wrappedHandling.kind !== 'retry_strategy') {
    throw new Error(`Expected wrapped retry_strategy, got ${wrappedHandling.kind}`);
  }
  assert.equal(wrappedHandling.retryStrategy, 'aggressive');
}

function verifyVolcengineInvalidParameterQuirkStaysOutOfRateLimit(): void {
  const providerConfig = buildVolcengineInvalidParameterProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected Volcano InvalidParameter quirk handler session');

  const error = makeVolcengineNestedInvalidParameterWith429Error();
  const handling = session.onFailure({
    provider: 'volcano-engine-coding-plan',
    providerConfig,
    failure: {
      kind: 'retriable',
      status: 429,
      code: error.code,
      message: error.message,
    },
    error,
  });

  assert.equal(
    handling.kind,
    'default',
    'Expected nested 429 to stay in default smart-rate retry handling',
  );
}

function verifyVolcengineInvalidParameterQuirkDoesNotGeneralizeAll400s(): void {
  const providerConfig = buildVolcengineInvalidParameterProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected Volcano InvalidParameter quirk handler session');

  assert.equal(
    session.onFailure({
      provider: 'volcano-engine-coding-plan',
      providerConfig,
      failure: {
        kind: 'rejected',
        status: 400,
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded',
      },
      error: {
        status: 400,
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded',
      },
    }).kind,
    'default',
    'Expected context-window 400 to remain rejected',
  );

  assert.equal(
    session.onFailure({
      provider: 'volcano-engine-coding-plan',
      providerConfig,
      failure: {
        kind: 'rejected',
        status: 400,
        code: 'InvalidParameter',
        message: '400 InvalidParameter: unsupported request option',
      },
      error: {
        status: 400,
        code: 'InvalidParameter',
        message: '400 InvalidParameter: unsupported request option',
      },
    }).kind,
    'default',
    'Expected unrelated InvalidParameter 400 to remain rejected',
  );
}

function verifyKimiCodeHighRiskQuirkOffersTwoRuntimePromptRecoveries(): void {
  const providerConfig = buildKimiCodeProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected Kimi Code quirk handler session');

  const error = makeKimiCodeHighRiskError();
  const recoveryContents = new Set<string>();
  for (let index = 0; index < 2; index += 1) {
    const handling = session.onFailure({
      provider: 'kimi-code',
      providerConfig,
      failure: {
        kind: 'rejected',
        status: error.status,
        code: error.code,
        message: error.message,
      },
      error,
    });
    assert.equal(handling.kind, 'give_up');
    if (handling.kind !== 'give_up') {
      throw new Error(`Expected give_up, got ${handling.kind}`);
    }
    assert.equal(handling.recoveryAction?.kind, 'runtime_prompt_once');
    if (handling.recoveryAction?.kind !== 'runtime_prompt_once') {
      throw new Error(`Expected runtime_prompt_once, got ${handling.recoveryAction?.kind}`);
    }
    assert.match(handling.recoveryAction.content, /正常|复核|开发|风险/u);
    recoveryContents.add(handling.recoveryAction.content);
    session.onRecoveryActionUsed?.({
      action: handling.recoveryAction,
      sourceQuirk: KIMI_CODE_API_QUIRK,
    });
  }

  const finalHandling = session.onFailure({
    provider: 'kimi-code',
    providerConfig,
    failure: {
      kind: 'rejected',
      status: error.status,
      code: error.code,
      message: error.message,
    },
    error,
  });
  assert.equal(finalHandling.kind, 'give_up');
  if (finalHandling.kind !== 'give_up') {
    throw new Error(`Expected give_up, got ${finalHandling.kind}`);
  }
  assert.equal(finalHandling.recoveryAction?.kind, 'none');
  assert.equal(recoveryContents.size, 2, 'Expected the two recovery prompts not to repeat');
}

function verifyKimiCodeHighRiskQuirkOnlyHandlesRejected400HighRisk(): void {
  const providerConfig = buildKimiCodeProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected Kimi Code quirk handler session');

  assert.equal(
    session.onFailure({
      provider: 'kimi-code',
      providerConfig,
      failure: {
        kind: 'rejected',
        status: 429,
        code: 'rate_limit_exceeded',
        message: '429 The request was rejected because it was considered high risk',
      },
      error: {
        status: 429,
        code: 'rate_limit_exceeded',
        message: '429 The request was rejected because it was considered high risk',
      },
    }).kind,
    'default',
    'Expected 429 to keep normal rate-limit handling precedence',
  );

  assert.equal(
    session.onFailure({
      provider: 'kimi-code',
      providerConfig,
      failure: {
        kind: 'rejected',
        status: 400,
        code: 'context_length_exceeded',
        message: '400 context length exceeded',
      },
      error: {
        status: 400,
        code: 'context_length_exceeded',
        message: '400 context length exceeded',
      },
    }).kind,
    'default',
    'Expected non-high-risk 400 to remain default rejected handling',
  );

  assert.equal(
    session.onFailure({
      provider: 'kimi-code',
      providerConfig,
      failure: {
        kind: 'retriable',
        status: 400,
        code: 'OPENAI_COMPATIBLE_REJECTED_REQUEST',
        message: '400 The request was rejected because it was considered high risk',
      },
      error: makeKimiCodeHighRiskError(),
    }).kind,
    'default',
    'Expected non-rejected high-risk-looking 400 to remain default handling',
  );
}

async function verifyRuntimeKimiCodeHighRiskRecoveryStopsAfterTwoRuntimePrompts(): Promise<void> {
  const providerConfig = buildKimiCodeProviderConfig();
  const dialog = buildFakeDialog('zh');
  const retryEventsPromise = readRetryEvents(dialog.id, 1);
  const quirkFailureHandlerSession = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(quirkFailureHandlerSession, 'Expected Kimi Code quirk handler session');
  let attempts = 0;
  const recoveryPrompts: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      async () =>
        runLlmRequestWithRetry({
          dlg: dialog,
          provider: 'kimi-code',
          modelId: 'test',
          providerConfig,
          quirkFailureHandlerSession,
          aggressiveRetryMaxRetries: 0,
          retryInitialDelayMs: 0,
          retryConservativeDelayMs: 0,
          retryBackoffMultiplier: 1,
          retryMaxDelayMs: 0,
          classifyFailure: classifyOpenAiLikeFailure,
          canRetry: () => true,
          onRetryStopped: async (reason) => {
            if (reason.recoveryAction.kind === 'runtime_prompt_once') {
              recoveryPrompts.push(reason.recoveryAction.content);
              return 'continue';
            }
            return 'stop';
          },
          doRequest: async () => {
            attempts += 1;
            throw makeKimiCodeHighRiskError();
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof LlmRetryStoppedError);
        if (!(error instanceof LlmRetryStoppedError)) {
          return false;
        }
        assert.match(error.message, /high risk/u);
        assert.equal(error.reason.recoveryAction.kind, index < 2 ? 'runtime_prompt_once' : 'none');
        return true;
      },
    );
  }

  assert.equal(attempts, 3);
  assert.equal(recoveryPrompts.length, 2);
  assert.equal(new Set(recoveryPrompts).size, 2);
  for (const prompt of recoveryPrompts) {
    assert.match(prompt, /正常|复核|开发|风险/u);
  }
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['stopped'],
  );
}

async function verifyRuntimeVolcengineInvalidParameterQuirkRetriesRejectedFailure(): Promise<void> {
  const providerConfig = buildVolcengineInvalidParameterProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'volcano-engine-coding-plan',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    classifyFailure: classifyOpenAiLikeFailure,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeVolcengineInvalidParameterError();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
  assert.match(waiting?.error ?? '', /A parameter specified in the request is not valid/u);
}

async function verifySameContextEmptyResponseQuirkResetsOnContextChange(): Promise<void> {
  const providerConfig = buildOpenAiCompatibleSameContextEmptyProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected same-context-empty-response quirk handler session');

  const emptyFailure = makeFailure('DOMINDS_LLM_EMPTY_RESPONSE', 'empty response');
  session.onRequestContext?.('97/a3/0213f50b:c2:g24');
  for (let index = 0; index < 4; index += 1) {
    session.onRequestContext?.('97/a3/0213f50b:c2:g24');
    assert.equal(
      session.onFailure({
        provider: 'volcano-engine-coding-plan',
        providerConfig,
        failure: emptyFailure,
        error: new Error('empty response'),
      }).kind,
      'single_retry',
    );
  }

  session.onRequestContext?.('97/a3/0213f50b:c2:g24');
  assert.equal(
    session.onFailure({
      provider: 'volcano-engine-coding-plan',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'give_up',
    'Expected repeated notifications for the same dialog generation to keep the streak',
  );

  session.onRequestContext?.('97/a3/0213f50b:c2:g25');
  assert.equal(
    session.onFailure({
      provider: 'volcano-engine-coding-plan',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'single_retry',
    'Expected a materially new dialog generation to reset the empty-response streak',
  );
}

async function verifySameContextEmptyResponseRecoveryClosesLoopAcrossContextChange(): Promise<void> {
  const providerConfig = buildOpenAiCompatibleSameContextEmptyProviderConfig();
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session, 'Expected same-context-empty-response quirk handler session');

  const emptyFailure = makeFailure('DOMINDS_LLM_EMPTY_RESPONSE', 'empty response');
  session.onRequestContext?.('97/a3/0213f50b:c2:g24');
  let firstGiveUp: ReturnType<NonNullable<typeof session>['onFailure']> | undefined;
  for (let index = 0; index < 5; index += 1) {
    firstGiveUp = session.onFailure({
      provider: 'volcano-engine-coding-plan',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    });
  }
  assert.equal(firstGiveUp?.kind, 'give_up');
  if (firstGiveUp?.kind !== 'give_up') {
    throw new Error(`Expected first same-context empty response give_up, got ${firstGiveUp?.kind}`);
  }
  assert.equal(firstGiveUp.recoveryAction.kind, 'diligence_push_once');

  session.onRecoveryActionUsed?.({
    action: firstGiveUp.recoveryAction,
    sourceQuirk: 'same-context-empty-response',
  });
  session.onRequestContext?.('97/a3/0213f50b:c2:g25');

  let secondGiveUp: ReturnType<NonNullable<typeof session>['onFailure']> | undefined;
  for (let index = 0; index < 5; index += 1) {
    secondGiveUp = session.onFailure({
      provider: 'volcano-engine-coding-plan',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    });
  }
  assert.equal(secondGiveUp?.kind, 'give_up');
  if (secondGiveUp?.kind !== 'give_up') {
    throw new Error(
      `Expected second same-context empty response give_up, got ${secondGiveUp?.kind}`,
    );
  }
  assert.equal(secondGiveUp.recoveryAction.kind, 'none');
}

async function verifyRetryStoppedRecoveryHookSuppressesStoppedEvent(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('zh');
  const retryEventsPromise = readRetryEvents(dialog.id, 8);
  let attempts = 0;
  let recoveryHookCalls = 0;

  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'xcode1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        canRetry: () => true,
        onRetryStopped: async (reason) => {
          recoveryHookCalls += 1;
          assert.equal(reason.recoveryAction.kind, 'diligence_push_once');
          return 'continue';
        },
        doRequest: async () => {
          attempts += 1;
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => error instanceof LlmRetryStoppedError,
  );

  assert.equal(attempts, 5);
  assert.equal(recoveryHookCalls, 1);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'waiting', 'running', 'waiting', 'running', 'waiting', 'running'],
  );
}

async function verifyRetryStoppedRecoveryHookCanRefuseSecondRecovery(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('zh');
  const sharedQuirkSession = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(sharedQuirkSession, 'Expected shared xcode.best quirk session');
  let recoveryHookCalls = 0;
  const decideRecovery = async (
    reason: Parameters<
      NonNullable<Parameters<typeof runLlmRequestWithRetry<string>>[0]['onRetryStopped']>
    >[0],
  ): Promise<'continue' | 'stop'> => {
    recoveryHookCalls += 1;
    return reason.recoveryAction.kind === 'diligence_push_once' ? 'continue' : 'stop';
  };

  const firstRetryEventsPromise = readRetryEvents(dialog.id, 8);
  let firstAttempts = 0;
  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'xcode1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        quirkFailureHandlerSession: sharedQuirkSession ?? undefined,
        canRetry: () => true,
        onRetryStopped: decideRecovery,
        doRequest: async () => {
          firstAttempts += 1;
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => error instanceof LlmRetryStoppedError,
  );
  assert.equal(firstAttempts, 5);
  assert.equal(recoveryHookCalls, 1);
  const firstRetryEvents = await firstRetryEventsPromise;
  assert.deepEqual(
    firstRetryEvents.map((event) => event.phase),
    ['waiting', 'running', 'waiting', 'running', 'waiting', 'running', 'waiting', 'running'],
  );

  const secondRetryEventsPromise = readRetryEvents(dialog.id, 9);
  let secondAttempts = 0;
  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'xcode1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        quirkFailureHandlerSession: sharedQuirkSession ?? undefined,
        canRetry: () => true,
        onRetryStopped: decideRecovery,
        doRequest: async () => {
          secondAttempts += 1;
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRetryStoppedError);
      if (!(error instanceof LlmRetryStoppedError)) {
        return false;
      }
      assert.equal(error.reason.recoveryAction.kind, 'none');
      return true;
    },
  );
  assert.equal(secondAttempts, 5);
  assert.equal(recoveryHookCalls, 2);
  const secondRetryEvents = await secondRetryEventsPromise;
  assert.deepEqual(
    secondRetryEvents.map((event) => event.phase),
    [
      'waiting',
      'running',
      'waiting',
      'running',
      'waiting',
      'running',
      'waiting',
      'running',
      'stopped',
    ],
  );
}

async function verifySharedQuirkSessionRecoveryResetsAfterSuccess(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('zh');
  const sharedQuirkSession = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(sharedQuirkSession, 'Expected shared xcode.best quirk session');

  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'xcode1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        quirkFailureHandlerSession: sharedQuirkSession ?? undefined,
        canRetry: () => true,
        onRetryStopped: async (reason) =>
          reason.recoveryAction.kind === 'diligence_push_once' ? 'continue' : 'stop',
        doRequest: async () => {
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => error instanceof LlmRetryStoppedError,
  );

  const success = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 0,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    quirkFailureHandlerSession: sharedQuirkSession ?? undefined,
    canRetry: () => true,
    doRequest: async () => 'ok',
  });
  assert.equal(success, 'ok');

  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'xcode1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 0,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        quirkFailureHandlerSession: sharedQuirkSession ?? undefined,
        canRetry: () => true,
        onRetryStopped: async (reason) => {
          assert.equal(reason.recoveryAction.kind, 'diligence_push_once');
          return 'stop';
        },
        doRequest: async () => {
          throw {
            status: 503,
            code: 'DOMINDS_LLM_EMPTY_RESPONSE',
            message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
          };
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRetryStoppedError);
      if (!(error instanceof LlmRetryStoppedError)) {
        return false;
      }
      assert.equal(error.reason.recoveryAction.kind, 'diligence_push_once');
      return true;
    },
  );
}

async function verifyResolvedRetryLifecycle(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 0,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          status: 503,
          code: 'DOMINDS_LLM_EMPTY_RESPONSE',
          message: 'LLM returned empty response (provider=xcode1, model=test, streaming=true).',
        };
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const resolved = retryEvents.at(-1);
  assert.ok(resolved, 'Expected resolved retry event');
  assert.equal(resolved.phase, 'resolved');
  if (resolved.phase !== 'resolved') {
    throw new Error(`Expected resolved event, got ${resolved.phase}`);
  }
  assert.equal(resolved.display.titleTextI18n.en, 'Temporary retry recovered');
}

async function verifyPolicyRetryLifecycleDisplay(): Promise<void> {
  const providerConfig = buildPlainProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'openai1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 2,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    classifyFailure: classifyOpenAiLikeFailure,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          status: 503,
          code: 'ECONNRESET',
          message: 'socket hang up',
        };
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.titleTextI18n.en, 'Retrying');
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('backing off'), true);
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('retry in 0ms'), false);
  assert.match(waiting?.error ?? '', /socket hang up/u);
  assert.equal(resolved?.display.titleTextI18n.en, 'Retry recovered');
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
}

function verifySmartRateClassification(): void {
  const failure = classifyOpenAiLikeFailure({
    status: 429,
    code: 'rate_limit_exceeded',
    message: 'RPM exceeded: requests per min exceeded',
    headers: {
      'retry-after': '2',
    },
  });
  assert.ok(failure, 'Expected OpenAI-like classifier to classify 429 as retriable');
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
  assert.equal(failure?.retryAfterMs, 2000);
}

function verifyChatGptUsageLimitMessageJsonRetryDelay(): void {
  const failure = classifyOpenAiLikeFailure({
    status: 429,
    message:
      'ChatGPT responses request failed (429): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1781189458,"eligible_promo":null,"resets_in_seconds":2606}}',
  });
  assert.ok(failure, 'Expected ChatGPT usage-limit 429 to classify as retriable');
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
  assert.equal(failure?.retryAfterMs, 2606000);
}

function verifyPlainOpenAi403StaysRejected(): void {
  const failure = classifyOpenAiLikeFailure({
    status: 403,
    code: 'forbidden',
    message: '403 Forbidden',
  });
  assert.ok(failure, 'Expected OpenAI-like classifier to classify plain 403');
  assert.equal(failure?.kind, 'rejected');
  assert.equal(failure?.retryStrategy, undefined);
}

function verifyNested429WinsOverOuter403(): void {
  const failure = classifyOpenAiLikeFailure(makeXcodeBestMisreported403WithNested429Error());
  assert.ok(failure, 'Expected nested response.status 429 to classify as a rate-limit failure');
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
  assert.equal(failure?.retryAfterMs, 10);
}

function verifyXcodeBestStreamInternal429ClassifiesAsSmartRate(): void {
  const failure = classifyOpenAiLikeFailure(
    makeXcodeBestStreamInternalError({
      status: 429,
      retryAfter: '2',
    }),
  );
  assert.ok(
    failure,
    'Expected OpenAI-like classifier to keep 429 stream-internal failures in rate-limit handling',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
  assert.equal(failure?.retryAfterMs, 2000);
}

function verifyXcodeBestStreamInternalResponse429ClassifiesAsSmartRate(): void {
  const failure = classifyOpenAiLikeFailure(
    makeXcodeBestStreamInternalResponseStatusError({
      status: 429,
      retryAfter: '2',
    }),
  );
  assert.ok(
    failure,
    'Expected response.status 429 stream-internal failures to stay in rate-limit handling',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
  assert.equal(failure?.retryAfterMs, 2000);
}

function verifyNestedXcodeBestStreamInternalResponse429ClassifiesAsSmartRate(): void {
  const failure = classifyOpenAiLikeFailure(
    makeNestedXcodeBestStreamInternalResponseStatusError({
      status: 429,
      retryAfter: '2',
    }),
  );
  assert.ok(
    failure,
    'Expected nested response.status 429 stream-internal failures to stay in rate-limit handling',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
  assert.equal(failure?.retryAfterMs, 2000);
}

function verifyXcodeBestStreamInternalIsNotGlobalClassifierAggressive(): void {
  const failure = classifyOpenAiLikeFailure(makeXcodeBestStreamInternalError({}));
  assert.ok(
    failure,
    'Expected OpenAI-like classifier to treat provider-specific stream-internal code as an ordinary coded provider failure',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'conservative');
}

function verifySmartRateClassificationFromConcurrencyLimitMessage(): void {
  const failure = classifyOpenAiLikeFailure(
    new Error('Concurrency limit exceeded for account, please retry later'),
  );
  assert.ok(
    failure,
    'Expected OpenAI-like classifier to classify concurrency-limit messages as retriable',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'smart_rate');
}

function verifyOpenAiProcessingFailureDefaultsToConservative(): void {
  const failure = classifyOpenAiLikeFailure(
    new Error(
      'We are currently processing your request. Please retry your request. Request ID: req_test',
    ),
  );
  assert.ok(
    failure,
    'Expected OpenAI-like classifier to classify processing-retry messages as retriable',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'conservative');
}

function verifyOpenAiContextWindowExceededIsRejected(): void {
  const messages = [
    'Your input exceeds the context window of this model. Please adjust your input and try again.',
    'Context window exceeded for this model.',
    'Context limit exceeded.',
    "This model's maximum context length is 128000 tokens.",
    'Too many tokens in context.',
  ];
  for (const message of messages) {
    const failure = classifyOpenAiLikeFailure(new Error(message));
    assert.ok(failure, 'Expected OpenAI-like classifier to reject deterministic context overflow');
    assert.equal(failure?.kind, 'rejected');
    assert.equal(failure?.retryStrategy, undefined);
  }
}

function verifyOpenAiContextLengthExceededCodeIsRejected(): void {
  const failure = classifyOpenAiLikeFailure({
    code: ' CONTEXT_LENGTH_EXCEEDED ',
    message: 'Invalid request.',
  });
  assert.ok(failure, 'Expected OpenAI-like classifier to reject context-length error codes');
  assert.equal(failure?.kind, 'rejected');
  assert.equal(failure?.retryStrategy, undefined);
}

function verifyOpenAiTransportFailureWithStatusStaysAggressive(): void {
  const failure = classifyOpenAiLikeFailure({
    status: 503,
    code: 'ECONNRESET',
    message: 'socket hang up',
  });
  assert.ok(
    failure,
    'Expected OpenAI-like classifier to preserve explicit transport short-errors as retriable',
  );
  assert.equal(failure?.kind, 'retriable');
  assert.equal(failure?.retryStrategy, 'aggressive');
}

async function verifyRuntimeDoesNotRetryContextWindowOverflow(): Promise<void> {
  const providerConfig = buildPlainProviderConfig();
  const dialog = buildFakeDialog('en');
  let attempts = 0;

  await assert.rejects(
    async () =>
      runLlmRequestWithRetry({
        dlg: dialog,
        provider: 'openai1',
        modelId: 'test',
        providerConfig,
        aggressiveRetryMaxRetries: 3,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        classifyFailure: classifyOpenAiLikeFailure,
        canRetry: () => true,
        doRequest: async () => {
          attempts += 1;
          throw new Error(
            'Your input exceeds the context window of this model. Please adjust your input and try again.',
          );
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmRequestFailedError);
      if (!(error instanceof LlmRequestFailedError)) {
        return false;
      }
      assert.match(error.message, /rejected the request/u);
      return true;
    },
  );

  assert.equal(attempts, 1);
}

async function verifySmartRateRespectsProviderSuggestedDelayBeyondLocalMax(): Promise<void> {
  const providerConfig = buildPlainProviderConfig();
  const dialog = buildFakeDialog('en');
  let attempts = 0;
  const startedAt = Date.now();

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'openai1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    classifyFailure: classifyOpenAiLikeFailure,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          status: 429,
          code: 'rate_limit_exceeded',
          message: 'RPM exceeded: requests per min exceeded',
          headers: {
            'retry-after': '0.03',
          },
        };
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.ok(
    Date.now() - startedAt >= 20,
    'Expected provider-suggested retry delay to bypass local llm_retry_max_delay_ms cap',
  );
}

async function verifyRuntimeDefaultsUnknownProviderFailuresToConservativeRetry(): Promise<void> {
  const providerConfig = buildPlainProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'openai1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 0,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          status: 429,
          code: 'rate_limit_exceeded',
          message: 'RPM exceeded: requests per min exceeded',
          headers: {
            'retry-after': '1',
          },
        };
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
}

async function verifyRuntimeStillRetriesPlainObjectTransportFailures(): Promise<void> {
  const providerConfig = buildPlainProviderConfig();
  const dialog = buildFakeDialog('en');
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'openai1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          message: 'fetch failed',
        };
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
}

async function verifyXcodeBestGatewayHtml502UsesConservativeRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeGatewayHtml502Error();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.titleTextI18n.en, 'Retrying');
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
  assert.match(waiting?.error ?? '', /bad gateway/iu);
  assert.equal(resolved?.display.titleTextI18n.en, 'Retry recovered');
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
}

async function verifyXcodeBestUnexpectedEofUsesConservativeRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 0,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeWrappedUnexpectedEofError();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.titleTextI18n.en, 'Retrying');
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
  assert.equal(waiting?.error, 'fetch failed');
  assert.equal(resolved?.display.titleTextI18n.en, 'Retry recovered');
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
}

async function verifyXcodeBestAuthUnavailableUsesConservativeRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 0,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeAuthUnavailableError();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.titleTextI18n.en, 'Retrying');
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
  assert.match(waiting?.error ?? '', /auth_unavailable/iu);
  assert.equal(resolved?.display.titleTextI18n.en, 'Retry recovered');
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
}

async function verifyXcodeBestMisreported403UsesAggressiveRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeXcodeBestMisreported403Error();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.titleTextI18n.en, 'Retrying');
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
  assert.match(waiting?.error ?? '', /403 Forbidden/u);
  assert.equal(resolved?.display.titleTextI18n.en, 'Retry recovered');
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
}

async function verifyXcodeBestStreamInternalUsesAggressiveRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    classifyFailure: classifyOpenAiLikeFailure,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeXcodeBestStreamInternalError({});
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
  assert.match(waiting?.error ?? '', /stream error: internal_error received from peer/u);
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
}

async function verifyXcodeBestStreamInternal429KeepsSmartRateRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    classifyFailure: classifyOpenAiLikeFailure,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeXcodeBestStreamInternalResponseStatusError({
          status: 429,
          retryAfter: '0.01',
        });
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=smart_rate'), true);
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=smart_rate'), true);
}

async function verifyXcodeBestMisreported403Nested429KeepsSmartRateRetry(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 3);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'xcode1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    classifyFailure: classifyOpenAiLikeFailure,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeXcodeBestMisreported403WithNested429Error();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'resolved'],
  );
  const waiting = retryEvents[0];
  const resolved = retryEvents[2];
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('strategy=smart_rate'), true);
  assert.equal(resolved?.display.summaryTextI18n.en?.includes('strategy=smart_rate'), true);
}

async function verifyAggressiveRetriesDowngradeToConservative(): Promise<void> {
  const providerConfig = buildPlainProviderConfig();
  const dialog = buildFakeDialog('en');
  const retryEventsPromise = readRetryEvents(dialog.id, 5);
  let attempts = 0;

  const result = await runLlmRequestWithRetry({
    dlg: dialog,
    provider: 'openai1',
    modelId: 'test',
    providerConfig,
    aggressiveRetryMaxRetries: 1,
    retryInitialDelayMs: 0,
    retryConservativeDelayMs: 0,
    retryBackoffMultiplier: 1,
    retryMaxDelayMs: 0,
    canRetry: () => true,
    doRequest: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw {
          status: 503,
          code: 'ECONNRESET',
          message: 'socket hang up',
        };
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  const retryEvents = await retryEventsPromise;
  assert.deepEqual(
    retryEvents.map((event) => event.phase),
    ['waiting', 'running', 'waiting', 'running', 'resolved'],
  );
  const firstWaiting = retryEvents[0];
  const secondWaiting = retryEvents[2];
  const finalResolved = retryEvents[4];
  assert.equal(firstWaiting?.display.summaryTextI18n.en?.includes('strategy=aggressive'), true);
  assert.equal(secondWaiting?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
  assert.equal(finalResolved?.display.summaryTextI18n.en?.includes('strategy=conservative'), true);
}

async function main(): Promise<void> {
  await verifyQuirkSessionStateMachine();
  await verifySingleRetryBypassesAggressiveBurstLimit();
  await verifyOpenAiCompatibleSameContextEmptyResponseQuirk();
  verifyVolcengineInvalidParameterQuirkUsesAggressiveRetry();
  verifyVolcengineInvalidParameterQuirkStaysOutOfRateLimit();
  verifyVolcengineInvalidParameterQuirkDoesNotGeneralizeAll400s();
  verifyKimiCodeHighRiskQuirkOffersTwoRuntimePromptRecoveries();
  verifyKimiCodeHighRiskQuirkOnlyHandlesRejected400HighRisk();
  await verifyRuntimeKimiCodeHighRiskRecoveryStopsAfterTwoRuntimePrompts();
  await verifyRuntimeVolcengineInvalidParameterQuirkRetriesRejectedFailure();
  await verifySameContextEmptyResponseQuirkResetsOnContextChange();
  await verifySameContextEmptyResponseRecoveryClosesLoopAcrossContextChange();
  await verifyRetryStoppedRecoveryHookSuppressesStoppedEvent();
  await verifyRetryStoppedRecoveryHookCanRefuseSecondRecovery();
  await verifySharedQuirkSessionRecoveryResetsAfterSuccess();
  await verifyResolvedRetryLifecycle();
  await verifyPolicyRetryLifecycleDisplay();
  await verifyAggressiveRetriesDowngradeToConservative();
  verifySmartRateClassification();
  verifyChatGptUsageLimitMessageJsonRetryDelay();
  verifySmartRateClassificationFromConcurrencyLimitMessage();
  verifyOpenAiProcessingFailureDefaultsToConservative();
  verifyOpenAiContextWindowExceededIsRejected();
  verifyOpenAiContextLengthExceededCodeIsRejected();
  verifyOpenAiTransportFailureWithStatusStaysAggressive();
  verifyPlainOpenAi403StaysRejected();
  verifyNested429WinsOverOuter403();
  verifyXcodeBestStreamInternal429ClassifiesAsSmartRate();
  verifyXcodeBestStreamInternalResponse429ClassifiesAsSmartRate();
  verifyNestedXcodeBestStreamInternalResponse429ClassifiesAsSmartRate();
  verifyXcodeBestStreamInternalIsNotGlobalClassifierAggressive();
  await verifyRuntimeDoesNotRetryContextWindowOverflow();
  await verifySmartRateRespectsProviderSuggestedDelayBeyondLocalMax();
  await verifyRuntimeDefaultsUnknownProviderFailuresToConservativeRetry();
  await verifyRuntimeStillRetriesPlainObjectTransportFailures();
  await verifyXcodeBestGatewayHtml502UsesConservativeRetry();
  await verifyXcodeBestAuthUnavailableUsesConservativeRetry();
  await verifyXcodeBestMisreported403UsesAggressiveRetry();
  await verifyXcodeBestStreamInternalUsesAggressiveRetry();
  await verifyXcodeBestStreamInternal429KeepsSmartRateRetry();
  await verifyXcodeBestMisreported403Nested429KeepsSmartRateRetry();
  await verifyXcodeBestUnexpectedEofUsesConservativeRetry();
  console.log('provider llm-quirks-retry-handling: PASS');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`provider llm-quirks-retry-handling: FAIL\n${message}`);
  process.exit(1);
});
