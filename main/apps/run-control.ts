import type {
  DomindsAppRunControlContext,
  DomindsAppRunControlResult,
} from '@longrun-ai/kernel/app-host-contract';
import { createLogger } from '../log';
import { getAppDialogRunControlMeta, listAppDialogRunControls } from './dialog-run-controls';
import { waitForAppsHostClient } from './runtime';

const log = createLogger('apps-run-control');

export async function applyAppDialogRunControl(params: {
  controlId: string;
  payload: DomindsAppRunControlContext;
}): Promise<DomindsAppRunControlResult> {
  const controlId = params.controlId.trim();
  if (controlId === '') {
    throw new Error('dialog run control id cannot be empty');
  }
  const meta = getAppDialogRunControlMeta(controlId);
  if (!meta) {
    throw new Error(`Unknown dialog run control: ${controlId}`);
  }
  const hostClient = await waitForAppsHostClient();
  return await hostClient.applyRunControl(controlId, params.payload);
}

export async function applyRegisteredAppDialogRunControls(
  payload: DomindsAppRunControlContext,
): Promise<DomindsAppRunControlResult> {
  for (const control of listAppDialogRunControls()) {
    let result: DomindsAppRunControlResult;
    try {
      result = await applyAppDialogRunControl({
        controlId: control.id,
        payload,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn('App dialog run control failed; continuing without this app control', err, {
        controlId: control.id,
        dialogId: payload.dialog.selfId,
        rootId: payload.dialog.rootId,
        agentId: payload.agentId,
        taskDocPath: payload.taskDocPath,
        source: payload.source,
      });
      continue;
    }
    if (result.kind === 'reject') {
      return result;
    }
  }
  return { kind: 'continue' };
}
