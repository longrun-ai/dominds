import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';
import type { MainDialog } from '../../main/dialog';
import type { ProviderConfig } from '../../main/llm/client';
import {
  LlmRequestFailedError,
  LlmRetryStoppedError,
  runLlmRequestWithRetry,
} from '../../main/llm/kernel-driver/runtime';
import { createMainDialog, waitFor } from '../kernel-driver/helpers';
import { recordDialogEvents } from './dialog-events';
import type { semanticEvidenceCollector } from './semantic-evidence';

export async function retryDialog(language: LanguageCode): Promise<MainDialog> {
  const dialog = await createMainDialog();
  dialog.setLastUserLanguageCode(language);
  return dialog;
}
type Params = Parameters<typeof runLlmRequestWithRetry<string>>[0];
export async function retryEpisode(
  dialog: MainDialog,
  providerConfig: ProviderConfig,
  doRequest: () => Promise<string>,
  options: Partial<Omit<Params, 'dlg' | 'providerConfig' | 'doRequest'>> = {},
) {
  const recording = recordDialogEvents(dialog);
  await dialog.notifyGeneratingStart();
  const course = dialog.currentCourse,
    genseq = dialog.activeGenSeq;
  const requestTimes: number[] = [],
    failureTimes: number[] = [],
    retryTimes: number[] = [];
  let result: { kind: 'resolved'; value: string } | { kind: 'failed'; error: unknown } | undefined;
  try {
    const value = await runLlmRequestWithRetry({
      provider: `retry-fixture-${dialog.id.selfId}`,
      modelId: 'test',
      aggressiveRetryMaxRetries: 1,
      retryInitialDelayMs: 0,
      retryConservativeDelayMs: 0,
      retryBackoffMultiplier: 1,
      retryMaxDelayMs: 0,
      canRetry: () => true,
      ...options,
      dlg: dialog,
      providerConfig,
      onRetry: async () => {
        retryTimes.push(Date.now());
        await options.onRetry?.();
      },
      doRequest: async () => {
        requestTimes.push(Date.now());
        try {
          return await doRequest();
        } catch (error) {
          failureTimes.push(Date.now());
          throw error;
        }
      },
    });
    result = { kind: 'resolved', value };
  } catch (error) {
    result = { kind: 'failed', error };
  } finally {
    await dialog.notifyGeneratingFinish();
  }
  const events = await recording.finish();
  const retries = events.filter(
    (event): event is Extract<TypedDialogEvent, { type: 'llm_retry_evt' }> =>
      event.type === 'llm_retry_evt',
  );
  for (const event of retries) {
    assert.equal(event.dialog.selfId, dialog.id.selfId);
    assert.equal(event.course, course);
    assert.equal(event.genseq, genseq);
  }
  // Observe physical storage instead of sleeping for the write-back debounce.
  await waitFor(
    async () => {
      try {
        const latest = yaml.parse(
          await fs.readFile(path.join('.dialogs/run', dialog.id.selfId, 'latest.yaml'), 'utf8'),
        );
        return latest.generating === false && latest.generationRunState?.kind === 'closed';
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return false;
        throw error;
      }
    },
    2000,
    'real generation to close on disk',
  );
  assert.ok(result);
  return { result, retries, events, requestTimes, failureTimes, retryTimes };
}
export type RetryEpisode = Awaited<ReturnType<typeof retryEpisode>>;

export function assertRetrySchedule(episode: RetryEpisode, expectedDelayMs: readonly number[]) {
  const waiting = episode.retries.filter((event) => event.phase === 'waiting');
  assert.equal(waiting.length, expectedDelayMs.length);
  assert.equal(episode.retryTimes.length, expectedDelayMs.length);
  for (const [index, delay] of expectedDelayMs.entries()) {
    const event = waiting[index]!;
    // The runtime computes its deadline between the failure and the retry hook. These
    // bounds observe the scheduled delay without judging text or imposing CPU-speed limits.
    assert.ok(event.nextRetryAtMs >= episode.failureTimes[index]! + delay);
    assert.ok(event.nextRetryAtMs <= episode.retryTimes[index]! + delay);
    if (episode.requestTimes[index + 1] !== undefined)
      assert.ok(episode.requestTimes[index + 1]! >= event.nextRetryAtMs - 1);
  }
}
export function recordRetryEpisode(
  evidence: ReturnType<typeof semanticEvidenceCollector>,
  id: string,
  episode: RetryEpisode,
  context: Record<string, string | number | boolean>,
) {
  const failure = episode.result.kind === 'failed' ? episode.result.error : undefined;
  evidence.record({
    id,
    scenario: id,
    businessValue:
      'Explain the observed retry, recovery reservation or final refusal accurately so a human or executing agent can choose a useful next action.',
    context: {
      ...context,
      attempts: episode.requestTimes.length,
      phases: JSON.stringify(episode.retries.map((event) => event.phase)),
      scope:
        'Real request-retry runtime, Dialog, events, timers and disk generation lifetime; controlled request callback. Component caller only: no actual provider, backend restart or final driver stop projection unless separately stated.',
    },
    reviewQuestions: [
      'Do the actual UI guidance and stop detail fit this failure, selected schedule and remaining recovery action, without claiming unexecuted progress?',
      'Are the two language versions consistent and is any recovery instruction grounded in the supplied request facts?',
    ],
    actualText: JSON.stringify(
      {
        retryEvents: episode.retries,
        stop:
          failure instanceof LlmRetryStoppedError
            ? { message: failure.message, reason: failure.reason }
            : failure instanceof LlmRequestFailedError
              ? {
                  message: failure.message,
                  detail: failure.detail,
                  i18nStopReason: failure.i18nStopReason,
                }
              : undefined,
      },
      null,
      2,
    ),
  });
}
