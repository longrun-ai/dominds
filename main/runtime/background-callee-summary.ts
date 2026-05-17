import { Dialog } from '../dialog';
import { postDialogEvent } from '../evt-registry';
import { DialogPersistence } from '../persistence';

export async function broadcastBackgroundCalleeSummary(dlg: Dialog): Promise<void> {
  const activeCallees = await DialogPersistence.loadActiveCallees(dlg.id, dlg.status);
  const pending = activeCallees.batches.flatMap((batch) =>
    batch.callees.filter((callee) => callee.status === 'pending'),
  );
  postDialogEvent(dlg, {
    type: 'dlg_background_callee_summary_evt',
    backgroundCalleeDialogCount: pending.length,
    backgroundFreshBootsReasoningCalleeCount: pending.filter(
      (callee) => callee.callName === 'freshBootsReasoning',
    ).length,
  });
}
