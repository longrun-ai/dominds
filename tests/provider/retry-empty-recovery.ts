import assert from 'node:assert/strict';
import { createLlmFailureQuirkHandlerSession } from '../../main/llm/api-quirks';
import { LlmRetryStoppedError } from '../../main/llm/kernel-driver/runtime';
import {
  buildOpenAiCompatibleSameContextEmptyProviderConfig,
  buildProviderConfig,
} from '../helpers/llm-retry-fixtures';
import {
  assertRetrySchedule,
  recordRetryEpisode,
  retryDialog,
  retryEpisode,
} from '../helpers/llm-retry-runtime';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-retry-empty-');
const empty = {
  status: 503,
  code: 'DOMINDS_LLM_EMPTY_RESPONSE',
  message: 'empty-provider-data-42ad',
};
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { diligencePushMax: 0 });
    const dialog = await retryDialog('zh');
    const provider = buildProviderConfig();
    const session = createLlmFailureQuirkHandlerSession(provider);
    assert.ok(session);
    // Three complete real bursts preserve the bounded recovery, refusal and success-reset
    // contracts. Their actual 3s quirk delays are not stubbed or replaced with sleeps.
    for (let round = 0; round < 3; round++) {
      if (round === 2) {
        const success = await retryEpisode(
          dialog,
          provider,
          async () => 'success-data-after-exhaustion',
          { quirkFailureHandlerSession: session },
        );
        assert.deepEqual(success.result, {
          kind: 'resolved',
          value: 'success-data-after-exhaustion',
        });
        assert.deepEqual(success.retries, []);
      }
      let recoveryCalls = 0;
      const episode = await retryEpisode(
        dialog,
        provider,
        async () => {
          throw empty;
        },
        {
          aggressiveRetryMaxRetries: 0,
          quirkFailureHandlerSession: session,
          onRetryStopped: (reason) => {
            recoveryCalls++;
            assert.equal(reason.recoveryAction.kind, round === 1 ? 'none' : 'diligence_push_once');
            return round === 0 ? 'continue' : 'stop';
          },
        },
      );
      assert.equal(episode.requestTimes.length, 5);
      assert.equal(recoveryCalls, 1);
      assert.ok(
        episode.result.kind === 'failed' && episode.result.error instanceof LlmRetryStoppedError,
      );
      assert.equal(
        episode.result.error.reason.recoveryAction.kind,
        round === 1 ? 'none' : 'diligence_push_once',
      );
      assert.deepEqual(
        episode.retries.map((event) => event.phase),
        [
          ...Array.from({ length: 4 }).flatMap(() => ['waiting', 'running']),
          ...(round === 0 ? [] : ['stopped']),
        ],
      );
      assertRetrySchedule(episode, [3000, 3000, 3000, 3000]);
      const stopped = episode.retries.filter((event) => event.phase === 'stopped');
      if (round > 0) assert.equal(stopped[0]?.continueEnabled, false);
      const errors = episode.events.filter((event) => event.type === 'stream_error_evt');
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.error, empty.message);
      recordRetryEpisode(evidence, `empty-shared-recovery-${round}`, episode, {
        input: JSON.stringify(empty),
        reserved: round === 0,
        afterSuccess: round === 2,
        ordinaryAggressiveBudget: 0,
      });
    }
    const same = buildOpenAiCompatibleSameContextEmptyProviderConfig();
    const sameDialog = await retryDialog('en');
    const episode = await retryEpisode(
      sameDialog,
      same,
      async () => {
        throw empty;
      },
      { aggressiveRetryMaxRetries: 0 },
    );
    assert.equal(episode.requestTimes.length, 5);
    assert.ok(
      episode.result.kind === 'failed' && episode.result.error instanceof LlmRetryStoppedError,
    );
    assert.equal(episode.result.error.reason.recoveryAction.kind, 'diligence_push_once');
    assert.deepEqual(
      episode.retries.map((event) => event.phase),
      [...Array.from({ length: 4 }).flatMap(() => ['waiting', 'running']), 'stopped'],
    );
    assertRetrySchedule(episode, [3000, 3000, 3000, 3000]);
    recordRetryEpisode(evidence, 'same-context-empty-stop', episode, {
      input: JSON.stringify(empty),
      ordinaryAggressiveBudget: 0,
    });
    await evidence.write();
  });
  console.log('Real empty retry bursts, one recovery and success reset: PASS');
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
