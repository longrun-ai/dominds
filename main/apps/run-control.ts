import type {
  DomindsAppRunControlBlock,
  DomindsAppRunControlContext,
  DomindsAppRunControlResult,
} from '@longrun-ai/kernel/app-host-contract';
import { createLogger } from '../log';
import { getAppDialogRunControlMeta, listAppDialogRunControls } from './dialog-run-controls';
import { waitForAppsHostClient } from './runtime';

const log = createLogger('apps-run-control');

function formatOwnerRef(block: DomindsAppRunControlBlock): string {
  const owner = block.owner;
  if (owner.kind === 'human') return 'the human approver';
  return owner.memberId;
}

function formatTargetRef(block: DomindsAppRunControlBlock): string {
  return block.targetRef.title ?? block.targetRef.id;
}

function canProjectAwaitAppAction(
  block: Extract<DomindsAppRunControlBlock, { blockKind: 'await_app_action' }>,
): boolean {
  if (block.actionClass === 'select') {
    return Array.isArray(block.optionsSummary) && block.optionsSummary.length > 0;
  }
  return true;
}

function projectAppActionLabel(
  block: Extract<DomindsAppRunControlBlock, { blockKind: 'await_app_action' }>,
): string {
  if (block.actionClass === 'input') return 'Provide information';
  if (block.actionClass === 'confirm') return 'Confirm and continue';
  return 'Choose an option';
}

export function renderAppRunControlBlockForPreDrive(block: DomindsAppRunControlBlock): string {
  if (block.blockKind === 'await_members') {
    const waitingList = block.waitingFor.map((entry) => entry.memberId).join(', ');
    return `Blocked while waiting for ${waitingList} on ${formatTargetRef(block)}. ${block.promptSummary}`;
  }
  if (block.blockKind === 'await_human') {
    const suffix = block.question ?? block.promptSummary;
    return `Blocked: human input is required for ${formatTargetRef(block)}. ${suffix}`;
  }
  if (!canProjectAwaitAppAction(block)) {
    return `View problem details. ${block.title}: ${block.promptSummary}`;
  }
  return `${projectAppActionLabel(block)} via ${formatOwnerRef(block)} for ${formatTargetRef(block)}. ${block.promptSummary}`;
}

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
  let recoveryAction: Extract<DomindsAppRunControlResult, { kind: 'allow' }>['recoveryAction'];
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
    if (result.kind === 'block') {
      return result;
    }
    if (recoveryAction === undefined && result.recoveryAction !== undefined) {
      recoveryAction = result.recoveryAction;
    }
  }
  return recoveryAction ? { kind: 'allow', recoveryAction } : { kind: 'allow' };
}
