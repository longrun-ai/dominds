import type {
  DomindsAppRunControlContext,
  DomindsAppRunControlResult,
} from '../apps-host/app-host-contract';
import { getAppDialogRunControlMeta } from './dialog-run-controls';
import { getAppsHostClient } from './runtime';

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
  const hostClient = getAppsHostClient();
  return await hostClient.applyRunControl(controlId, params.payload);
}
