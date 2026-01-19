import type { RootDialog } from './dialog';
import { DialogPersistence } from './persistence';

type RegistryEntry = {
  rootDialog: RootDialog;
  needsDrive: boolean;
};

class GlobalDialogRegistry {
  private static instance: GlobalDialogRegistry | undefined;
  private readonly entries: Map<string, RegistryEntry> = new Map();

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
          this.markNeedsDrive(rootDialog.id.rootId);
        }
      } catch {
        // Best-effort hydration; backend driver will still function for runtime-triggered drives.
      }
    })();
  }

  unregister(rootId: string): void {
    this.entries.delete(rootId);
  }

  markNeedsDrive(rootId: string): void {
    const entry = this.entries.get(rootId);
    if (entry) {
      entry.needsDrive = true;
    }
  }

  markNotNeedingDrive(rootId: string): void {
    const entry = this.entries.get(rootId);
    if (entry) {
      entry.needsDrive = false;
    }
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
