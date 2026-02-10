import type { RootDialog } from './dialog';
import { DialogPersistence } from './persistence';
import {
  createPubChan,
  createSubChan,
  EndOfStream,
  type PubChan,
  type SubChan,
} from './shared/evt';

type RegistryEntry = {
  rootDialog: RootDialog;
  needsDrive: boolean;
};

export type DriveTriggerEvent = Readonly<{
  type: 'drive_trigger_evt';
  action: 'mark_needs_drive' | 'mark_not_needing_drive';
  rootId: string;
  entryFound: boolean;
  previousNeedsDrive: boolean | null;
  nextNeedsDrive: boolean;
  source: string;
  reason: string;
  emittedAtMs: number;
}>;

export type DriveTriggerMeta = Readonly<{
  source: string;
  reason: string;
}>;

class GlobalDialogRegistry {
  private static instance: GlobalDialogRegistry | undefined;
  private readonly entries: Map<string, RegistryEntry> = new Map();
  private readonly driveTriggerPubChan: PubChan<DriveTriggerEvent> =
    createPubChan<DriveTriggerEvent>();
  private driveTriggerSubChan: SubChan<DriveTriggerEvent> = createSubChan(this.driveTriggerPubChan);

  static getInstance(): GlobalDialogRegistry {
    if (!GlobalDialogRegistry.instance) {
      GlobalDialogRegistry.instance = new GlobalDialogRegistry();
    }
    return GlobalDialogRegistry.instance;
  }

  get(rootId: string): RootDialog | undefined {
    return this.entries.get(rootId)?.rootDialog;
  }

  register(rootDialog: RootDialog): void {
    // This registry is keyed by the *tree root id*.
    // Only the canonical root dialog (selfId === rootId) should be stored here.
    if (rootDialog.id.selfId !== rootDialog.id.rootId) {
      return;
    }
    const existing = this.entries.get(rootDialog.id.rootId);
    if (existing) {
      return;
    }
    this.entries.set(rootDialog.id.rootId, { rootDialog, needsDrive: false });
    void (async () => {
      try {
        const needsDrive = await DialogPersistence.getNeedsDrive(rootDialog.id);
        if (needsDrive) {
          this.markNeedsDrive(rootDialog.id.rootId, {
            source: 'dialog_registry_hydration',
            reason: 'persisted_needs_drive_true',
          });
        }
      } catch {
        // Best-effort hydration; backend driver will still function for runtime-triggered drives.
      }
    })();
  }

  unregister(rootId: string): void {
    this.entries.delete(rootId);
  }

  private publishDriveTrigger(args: {
    action: DriveTriggerEvent['action'];
    rootId: string;
    entryFound: boolean;
    previousNeedsDrive: boolean | null;
    nextNeedsDrive: boolean;
    meta: DriveTriggerMeta;
  }): void {
    this.driveTriggerPubChan.write({
      type: 'drive_trigger_evt',
      action: args.action,
      rootId: args.rootId,
      entryFound: args.entryFound,
      previousNeedsDrive: args.previousNeedsDrive,
      nextNeedsDrive: args.nextNeedsDrive,
      source: args.meta.source,
      reason: args.meta.reason,
      emittedAtMs: Date.now(),
    });
  }

  async waitForDriveTrigger(): Promise<DriveTriggerEvent> {
    for (;;) {
      const trigger = await this.driveTriggerSubChan.read();
      if (trigger !== EndOfStream) {
        return trigger;
      }
      // Recreate subscription if EOS is ever observed (should not happen in normal runtime).
      this.driveTriggerSubChan = createSubChan(this.driveTriggerPubChan);
    }
  }

  markNeedsDrive(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    const previousNeedsDrive = entry ? entry.needsDrive : null;
    if (entry) {
      entry.needsDrive = true;
    }
    this.publishDriveTrigger({
      action: 'mark_needs_drive',
      rootId,
      entryFound: entry !== undefined,
      previousNeedsDrive,
      nextNeedsDrive: true,
      meta: triggerMeta,
    });
  }

  markNotNeedingDrive(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    const previousNeedsDrive = entry ? entry.needsDrive : null;
    if (entry) {
      entry.needsDrive = false;
    }
    this.publishDriveTrigger({
      action: 'mark_not_needing_drive',
      rootId,
      entryFound: entry !== undefined,
      previousNeedsDrive,
      nextNeedsDrive: false,
      meta: triggerMeta,
    });
  }

  getDialogsNeedingDrive(): RootDialog[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.needsDrive)
      .map((entry) => entry.rootDialog);
  }

  getAll(): RootDialog[] {
    return Array.from(this.entries.values()).map((entry) => entry.rootDialog);
  }

  get size(): number {
    return this.entries.size;
  }
}

export const globalDialogRegistry = GlobalDialogRegistry.getInstance();
