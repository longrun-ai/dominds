import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';

import { getRecoverableGenerationRunState } from './dialog-generation-run';

export type DialogLatestSnapshot = DialogLatestFile | null;

function hasResultArrivalTrigger(latest: DialogLatestFile): boolean {
  return latest.nextStep.triggers.some((trigger) => trigger.kind === 'result_arrival');
}

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
    return hasResultArrivalTrigger(latest);
  }
  return (
    latest.nextStep.triggers.length > 0 || getRecoverableGenerationRunState(latest) !== undefined
  );
}
