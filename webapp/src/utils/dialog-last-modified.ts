import type { ApiRootDialogResponse } from '../shared/types';

export function bumpDialogsLastModified(
  dialogs: ApiRootDialogResponse[],
  dialogId: { rootId: string; selfId: string },
  isoTs: string,
): { dialogs: ApiRootDialogResponse[]; changed: boolean } {
  let changed = false;
  const next = dialogs.map((d) => {
    if (d.rootId !== dialogId.rootId) return d;

    // Always bump the root row of the tree so it reflects recent activity
    // even when the activity happened inside a subdialog.
    const isRootRow = d.selfId === undefined;

    // Bump only the targeted dialog node (root or subdialog) and the root row.
    // IMPORTANT: Do not bump sibling subdialogs: they share the same rootId.
    const dSelfId = d.selfId ?? d.rootId;
    const isTargetNode = dSelfId === dialogId.selfId;
    if (!isRootRow && !isTargetNode) return d;

    if (d.lastModified === isoTs) return d;
    changed = true;
    return { ...d, lastModified: isoTs };
  });

  return { dialogs: next, changed };
}
