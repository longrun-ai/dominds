import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { Dialog } from '../../main/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';

/** Subscribe before the action, then drain through an explicit end-of-stream after it settles. */
export function recordDialogEvents(dialog: Dialog) {
  const channel = dialogEventRegistry.createSubChan(dialog.id);
  return {
    async finish(): Promise<TypedDialogEvent[]> {
      dialogEventRegistry.endStream(dialog.id);
      const events: TypedDialogEvent[] = [];
      try {
        for await (const event of channel.stream()) events.push(event);
      } finally {
        channel.cancel();
      }
      return events;
    },
  };
}
