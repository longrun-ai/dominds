import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createLlmFailureQuirkHandlerSession } from '../../main/llm/api-quirks';
import { classifyOpenAiLikeFailure } from '../../main/llm/gen/failure-classifier';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { LlmRequestFailedError, LlmRetryStoppedError } from '../../main/llm/kernel-driver/runtime';
import { DialogPersistence } from '../../main/persistence';
import { listProblems } from '../../main/problems';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { recordDialogEvents } from '../helpers/dialog-events';
import {
  buildKimiCodeProviderConfig,
  buildPlainProviderConfig,
  buildProviderConfig,
  buildVolcengineInvalidParameterProviderConfig,
  makeAuthUnavailableError,
  makeGatewayHtml502Error,
  makeKimiCodeHighRiskError,
  makeVolcengineInvalidParameterError,
  makeWrappedUnexpectedEofError,
  makeXcodeBestMisreported403Error,
  makeXcodeBestMisreported403WithNested429Error,
  makeXcodeBestStreamInternalError,
  makeXcodeBestStreamInternalResponseStatusError,
} from '../helpers/llm-retry-fixtures';
import {
  assertRetrySchedule,
  recordRetryEpisode,
  retryDialog,
  retryEpisode,
} from '../helpers/llm-retry-runtime';
import { messageProvider } from '../helpers/message-provider';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeStandardMinds,
} from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-retry-lifecycle-');
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { diligencePushMax: 0 });
    const plain = buildPlainProviderConfig(),
      xcode = buildProviderConfig();
    const transport = { status: 503, code: 'ECONNRESET', message: 'socket hang up' };
    const rows = [
      {
        id: 'quirk-single-resolved',
        config: xcode,
        error: { status: 503, code: 'DOMINDS_LLM_EMPTY_RESPONSE', message: 'temporary-empty-data' },
        delays: [3000],
      },
      {
        id: 'volc-rejected-transient',
        config: buildVolcengineInvalidParameterProviderConfig(),
        error: makeVolcengineInvalidParameterError(),
        delays: [20],
        classifier: classifyOpenAiLikeFailure,
      },
      {
        id: 'plain-aggressive',
        config: plain,
        error: transport,
        delays: [20],
        classifier: classifyOpenAiLikeFailure,
      },
      { id: 'aggressive-downgrade', config: plain, error: transport, delays: [20, 80] },
      {
        id: 'unknown-coded-conservative',
        config: plain,
        error: {
          status: 429,
          code: 'rate_limit_exceeded',
          message: 'RPM exceeded',
          headers: { 'retry-after': '1' },
        },
        delays: [80],
      },
      {
        id: 'plain-object-transport',
        config: plain,
        error: { message: 'fetch failed' },
        delays: [20],
      },
      { id: 'xcode-html-502', config: xcode, error: makeGatewayHtml502Error(), delays: [80] },
      { id: 'xcode-eof', config: xcode, error: makeWrappedUnexpectedEofError(), delays: [80] },
      {
        id: 'xcode-auth-unavailable',
        config: xcode,
        error: makeAuthUnavailableError(),
        delays: [80],
      },
      {
        id: 'xcode-misreported-403',
        config: xcode,
        error: makeXcodeBestMisreported403Error(),
        delays: [20],
      },
      {
        id: 'xcode-stream-internal',
        config: xcode,
        error: makeXcodeBestStreamInternalError({}),
        delays: [20],
        classifier: classifyOpenAiLikeFailure,
      },
      {
        id: 'xcode-stream-429',
        config: xcode,
        error: makeXcodeBestStreamInternalResponseStatusError({ status: 429, retryAfter: '0.11' }),
        delays: [110],
        classifier: classifyOpenAiLikeFailure,
      },
      {
        id: 'xcode-nested-429-over-403',
        config: xcode,
        error: {
          ...makeXcodeBestMisreported403WithNested429Error(),
          response: { status: 429, headers: { 'retry-after': '0.11' } },
        },
        delays: [110],
        classifier: classifyOpenAiLikeFailure,
      },
    ];
    for (const row of rows) {
      const dialog = await retryDialog('en');
      let attempts = 0;
      const episode = await retryEpisode(
        dialog,
        row.config,
        async () => {
          if (++attempts <= row.delays.length) throw row.error;
          return 'response-data-61a8';
        },
        {
          aggressiveRetryMaxRetries: 1,
          retryInitialDelayMs: 20,
          retryConservativeDelayMs: 80,
          retryMaxDelayMs: 80,
          classifyFailure: row.classifier,
        },
      );
      assert.deepEqual(episode.result, { kind: 'resolved', value: 'response-data-61a8' });
      assert.equal(attempts, row.delays.length + 1);
      assert.deepEqual(
        episode.retries.map((event) => event.phase),
        [...row.delays.flatMap(() => ['waiting', 'running']), 'resolved'],
      );
      assertRetrySchedule(episode, row.delays);
      assert.equal(episode.events.filter((event) => event.type === 'stream_error_evt').length, 0);
      recordRetryEpisode(evidence, row.id, episode, {
        input: inspect(row.error),
        expectedDelays: JSON.stringify(row.delays),
      });
    }
    // The provider-suggested wait exceeds the configured local cap, and the real timer respects it.
    const rateDialog = await retryDialog('en');
    let rateAttempts = 0;
    const rate = await retryEpisode(
      rateDialog,
      plain,
      async () => {
        if (++rateAttempts === 1)
          throw {
            status: 429,
            code: 'rate_limit_exceeded',
            message: 'RPM exceeded',
            headers: { 'retry-after': '0.03' },
          };
        return 'rate-data';
      },
      { classifyFailure: classifyOpenAiLikeFailure, retryMaxDelayMs: 0 },
    );
    assert.deepEqual(rate.result, { kind: 'resolved', value: 'rate-data' });
    assertRetrySchedule(rate, [30]);
    recordRetryEpisode(evidence, 'rate-delay-over-local-cap', rate, {
      localCap: 0,
      providerDelay: 30,
    });

    const rejectedDialog = await retryDialog('en');
    const detail =
      'Your input exceeds the context window of this model. Please adjust your input and try again.';
    const rejected = await retryEpisode(
      rejectedDialog,
      plain,
      async () => {
        throw new Error(detail);
      },
      { classifyFailure: classifyOpenAiLikeFailure },
    );
    assert.equal(rejected.requestTimes.length, 1);
    assert.ok(
      rejected.result.kind === 'failed' && rejected.result.error instanceof LlmRequestFailedError,
    );
    assert.equal(rejected.result.error.detail, detail);
    assert.deepEqual(rejected.retries, []);
    const errors = rejected.events.filter((event) => event.type === 'stream_error_evt');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error, detail);
    const problemId = `llm/provider_rejected/${rejectedDialog.id.valueOf()}`;
    assert.equal(listProblems({ problemId }).length, 1);
    recordRetryEpisode(evidence, 'deterministic-context-rejection', rejected, {
      input: detail,
      attempts: 1,
    });
    const success = await retryEpisode(rejectedDialog, plain, async () => 'new-request-data');
    assert.equal(success.result.kind, 'resolved');
    assert.equal(listProblems({ problemId }).length, 0);

    const stoppedDialog = await retryDialog('zh');
    const stopped = await retryEpisode(
      stoppedDialog,
      plain,
      async () => {
        throw transport;
      },
      { canRetry: () => false },
    );
    assert.ok(
      stopped.result.kind === 'failed' && stopped.result.error instanceof LlmRetryStoppedError,
    );
    assert.deepEqual(
      stopped.retries.map((event) => event.phase),
      ['stopped'],
    );
    const transient = stopped.retries[0];
    assert.ok(transient?.phase === 'stopped');
    assert.equal(transient.continueEnabled, false);
    assert.equal(transient.reason.recoveryAction.kind, 'none');
    recordRetryEpisode(evidence, 'retry-disallowed', stopped, {
      canRetry: false,
      input: JSON.stringify(transport),
    });

    const cancelDialog = await retryDialog('en');
    const controller = new AbortController();
    const cancelled = await retryEpisode(
      cancelDialog,
      plain,
      async () => {
        throw transport;
      },
      {
        abortSignal: controller.signal,
        onRetry: () => controller.abort(),
        retryInitialDelayMs: 100,
        retryMaxDelayMs: 100,
      },
    );
    assert.equal(cancelled.result.kind, 'failed');
    assert.equal(controller.signal.aborted, true);
    assert.equal(cancelled.requestTimes.length, 1);
    assert.deepEqual(
      cancelled.retries.map((event) => event.phase),
      ['waiting'],
    );

    const kimi = buildKimiCodeProviderConfig();
    const kimiDialog = await retryDialog('zh');
    const session = createLlmFailureQuirkHandlerSession(kimi);
    assert.ok(session);
    for (let index = 0; index < 3; index++) {
      let reserved = 0;
      const episode = await retryEpisode(
        kimiDialog,
        kimi,
        async () => {
          throw makeKimiCodeHighRiskError();
        },
        {
          classifyFailure: classifyOpenAiLikeFailure,
          quirkFailureHandlerSession: session,
          onRetryStopped: (reason) => {
            if (reason.recoveryAction.kind === 'runtime_prompt_once') {
              reserved++;
              return 'continue';
            }
            return 'stop';
          },
        },
      );
      assert.ok(
        episode.result.kind === 'failed' && episode.result.error instanceof LlmRetryStoppedError,
      );
      assert.equal(episode.requestTimes.length, 1);
      assert.equal(reserved, index < 2 ? 1 : 0);
      assert.deepEqual(
        episode.retries.map((event) => event.phase),
        index < 2 ? [] : ['stopped'],
      );
      recordRetryEpisode(evidence, `kimi-reservation-${index}`, episode, {
        reserved,
        sharedSession: true,
      });
    }
    // Drive the actual bounded prompt recovery, not only the callback reservation contract.
    const apiType = 'test-kimi-retry-boundary';
    await writeStandardMinds(rtws, {
      providerApiType: apiType,
      providerApiQuirks: ['kimi-code'],
      diligencePushMax: 0,
    });
    const requests: { msgId: string; content: string }[][] = [];
    const expectedError = makeKimiCodeHighRiskError();
    const generator = messageProvider(apiType, ({ context }) => {
      requests.push(
        context
          .filter((message) => message.type === 'prompting_msg')
          .map((message) => ({ msgId: message.msgId, content: message.content })),
      );
      throw expectedError;
    });
    const classify = generator.classifyFailure!;
    generator.classifyFailure = (error) =>
      error === expectedError ? classifyOpenAiLikeFailure(error) : classify(error);
    registerLlmGenerator(generator);
    try {
      setWorkLanguage('en');
      const dialog = await createMainDialog();
      dialog.disableDiligencePush = true;
      const trace = recordDialogEvents(dialog);
      await driveDialogStream(
        dialog,
        makeUserPrompt(
          'Inspect the supplied fixture data and report the observed result.',
          'kimi-initial-data',
        ),
        true,
      );
      generator.assertNoErrors();
      const events = await trace.finish();
      assert.equal(requests.length, 3);
      const initial = requests[0]!.filter((message) => message.msgId === 'kimi-initial-data');
      assert.equal(initial.length, 1);
      assert.equal(
        initial[0]?.content,
        'Inspect the supplied fixture data and report the observed result.',
      );
      const stored = await DialogPersistence.readCourseEvents(dialog.id, 1, 'running');
      const runtimePrompts = stored.filter(
        (event) => event.type === 'human_text_record' && event.origin === 'runtime',
      );
      assert.equal(runtimePrompts.length, 2);
      for (const [i, prompt] of runtimePrompts.entries()) {
        assert.ok(prompt.type === 'human_text_record');
        const delivered = requests[i + 1]!.filter((message) => message.msgId === prompt.msgId);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]?.content, prompt.content);
      }
      const latest = await DialogPersistence.loadDialogLatest(dialog.id, 'running');
      assert.ok(
        latest?.displayState?.kind === 'stopped' &&
          latest.displayState.reason.kind === 'llm_retry_stopped',
      );
      assert.equal(latest.displayState.reason.recoveryAction.kind, 'none');
      assert.equal(latest.displayState.continueEnabled, true);
      assert.equal(
        events.filter((e) => e.type === 'llm_retry_evt' && e.phase === 'stopped').length,
        1,
      );
      const errors = events.filter((event) => event.type === 'stream_error_evt');
      assert.equal(errors.length, 3);
      assert.ok(errors.every((event) => event.error === expectedError.message));
      assert.equal(latest.generating, false);
      assert.equal(latest.generationRunState?.kind, 'closed');
      evidence.record({
        id: 'kimi-actual-driver',
        scenario:
          'Three controlled high-risk rejections in the real driver consume two runtime inputs then finalize a stopped dialog.',
        businessValue:
          'Bound context recovery and preserve an honest, actionable stop after it is exhausted.',
        context: {
          attempts: requests.length,
          runtimePrompts: runtimePrompts.length,
          input: 'Inspect the supplied fixture data and report the observed result.',
          scope:
            'Real driver, persisted inputs and terminal projection with controlled provider; no live provider or browser.',
        },
        reviewQuestions: [
          'Are the actual recovery inputs grounded in the request, and does the final display accurately describe exhausted recovery without promising another automatic attempt?',
        ],
        actualText: JSON.stringify({ runtimePrompts, displayState: latest.displayState }, null, 2),
      });
    } finally {
      unregisterLlmGenerator(apiType);
    }
    await evidence.write();
  });
  console.log('Real retry request lifecycle and bounded driver recovery: PASS');
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
