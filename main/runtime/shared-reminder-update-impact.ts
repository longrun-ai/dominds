import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import type { Dialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { formatSharedReminderUpdateImpactNotice } from './driver-messages';

export type SharedReminderUpdateImpactScope = 'task' | 'agent' | 'runtime';

export type SharedReminderUpdateImpactDispatch = Readonly<{
  scope: SharedReminderUpdateImpactScope;
  peerDialogCount: number;
  dispatchedDialogCount: number;
}>;

function sharedReminderUpdateImpactsDialog(args: {
  scope: SharedReminderUpdateImpactScope;
  updater: Dialog;
  candidate: Dialog;
}): boolean {
  if (args.candidate.id.equals(args.updater.id)) {
    return false;
  }
  if (args.candidate.agentId !== args.updater.agentId) {
    return false;
  }
  return args.scope === 'task' ? args.candidate.taskDocPath === args.updater.taskDocPath : true;
}

function collectSharedReminderUpdatePeerDialogs(args: {
  updater: Dialog;
  scope: SharedReminderUpdateImpactScope;
}): Dialog[] {
  const peers: Dialog[] = [];
  for (const candidate of globalDialogRegistry.getLoadedActiveDialogsForRuntimeInspection()) {
    if (
      sharedReminderUpdateImpactsDialog({
        scope: args.scope,
        updater: args.updater,
        candidate,
      })
    ) {
      peers.push(candidate);
    }
  }
  return peers;
}

async function queueSharedReminderUpdateImpactPrompt(args: {
  targetDialog: Dialog;
  reminderId: string;
  scope: SharedReminderUpdateImpactScope;
  language: LanguageCode;
}): Promise<void> {
  await args.targetDialog.queueRuntimeGuidePrompt({
    prompt: formatSharedReminderUpdateImpactNotice(args.language, {
      reminderId: args.reminderId,
      scope: args.scope,
      audience: 'peer',
    }),
    msgId: generateShortId(),
    grammar: 'markdown',
    userLanguageCode: args.language,
    skipTaskdoc: true,
  });
  globalDialogRegistry.queueRootDrive(args.targetDialog.id.rootId, {
    source: 'shared_reminder_update_impact',
    reason: `reminder_id:${args.reminderId}`,
  });
}

export async function dispatchSharedReminderUpdateImpact(args: {
  updater: Dialog;
  reminderId: string;
  scope: SharedReminderUpdateImpactScope;
  language: LanguageCode;
}): Promise<SharedReminderUpdateImpactDispatch | undefined> {
  const peerDialogs = collectSharedReminderUpdatePeerDialogs({
    updater: args.updater,
    scope: args.scope,
  });
  if (peerDialogs.length === 0) {
    return undefined;
  }

  let dispatchedDialogCount = 0;
  for (const peerDialog of peerDialogs) {
    await queueSharedReminderUpdateImpactPrompt({
      targetDialog: peerDialog,
      reminderId: args.reminderId,
      scope: args.scope,
      language: args.language,
    });
    dispatchedDialogCount += 1;
  }

  return {
    scope: args.scope,
    peerDialogCount: peerDialogs.length,
    dispatchedDialogCount,
  };
}
