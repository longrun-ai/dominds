/**
 * Module: evt-registry
 *
 * PubChan registry for managing dialog event streams.
 * Maps dialog IDs to PubChans for real-time event streaming during dialog driving.
 */

import { Dialog, DialogID } from './dialog';
import { createLogger } from './log';
import { createPubChan, createSubChan, EndOfStream, PubChan, SubChan } from './shared/evt';
import type { DialogEvent, DialogEventBase, TypedDialogEvent } from './shared/types/dialog';
import { formatUnifiedTimestamp } from './shared/utils/time';

export interface DialogEventRegistry {
  getPubChan(dialogId: DialogID): PubChan<TypedDialogEvent>;
  createSubChan(dialogId: DialogID): SubChan<TypedDialogEvent>;
  removePubChan(dialogId: DialogID): void;
  postEvent(dlg: Dialog, event: DialogEvent & Partial<DialogEventBase>): void;
  postEventById(dialogId: DialogID, event: DialogEvent): void;
  createTypedEvent(dialogId: DialogID, event: DialogEvent): TypedDialogEvent;
}

class DialogEventRegistryImpl implements DialogEventRegistry {
  private pubChans: Map<string, PubChan<TypedDialogEvent>> = new Map();
  private readonly log = createLogger('evt-registry');

  // Q4H (Questions for Human) is globally visible in the WebUI.
  // These events must reach ALL connected clients, not only those subscribed to a specific dialog stream.
  private q4hBroadcaster: ((evt: TypedDialogEvent) => void) | null = null;

  setQ4HBroadcaster(fn: ((evt: TypedDialogEvent) => void) | null): void {
    this.q4hBroadcaster = fn;
  }

  private dispatchQ4HGloballyIfNeeded(evt: TypedDialogEvent): boolean {
    // Q4H MUST be global-only: emit to all clients via broadcaster and do not
    // also write into dialog-scoped stream, otherwise subscribed clients will
    // receive duplicate deliveries via two independent paths.
    if (evt.type !== 'new_q4h_asked' && evt.type !== 'q4h_answered') return false;
    const fn = this.q4hBroadcaster;
    if (!fn) {
      throw new Error(
        `Q4H broadcaster missing: cannot publish ${evt.type} for dialog=${evt.dialog.selfId}`,
      );
    }
    fn(evt);
    return true;
  }

  /**
   * Get or create a PubChan for a specific dialog ID
   */
  getPubChan(dialogId: DialogID): PubChan<TypedDialogEvent> {
    let chan = this.pubChans.get(dialogId.key());
    if (chan === undefined) {
      chan = createPubChan<TypedDialogEvent>();
      this.pubChans.set(dialogId.key(), chan);
    }
    return chan;
  }

  /**
   * Create a SubChan for a specific dialog ID
   */
  createSubChan(dialogId: DialogID): SubChan<TypedDialogEvent> {
    const pubChan = this.getPubChan(dialogId);
    return createSubChan(pubChan);
  }

  /**
   * Remove PubChan for a dialog
   */
  removePubChan(dialogId: DialogID): void {
    this.pubChans.delete(dialogId.key());
  }

  /**
   * Create a TypedDialogEvent with common metadata (dialog info and timestamp)
   */
  createTypedEvent(dialogId: DialogID, event: DialogEvent): TypedDialogEvent {
    return {
      dialog: {
        selfId: dialogId.selfId,
        rootId: dialogId.rootId,
      },
      timestamp: formatUnifiedTimestamp(new Date()),
      ...event,
    } as TypedDialogEvent;
  }

  /**
   * Post an event to the appropriate PubChan with proper hierarchy information
   */
  postEvent(dlg: Dialog, event: DialogEvent): void {
    const typedEvent = this.createTypedEvent(dlg.id, event);
    if (this.dispatchQ4HGloballyIfNeeded(typedEvent)) {
      return;
    }
    const chan = this.getPubChan(dlg.id);
    chan.write(typedEvent);
  }

  postEventById(dialogId: DialogID, event: DialogEvent): void {
    const typedEvent = this.createTypedEvent(dialogId, event);
    if (this.dispatchQ4HGloballyIfNeeded(typedEvent)) {
      return;
    }
    const chan = this.getPubChan(dialogId);
    chan.write(typedEvent);
  }

  /**
   * End-of-stream for a specific dialog
   */
  endStream(dialogId: DialogID): void {
    const chan = this.pubChans.get(dialogId.key());
    if (chan) {
      chan.write(EndOfStream);
    }
  }

  /**
   * Clean up all PubChans (for server shutdown)
   */
  cleanup(): void {
    for (const chan of this.pubChans.values()) {
      chan.write(EndOfStream);
    }
    this.pubChans.clear();
  }
}

// Export singleton instance
export const dialogEventRegistry = new DialogEventRegistryImpl();

export function setQ4HBroadcaster(fn: ((evt: TypedDialogEvent) => void) | null): void {
  dialogEventRegistry.setQ4HBroadcaster(fn);
}

// Export helper function to import in other modules
export function postDialogEvent(dlg: Dialog, event: DialogEvent): void {
  dialogEventRegistry.postEvent(dlg, event);
}

/**
 * Post an event to a specific dialog's PubChan by ID.
 * Useful for posting subdialog events when only the subdialog ID is available.
 */
export function postDialogEventById(dialogId: DialogID, event: DialogEvent): void {
  dialogEventRegistry.postEventById(dialogId, event);
}

// Helper functions to create events with simpler API
export function createEvent<T extends DialogEvent['type']>(
  type: T,
): Extract<DialogEvent, { type: T }> {
  return { type } as Extract<DialogEvent, { type: T }>;
}
