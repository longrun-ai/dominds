import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  createLlmFailureQuirkHandlerSession,
  KIMI_CODE_API_QUIRK,
} from '../../main/llm/api-quirks';
import type { ProviderConfig } from '../../main/llm/client';
import { classifyOpenAiLikeFailure } from '../../main/llm/gen/failure-classifier';
import { DomindsPersistenceFileError } from '../../main/persistence-errors';
import {
  buildKimiCodeProviderConfig,
  buildOpenAiCompatibleSameContextEmptyProviderConfig,
  buildProviderConfig,
  buildVolcengineInvalidParameterProviderConfig,
  makeAuthUnavailableError,
  makeFailure,
  makeGatewayHtml502Error,
  makeKimiCodeHighRiskError,
  makeNestedXcodeBestStreamInternalResponseStatusError,
  makeUnexpectedEofError,
  makeVolcengineInvalidParameterError,
  makeVolcengineNestedInvalidParameterWith429Error,
  makeWrappedUnexpectedEofError,
  makeWrappedVolcengineInvalidParameterError,
  makeXcodeBestMisreported403WithNested429Error,
  makeXcodeBestStreamInternalError,
  makeXcodeBestStreamInternalResponseStatusError,
} from '../helpers/llm-retry-fixtures';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-retry-policy-');
let scenario = '';
let sequence = 0;
function observedSession(providerConfig: ProviderConfig) {
  const session = createLlmFailureQuirkHandlerSession(providerConfig);
  assert.ok(session);
  const decide = session.onFailure;
  session.onFailure = (input) => {
    const handling = decide(input);
    if (
      'message' in handling ||
      'summaryTextI18n' in handling ||
      ('recoveryAction' in handling && handling.recoveryAction?.kind === 'runtime_prompt_once')
    )
      evidence.record({
        id: 'policy-' + String(++sequence),
        scenario,
        businessValue:
          'Explain a scoped retry or bounded recovery decision accurately, without claiming success or inventing facts about the rejected request.',
        context: {
          provider: input.provider,
          input: inspect(input.error, { depth: null, getters: false, customInspect: false }),
          failure: JSON.stringify(input.failure),
          decision: handling.kind,
          scope:
            'Public quirk-session component. No live provider, actual follow-up generation or persisted driver stop is claimed.',
        },
        reviewQuestions: [
          'Do the actual diagnostics and any recovery prompt fit this supplied failure and the actual remaining action, including the exhausted budget?',
          'Does any prompt avoid unsupported claims about the request, the cause or permission to retry?',
        ],
        actualText: JSON.stringify(handling, null, 2),
      });
    return handling;
  };
  return session;
}
async function verifyQuirkSessionStateMachine(): Promise<void> {
  const providerConfig = buildProviderConfig();
  const session = observedSession(providerConfig);
  assert.ok(session, 'Expected xcode.best quirk handler session');

  const emptyFailure = makeFailure('DOMINDS_LLM_EMPTY_RESPONSE', 'empty response');
  const firstEmpty = session.onFailure({
    provider: 'xcode1',
    providerConfig,
    failure: emptyFailure,
    error: new Error('empty response'),
  });
  assert.equal(firstEmpty.kind, 'single_retry');

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

  assert.equal(gatewayHtmlHandling.retryStrategy, 'conservative');

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

  assert.equal(authUnavailableHandling.retryStrategy, 'conservative');

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

  assert.equal(unexpectedEofHandling.retryStrategy, 'conservative');

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

  assert.equal(providerHttpPathUnexpectedEofHandling.retryStrategy, 'conservative');
}

function verifyVolcengineInvalidParameterQuirkUsesAggressiveRetry(): void {
  const providerConfig = buildVolcengineInvalidParameterProviderConfig();
  const session = observedSession(providerConfig);
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

  assert.equal(handling.retryStrategy, 'aggressive');

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

  assert.equal(wrappedHandling.retryStrategy, 'aggressive');
}

function verifyVolcengineInvalidParameterQuirkStaysOutOfRateLimit(): void {
  const providerConfig = buildVolcengineInvalidParameterProviderConfig();
  const session = observedSession(providerConfig);
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
  const session = observedSession(providerConfig);
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
  const session = observedSession(providerConfig);
  assert.ok(session, 'Expected Kimi Code quirk handler session');

  const error = makeKimiCodeHighRiskError();
  const recoveryContents = [] as string[];
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

    assert.equal(handling.recoveryAction?.kind, 'runtime_prompt_once');

    recoveryContents.push(handling.recoveryAction.content);
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

  assert.equal(finalHandling.recoveryAction?.kind, 'none');
  assert.equal(recoveryContents.length, 2, 'Expected exactly two proposed recovery actions');
}

function verifyKimiCodeHighRiskQuirkOnlyHandlesRejected400HighRisk(): void {
  const providerConfig = buildKimiCodeProviderConfig();
  const session = observedSession(providerConfig);
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

async function verifySameContextEmptyResponseQuirkResetsOnContextChange(): Promise<void> {
  const providerConfig = buildOpenAiCompatibleSameContextEmptyProviderConfig();
  const session = observedSession(providerConfig);
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
  const session = observedSession(providerConfig);
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

  assert.ok(firstGiveUp.recoveryAction);
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

  assert.ok(secondGiveUp.recoveryAction);
  assert.equal(secondGiveUp.recoveryAction.kind, 'none');
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
async function main() {
  for (const test of [
    verifyQuirkSessionStateMachine,
    verifyVolcengineInvalidParameterQuirkUsesAggressiveRetry,
    verifyVolcengineInvalidParameterQuirkStaysOutOfRateLimit,
    verifyVolcengineInvalidParameterQuirkDoesNotGeneralizeAll400s,
    verifyKimiCodeHighRiskQuirkOffersTwoRuntimePromptRecoveries,
    verifyKimiCodeHighRiskQuirkOnlyHandlesRejected400HighRisk,
    verifySameContextEmptyResponseQuirkResetsOnContextChange,
    verifySameContextEmptyResponseRecoveryClosesLoopAcrossContextChange,
    verifySmartRateClassification,
    verifyChatGptUsageLimitMessageJsonRetryDelay,
    verifyPlainOpenAi403StaysRejected,
    verifyNested429WinsOverOuter403,
    verifyXcodeBestStreamInternal429ClassifiesAsSmartRate,
    verifyXcodeBestStreamInternalResponse429ClassifiesAsSmartRate,
    verifyNestedXcodeBestStreamInternalResponse429ClassifiesAsSmartRate,
    verifyXcodeBestStreamInternalIsNotGlobalClassifierAggressive,
    verifySmartRateClassificationFromConcurrencyLimitMessage,
    verifyOpenAiProcessingFailureDefaultsToConservative,
    verifyOpenAiContextWindowExceededIsRejected,
    verifyOpenAiContextLengthExceededCodeIsRejected,
    verifyOpenAiTransportFailureWithStatusStaysAggressive,
  ]) {
    scenario = test.name;
    await test();
  }
  await evidence.write();
  console.log('Provider classification and bounded quirk sessions: PASS');
}
// Keep unfinished async cases alive for the same 60s bound as the suite. Node can
// otherwise exit zero with a pending promise and no live handles.
const watchdog = setTimeout(() => {
  throw new Error('Retry case did not complete within 60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
