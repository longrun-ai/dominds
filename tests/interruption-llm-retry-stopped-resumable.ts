import assert from 'node:assert/strict';

import type { DialogRetryDisplay } from '@longrun-ai/kernel/types/display-state';
import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';
import { isDialogLatestResumable, isStoppedReasonResumable } from '../main/dialog-display-state';

const display: DialogRetryDisplay = {
  titleTextI18n: {
    zh: '重试已停止',
    en: 'Retry stopped',
  },
  summaryTextI18n: {
    zh: '人工继续后，很可能继续重试仍然无法有真实进展。',
    en: 'Even after manual continuation, further retries are still likely to make no real progress.',
  },
};

const reason = {
  kind: 'llm_retry_stopped',
  error: 'LLM returned empty response',
  display,
  recoveryAction: { kind: 'none' },
} as const;

const resumableLatest: DialogLatestFile = {
  currentCourse: 1,
  lastModified: new Date().toISOString(),
  status: 'active',
  displayState: {
    kind: 'stopped',
    reason,
    continueEnabled: true,
  },
  executionMarker: {
    kind: 'interrupted',
    reason,
  },
};

const transientLatest: DialogLatestFile = {
  currentCourse: 1,
  lastModified: new Date().toISOString(),
  status: 'active',
  displayState: {
    kind: 'stopped',
    reason,
    continueEnabled: false,
  },
  executionMarker: {
    kind: 'interrupted',
    reason,
  },
};

assert.equal(isStoppedReasonResumable(reason), true);
assert.equal(isDialogLatestResumable(resumableLatest), true);
assert.equal(
  isDialogLatestResumable(transientLatest),
  false,
  'llm_retry_stopped should only become resumable after the finalized stopped state enables Continue',
);

console.log('interruption-llm-retry-stopped-resumable: PASS');
