import {
  createPubChan,
  createSubChan,
  EndOfStream,
  type PubChan,
  type SubChan,
} from '@longrun-ai/kernel/evt';
import { scheduleGlobalDialogMutexCleanupForRoot, type MainDialog } from './dialog';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';

const log = createLogger('dialog-global-registry');

type RegistryEntry = {
  mainDialog: MainDialog;
  wakeQueued: boolean;
  activeRunClearedWakePending: boolean;
};

export type DriveTriggerEvent = Readonly<{
  type: 'drive_trigger_evt';
  action: 'wake_drive' | 'clear_drive_wake' | 'active_run_cleared';
  rootId: string;
  entryFound: boolean;
  previousWakeQueued: boolean | null;
  nextWakeQueued: boolean;
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
    // Only the canonical main dialog (selfId === rootId) should be stored here.
    if (mainDialog.id.selfId !== mainDialog.id.rootId) {
      return;
    }
    const existing = this.entries.get(mainDialog.id.rootId);
    if (existing) {
      return;
    }
    this.entries.set(mainDialog.id.rootId, {
      mainDialog,
      wakeQueued: false,
      activeRunClearedWakePending: false,
    });
    void (async () => {
      try {
        const hasPendingNextStepTriggers = await DialogPersistence.hasPendingNextStepTriggers(
          mainDialog.id,
        );
        const watchedDialogIds = await DialogPersistence.loadDriveWatchedDialogIds(mainDialog.id);
        if (hasPendingNextStepTriggers || watchedDialogIds.length > 0) {
          this.wakeDrive(mainDialog.id.rootId, {
            source: 'dialog_registry_hydration',
            reason: hasPendingNextStepTriggers
              ? 'persisted_next_step_triggers'
              : 'persisted_drive_watch',
          });
        }
      } catch (error: unknown) {
        log.warn('Failed to hydrate persisted drive wake for registered main dialog', error, {
          rootId: mainDialog.id.rootId,
          selfId: mainDialog.id.selfId,
        });
      }
    })();
  }

  unregister(rootId: string): void {
    this.entries.delete(rootId);
    this.lastDriveTriggerByRootId.delete(rootId);
    scheduleGlobalDialogMutexCleanupForRoot(rootId);
  }

  private publishDriveTrigger(args: {
    action: DriveTriggerEvent['action'];
    rootId: string;
    entryFound: boolean;
    previousWakeQueued: boolean | null;
    nextWakeQueued: boolean;
    meta: DriveTriggerMeta;
  }): void {
    const trigger: DriveTriggerEvent = {
      type: 'drive_trigger_evt',
      action: args.action,
      rootId: args.rootId,
      entryFound: args.entryFound,
      previousWakeQueued: args.previousWakeQueued,
      nextWakeQueued: args.nextWakeQueued,
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

  wakeDrive(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    const previousWakeQueued = entry ? entry.wakeQueued : null;
    if (entry) {
      entry.wakeQueued = true;
      // A fresh queueing trigger supersedes any earlier "wake me once active run clears" debt.
      entry.activeRunClearedWakePending = false;
    }
    this.publishDriveTrigger({
      action: 'wake_drive',
      rootId,
      entryFound: entry !== undefined,
      previousWakeQueued,
      nextWakeQueued: true,
      meta: triggerMeta,
    });
  }

  clearDriveWake(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    const previousWakeQueued = entry ? entry.wakeQueued : null;
    if (entry) {
      entry.wakeQueued = false;
      entry.activeRunClearedWakePending = false;
    }
    this.publishDriveTrigger({
      action: 'clear_drive_wake',
      rootId,
      entryFound: entry !== undefined,
      previousWakeQueued,
      nextWakeQueued: false,
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
    if (!entry.activeRunClearedWakePending || !entry.wakeQueued) {
      entry.activeRunClearedWakePending = false;
      return;
    }
    const currentWakeQueued = entry ? entry.wakeQueued : null;
    entry.activeRunClearedWakePending = false;
    this.publishDriveTrigger({
      action: 'active_run_cleared',
      rootId,
      entryFound: true,
      previousWakeQueued: currentWakeQueued,
      nextWakeQueued: entry.wakeQueued,
      meta: triggerMeta,
    });
  }

  noteActiveRunBlockedQueuedDrive(rootId: string): void {
    const entry = this.entries.get(rootId);
    if (!entry || !entry.wakeQueued) {
      return;
    }
    entry.activeRunClearedWakePending = true;
  }

  hasPendingActiveRunClearedWake(rootId: string): boolean {
    return this.entries.get(rootId)?.activeRunClearedWakePending === true;
  }

  isDriveWakeQueued(rootId: string): boolean {
    return this.entries.get(rootId)?.wakeQueued === true;
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
