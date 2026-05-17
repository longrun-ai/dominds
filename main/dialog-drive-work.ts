import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';

import { getRecoverableGenerationRunState } from './dialog-generation-run';

export type DialogLatestSnapshot = DialogLatestFile | null;

export function hasDurableDriveWork(latest: DialogLatestSnapshot): boolean {
  if (!latest) {
    return false;
  }
  const replyDelivery = latest.replyDelivery;
  if (
    replyDelivery &&
    (replyDelivery.status === 'pending' || replyDelivery.toolResultStatus === 'pending')
  ) {
    return true;
  }
  if (latest.sideDialogFinalResponse !== undefined) {
    return false;
  }
  return (
    (latest.nextStep?.triggers.length ?? 0) > 0 ||
    getRecoverableGenerationRunState(latest) !== undefined
  );
}
