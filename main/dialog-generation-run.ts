import type { DialogGenerationRunState, DialogLatestFile } from '@longrun-ai/kernel/types/storage';

export function getRecoverableGenerationRunState(
  latest: DialogLatestFile | null | undefined,
): Extract<DialogGenerationRunState, { kind: 'open' }> | undefined {
  if (!latest) {
    return undefined;
  }
  if (latest.generationRunState?.kind !== 'open') {
    return undefined;
  }
  const marker = latest.executionMarker;
  if (!marker) {
    return latest.generationRunState;
  }
  if (marker.kind === 'dead') {
    return undefined;
  }
  if (
    marker.kind !== 'interrupted' ||
    marker.reason.kind === 'pending_runtime_prompt' ||
    marker.reason.kind === 'pending_reply_obligation'
  ) {
    return latest.generationRunState;
  }
  return undefined;
}
