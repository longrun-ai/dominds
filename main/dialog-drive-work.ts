import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';

import { getRecoverableGenerationRunState } from './dialog-generation-run';

export type DialogLatestSnapshot = DialogLatestFile | null;

function hasResultArrivalTrigger(latest: DialogLatestFile): boolean {
  return latest.nextStep.triggers.some((trigger) => trigger.kind === 'result_arrival');
}

export function hasRecoverableGenerationBeyondFinalResponse(latest: DialogLatestFile): boolean {
  if (getRecoverableGenerationRunState(latest) === undefined) {
    return false;
  }
  const finalResponse = latest.sideDialogFinalResponse;
  if (finalResponse === undefined) {
    return true;
  }
  return (
    latest.pendingRuntimePrompt !== undefined ||
    (latest.latestAssignmentAnchor !== undefined &&
      latest.latestAssignmentAnchor.callId !== finalResponse.callId)
  );
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
  if (latest.pendingRuntimePrompt !== undefined) {
    return true;
  }
  if (hasRecoverableGenerationBeyondFinalResponse(latest)) {
    return true;
  }
  if (latest.sideDialogFinalResponse !== undefined) {
    return hasResultArrivalTrigger(latest);
  }
  return latest.nextStep.triggers.length > 0;
}
