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
import { LlmRetryStoppedError, runLlmRequestWithRetry } from '../../main/llm/kernel-driver/runtime';

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
  assert.equal(
    session.onFailure({
      provider: 'xcode1',
      providerConfig,
      failure: emptyFailure,
      error: new Error('empty response'),
    }).kind,
    'give_up',
  );

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
}

async function verifySingleRetryBypassesDriverRetryLimit(): Promise<void> {
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
        maxRetries: 0,
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
      assert.equal(error.reason.display.summaryTextI18n.zh?.includes('请新开对话继续。'), true);
      assert.equal(error.reason.display.titleTextI18n.zh, '重试已停止');
      assert.match(error.reason.error, /LLM returned empty response/u);
      assert.match(error.message, /请新开对话继续/u);
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
  assert.equal(stopped.reason.display.titleTextI18n.zh, '重试已停止');
  assert.equal(stopped.reason.display.summaryTextI18n.zh?.includes('请新开对话继续。'), true);
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
    maxRetries: 0,
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
    maxRetries: 2,
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
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('backing off'), true);
  assert.equal(waiting?.display.summaryTextI18n.en?.includes('retry in 0ms'), false);
  assert.match(waiting?.error ?? '', /socket hang up/u);
  assert.equal(resolved?.display.titleTextI18n.en, 'Retry recovered');
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
    maxRetries: 1,
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

async function verifyRuntimeDoesNotInferProviderRateLimitWithoutWrapperClassifier(): Promise<void> {
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
        maxRetries: 1,
        retryInitialDelayMs: 0,
        retryConservativeDelayMs: 0,
        retryBackoffMultiplier: 1,
        retryMaxDelayMs: 0,
        canRetry: () => true,
        doRequest: async () => {
          attempts += 1;
          throw {
            status: 429,
            code: 'rate_limit_exceeded',
            message: 'RPM exceeded: requests per min exceeded',
            headers: {
              'retry-after': '1',
            },
          };
        },
      }),
    (error: unknown) => {
      assert.equal(
        attempts,
        1,
        'Expected runtime generic classifier to avoid provider-specific 429 retries',
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /RPM exceeded/u);
      return true;
    },
  );
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
    maxRetries: 1,
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
    maxRetries: 1,
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

async function main(): Promise<void> {
  await verifyQuirkSessionStateMachine();
  await verifySingleRetryBypassesDriverRetryLimit();
  await verifyResolvedRetryLifecycle();
  await verifyPolicyRetryLifecycleDisplay();
  verifySmartRateClassification();
  await verifySmartRateRespectsProviderSuggestedDelayBeyondLocalMax();
  await verifyRuntimeDoesNotInferProviderRateLimitWithoutWrapperClassifier();
  await verifyRuntimeStillRetriesPlainObjectTransportFailures();
  await verifyXcodeBestGatewayHtml502UsesConservativeRetry();
  console.log('provider llm-quirks-retry-handling: PASS');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`provider llm-quirks-retry-handling: FAIL\n${message}`);
  process.exit(1);
});
