import type { ApiMainDialogResponse } from '@longrun-ai/kernel/types';

export function bumpDialogsLastModified(
  dialogs: ApiMainDialogResponse[],
  dialogId: { rootId: string; selfId: string },
  isoTs: string,
): { dialogs: ApiMainDialogResponse[]; changed: boolean } {
  let changed = false;
  const next = dialogs.map((d) => {
    if (d.rootId !== dialogId.rootId) return d;

    // Always bump the main row of the tree so it reflects recent activity
    // even when the activity happened inside a sideDialog.
    const isRootRow = d.selfId === undefined;

    // Bump only the targeted dialog node (main dialog or sideDialog) and the main row.
    // IMPORTANT: Do not bump sibling sideDialogs: they share the same rootId.
    const dSelfId = d.selfId ?? d.rootId;
    const isTargetNode = dSelfId === dialogId.selfId;
    if (!isRootRow && !isTargetNode) return d;

    if (d.lastModified === isoTs) return d;
    changed = true;
    return { ...d, lastModified: isoTs };
  });

  return { dialogs: next, changed };
}
