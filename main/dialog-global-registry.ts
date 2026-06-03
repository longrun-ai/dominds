import {
  createPubChan,
  createSubChan,
  EndOfStream,
  type PubChan,
  type SubChan,
} from '@longrun-ai/kernel/evt';
import { scheduleGlobalDialogMutexCleanupForRoot, type Dialog, type MainDialog } from './dialog';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';

const log = createLogger('dialog-global-registry');

type RegistryEntry = {
  mainDialog: MainDialog;
  driveQueued: boolean;
  activeRunClearedDrivePending: boolean;
};

export type DriveTriggerEvent = Readonly<{
  type: 'drive_trigger_evt';
  action: 'queue_root_drive' | 'clear_root_drive_queue' | 'active_run_cleared';
  rootId: string;
  entryFound: boolean;
  previousDriveQueued: boolean | null;
  nextDriveQueued: boolean;
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
  /**
   * Runtime-owned roots keyed by rootId.
   *
   * Do not add an API that enumerates this map for backend driving. A dialog becomes driveable only
   * through an explicit business/runtime scheduling event (`queueRootDrive`, result arrival,
   * active-run clear, etc.).
   * Reintroducing "scan every loaded root and see what happens" makes hidden polling loops easy to
   * create and obscures the business event that should own the next action.
   */
  private readonly entries: Map<string, RegistryEntry> = new Map();
  private readonly queuedRootIds: string[] = [];
  private readonly queuedRootIdSet: Set<string> = new Set();
  private queuedRootIdReadIndex = 0;
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
      driveQueued: false,
      activeRunClearedDrivePending: false,
    });
    void (async () => {
      try {
        const hasPendingNextStepTriggers = await DialogPersistence.hasPendingNextStepTriggers(
          mainDialog.id,
        );
        const wakeQueueEntries = await DialogPersistence.loadWakeQueueEntries(mainDialog.id);
        if (hasPendingNextStepTriggers || wakeQueueEntries.length > 0) {
          this.queueRootDrive(mainDialog.id.rootId, {
            source: 'dialog_registry_hydration',
            reason: hasPendingNextStepTriggers
              ? 'persisted_next_step_triggers'
              : 'persisted_wake_queue',
          });
        }
      } catch (error: unknown) {
        log.warn('Failed to hydrate persisted root drive queue for registered main dialog', error, {
          rootId: mainDialog.id.rootId,
          selfId: mainDialog.id.selfId,
        });
      }
    })();
  }

  unregister(rootId: string): void {
    this.entries.delete(rootId);
    this.queuedRootIdSet.delete(rootId);
    this.lastDriveTriggerByRootId.delete(rootId);
    scheduleGlobalDialogMutexCleanupForRoot(rootId);
  }

  private enqueueRoot(rootId: string): void {
    if (this.queuedRootIdSet.has(rootId)) {
      return;
    }
    this.queuedRootIdSet.add(rootId);
    this.queuedRootIds.push(rootId);
  }

  private compactQueuedRootsIfNeeded(): void {
    if (this.queuedRootIdReadIndex === 0) {
      return;
    }
    if (
      this.queuedRootIdReadIndex < 256 &&
      this.queuedRootIdReadIndex * 2 < this.queuedRootIds.length
    ) {
      return;
    }
    this.queuedRootIds.splice(0, this.queuedRootIdReadIndex);
    this.queuedRootIdReadIndex = 0;
  }

  private compactSparseQueuedRootsIfNeeded(): void {
    if (this.queuedRootIds.length < 512) {
      return;
    }
    if (this.queuedRootIdSet.size * 2 >= this.queuedRootIds.length - this.queuedRootIdReadIndex) {
      return;
    }
    const compacted: string[] = [];
    for (let index = this.queuedRootIdReadIndex; index < this.queuedRootIds.length; index += 1) {
      const rootId = this.queuedRootIds[index];
      if (rootId !== undefined && this.queuedRootIdSet.has(rootId)) {
        compacted.push(rootId);
      }
    }
    this.queuedRootIds.splice(0, this.queuedRootIds.length, ...compacted);
    this.queuedRootIdReadIndex = 0;
  }

  private publishDriveTrigger(args: {
    action: DriveTriggerEvent['action'];
    rootId: string;
    entryFound: boolean;
    previousDriveQueued: boolean | null;
    nextDriveQueued: boolean;
    meta: DriveTriggerMeta;
  }): void {
    const trigger: DriveTriggerEvent = {
      type: 'drive_trigger_evt',
      action: args.action,
      rootId: args.rootId,
      entryFound: args.entryFound,
      previousDriveQueued: args.previousDriveQueued,
      nextDriveQueued: args.nextDriveQueued,
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

  queueRootDrive(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    const previousDriveQueued = entry ? entry.driveQueued : null;
    if (entry) {
      entry.driveQueued = true;
      // A fresh root drive queueing supersedes any earlier "drive once active run clears" debt.
      entry.activeRunClearedDrivePending = false;
      this.enqueueRoot(rootId);
    }
    this.publishDriveTrigger({
      action: 'queue_root_drive',
      rootId,
      entryFound: entry !== undefined,
      previousDriveQueued,
      nextDriveQueued: true,
      meta: triggerMeta,
    });
  }

  clearRootDriveQueue(rootId: string, meta?: DriveTriggerMeta): void {
    const triggerMeta: DriveTriggerMeta = meta ?? {
      source: 'unknown',
      reason: 'unspecified',
    };
    const entry = this.entries.get(rootId);
    const previousDriveQueued = entry ? entry.driveQueued : null;
    if (entry) {
      entry.driveQueued = false;
      entry.activeRunClearedDrivePending = false;
      this.queuedRootIdSet.delete(rootId);
      this.compactSparseQueuedRootsIfNeeded();
    }
    this.publishDriveTrigger({
      action: 'clear_root_drive_queue',
      rootId,
      entryFound: entry !== undefined,
      previousDriveQueued,
      nextDriveQueued: false,
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
    if (!entry.activeRunClearedDrivePending) {
      entry.activeRunClearedDrivePending = false;
      return;
    }
    const currentDriveQueued = entry.driveQueued;
    entry.activeRunClearedDrivePending = false;
    entry.driveQueued = true;
    this.enqueueRoot(rootId);
    this.publishDriveTrigger({
      action: 'active_run_cleared',
      rootId,
      entryFound: true,
      previousDriveQueued: currentDriveQueued,
      nextDriveQueued: entry.driveQueued,
      meta: triggerMeta,
    });
  }

  noteActiveRunBlockedQueuedDrive(rootId: string): void {
    const entry = this.entries.get(rootId);
    if (!entry) {
      return;
    }
    entry.activeRunClearedDrivePending = true;
  }

  hasPendingActiveRunClearedDrive(rootId: string): boolean {
    return this.entries.get(rootId)?.activeRunClearedDrivePending === true;
  }

  isRootDriveQueued(rootId: string): boolean {
    return this.entries.get(rootId)?.driveQueued === true;
  }

  /**
   * One-shot runtime snapshot for shared-reminder impact routing.
   *
   * This intentionally does not enumerate persisted "all running dialogs". It walks only the roots
   * this runtime has already registered, and includes only dialogs with direct in-memory evidence
   * of current work: locked running main dialogs and the loaded active-callee frontier under each
   * root. Dialogs that merely remain in memory/history but have no current-work signal are not
   * considered parallel work.
   */
  getLoadedInFlightDialogsForSharedReminderImpact(): Dialog[] {
    const dialogs: Dialog[] = [];
    for (const entry of this.entries.values()) {
      const rootDialog = entry.mainDialog;
      const visitedDialogIds = new Set<string>();
      const stack: Dialog[] = [];
      if (rootDialog.status === 'running' && rootDialog.isLocked()) {
        dialogs.push(rootDialog);
        visitedDialogIds.add(rootDialog.id.valueOf());
      }
      for (const calleeId of rootDialog.activeCalleeDialogIds) {
        const loadedCallee = rootDialog.lookupDialog(calleeId.selfId);
        if (loadedCallee && loadedCallee.status === 'running') {
          stack.push(loadedCallee);
        }
      }

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || visitedDialogIds.has(current.id.valueOf())) {
          continue;
        }
        visitedDialogIds.add(current.id.valueOf());
        if (current.status !== 'running') {
          continue;
        }
        dialogs.push(current);
        for (const calleeId of current.activeCalleeDialogIds) {
          const loadedCallee = rootDialog.lookupDialog(calleeId.selfId);
          if (loadedCallee && loadedCallee.status === 'running') {
            stack.push(loadedCallee);
          }
        }
      }
    }
    return dialogs;
  }

  getLastDriveTrigger(rootId: string): DriveTriggerEvent | undefined {
    return this.lastDriveTriggerByRootId.get(rootId);
  }

  consumeQueuedMainDialogs(): MainDialog[] {
    const queued: MainDialog[] = [];
    while (this.queuedRootIdReadIndex < this.queuedRootIds.length) {
      const rootId = this.queuedRootIds[this.queuedRootIdReadIndex];
      this.queuedRootIdReadIndex += 1;
      if (rootId === undefined || !this.queuedRootIdSet.has(rootId)) {
        continue;
      }
      this.queuedRootIdSet.delete(rootId);
      const entry = this.entries.get(rootId);
      if (!entry) {
        continue;
      }
      entry.driveQueued = false;
      queued.push(entry.mainDialog);
    }
    this.compactQueuedRootsIfNeeded();
    return queued;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const globalDialogRegistry = GlobalDialogRegistry.getInstance();
