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

  // Some dialog events are global UI state updates. They must reach ALL connected clients,
  // not only those subscribed to a specific dialog stream.
  private globalDialogEventBroadcaster: ((evt: TypedDialogEvent) => void) | null = null;

  setGlobalDialogEventBroadcaster(fn: ((evt: TypedDialogEvent) => void) | null): void {
    this.globalDialogEventBroadcaster = fn;
  }

  private broadcastGlobalEvent(evt: TypedDialogEvent): void {
    const fn = this.globalDialogEventBroadcaster;
    if (!fn) return;
    fn(evt);
  }

  private emitDialogTouched(source: TypedDialogEvent): void {
    // `full_reminders_update` is a reminder snapshot/sync event and should not mutate
    // dialog ordering timestamps. Emitting touched here causes list reordering on mere display.
    if (source.type === 'dlg_touched_evt' || source.type === 'full_reminders_update') return;
    const touchedEvt: TypedDialogEvent = {
      dialog: source.dialog,
      timestamp: source.timestamp,
      type: 'dlg_touched_evt',
      sourceType: source.type,
    };
    this.broadcastGlobalEvent(touchedEvt);
  }

  private dispatchGloballyIfNeeded(evt: TypedDialogEvent): boolean {
    // Global-only delivery prevents duplicate deliveries from two independent paths
    // (global broadcaster + dialog-scoped stream).
    switch (evt.type) {
      case 'new_q4h_asked':
      case 'q4h_answered':
      case 'subdialog_created_evt':
      case 'dlg_touched_evt':
        break;
      default:
        return false;
    }

    const fn = this.globalDialogEventBroadcaster;
    if (!fn) {
      throw new Error(
        `Global dialog event broadcaster missing: cannot publish ${evt.type} for dialog=${evt.dialog.selfId}`,
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
    this.emitDialogTouched(typedEvent);
    if (this.dispatchGloballyIfNeeded(typedEvent)) {
      return;
    }
    const chan = this.getPubChan(dlg.id);
    chan.write(typedEvent);
  }

  postEventById(dialogId: DialogID, event: DialogEvent): void {
    const typedEvent = this.createTypedEvent(dialogId, event);
    this.emitDialogTouched(typedEvent);
    if (this.dispatchGloballyIfNeeded(typedEvent)) {
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

export function setGlobalDialogEventBroadcaster(
  fn: ((evt: TypedDialogEvent) => void) | null,
): void {
  dialogEventRegistry.setGlobalDialogEventBroadcaster(fn);
}

// Backward-compatible alias used by existing tests/callers.
export function setQ4HBroadcaster(fn: ((evt: TypedDialogEvent) => void) | null): void {
  setGlobalDialogEventBroadcaster(fn);
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
