import {
  createPubChan,
  createSubChan,
  EndOfStream,
  type PubChan,
  type SubChan,
} from '@longrun-ai/kernel/evt';
import type { MainDialog } from './dialog';
import { DialogPersistence } from './persistence';

type RegistryEntry = {
  mainDialog: MainDialog;
  needsDrive: boolean;
  activeRunClearedWakePending: boolean;
};

export type DriveTriggerEvent = Readonly<{
  type: 'drive_trigger_evt';
  action: 'mark_needs_drive' | 'mark_not_needing_drive' | 'active_run_cleared';
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
  private readonly lastDriveTriggerByRootId: Map<string, DriveTriggerEvent> = new Map();
  private readonly driveTriggerPubChan: PubChan<DriveTriggerEvent> =
    createPubChan<DriveTriggerEvent>();
  private driveTriggerSubChan: SubChan<DriveTriggerEvent> = createSubChan(this.driveTriggerPubChan);

  static getInstance(): GlobalDialogRegistry {
    if (!GlobalDialogRegistry.instance) {
      GlobalDialogRegistry.instance = new GlobalDialogRegistry();
    }
    return GlobalDialogRegistry.instance;
  }

  get(rootId: string): MainDialog | undefined {
    return this.entries.get(rootId)?.mainDialog;
  }

  register(mainDialog: MainDialog): void {
    // This registry is keyed by the *tree root id*.
    // Only the canonical root dialog (selfId === rootId) should be stored here.
    if (mainDialog.id.selfId !== mainDialog.id.rootId) {
      return;
    }
    const existing = this.entries.get(mainDialog.id.rootId);
    if (existing) {
      return;
    }
    this.entries.set(mainDialog.id.rootId, {
      mainDialog,
      needsDrive: false,
      activeRunClearedWakePending: false,
    });
    void (async () => {
      try {
        const needsDrive = await DialogPersistence.getNeedsDrive(mainDialog.id);
        if (needsDrive) {
          this.markNeedsDrive(mainDialog.id.rootId, {
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
    const trigger: DriveTriggerEvent = {
      type: 'drive_trigger_evt',
      action: args.action,
      rootId: args.rootId,
      entryFound: args.entryFound,
      previousNeedsDrive: args.previousNeedsDrive,
      nextNeedsDrive: args.nextNeedsDrive,
      source: args.meta.source,
      reason: args.meta.reason,
      emittedAtMs: Date.now(),
    };
    this.lastDriveTriggerByRootId.set(args.rootId, trigger);
    this.driveTriggerPubChan.write(trigger);
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
      // A fresh queueing trigger supersedes any earlier "wake me once active run clears" debt.
      entry.activeRunClearedWakePending = false;
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
      entry.activeRunClearedWakePending = false;
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

  notifyActiveRunCleared(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    if (!entry) {
      return;
    }
    if (!entry.activeRunClearedWakePending || !entry.needsDrive) {
      entry.activeRunClearedWakePending = false;
      return;
    }
    const currentNeedsDrive = entry ? entry.needsDrive : null;
    entry.activeRunClearedWakePending = false;
    this.publishDriveTrigger({
      action: 'active_run_cleared',
      rootId,
      entryFound: true,
      previousNeedsDrive: currentNeedsDrive,
      nextNeedsDrive: entry.needsDrive,
      meta: triggerMeta,
    });
  }

  noteActiveRunBlockedQueuedDrive(rootId: string): void {
    const entry = this.entries.get(rootId);
    if (!entry || !entry.needsDrive) {
      return;
    }
    entry.activeRunClearedWakePending = true;
  }

  hasPendingActiveRunClearedWake(rootId: string): boolean {
    return this.entries.get(rootId)?.activeRunClearedWakePending === true;
  }

  isMarkedNeedingDrive(rootId: string): boolean {
    return this.entries.get(rootId)?.needsDrive === true;
  }

  getDialogsNeedingDrive(): MainDialog[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.needsDrive)
      .map((entry) => entry.mainDialog);
  }

  getLastDriveTrigger(rootId: string): DriveTriggerEvent | undefined {
    return this.lastDriveTriggerByRootId.get(rootId);
  }

  getAll(): MainDialog[] {
    return Array.from(this.entries.values()).map((entry) => entry.mainDialog);
  }

  get size(): number {
    return this.entries.size;
  }
}

export const globalDialogRegistry = GlobalDialogRegistry.getInstance();
