import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { LlmRetryEvent } from '@longrun-ai/kernel/types/dialog';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { Dialog, DialogID } from '../../main/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';
import {
  createLlmFailureQuirkHandlerSession,
  type LlmFailureSummary,
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

function makeFailure(code: string, message: string): LlmFailureSummary {
  return {
    kind: 'retriable',
    code,
    message,
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
  await verifyRetryStoppedRecoveryHookSuppressesStoppedEvent();
  await verifyRetryStoppedRecoveryHookCanRefuseSecondRecovery();
  await verifySharedQuirkSessionRecoveryResetsAfterSuccess();
  await verifyResolvedRetryLifecycle();
  await verifyPolicyRetryLifecycleDisplay();
  await verifyAggressiveRetriesDowngradeToConservative();
  verifySmartRateClassification();
  verifySmartRateClassificationFromConcurrencyLimitMessage();
  verifyOpenAiProcessingFailureDefaultsToConservative();
  verifyOpenAiContextWindowExceededIsRejected();
  verifyOpenAiContextLengthExceededCodeIsRejected();
  verifyOpenAiTransportFailureWithStatusStaysAggressive();
  verifyPlainOpenAi403StaysRejected();
  await verifyRuntimeDoesNotRetryContextWindowOverflow();
  await verifySmartRateRespectsProviderSuggestedDelayBeyondLocalMax();
  await verifyRuntimeDefaultsUnknownProviderFailuresToConservativeRetry();
  await verifyRuntimeStillRetriesPlainObjectTransportFailures();
  await verifyXcodeBestGatewayHtml502UsesConservativeRetry();
  await verifyXcodeBestAuthUnavailableUsesConservativeRetry();
  await verifyXcodeBestMisreported403UsesAggressiveRetry();
  await verifyXcodeBestUnexpectedEofUsesConservativeRetry();
  console.log('provider llm-quirks-retry-handling: PASS');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`provider llm-quirks-retry-handling: FAIL\n${message}`);
  process.exit(1);
});
