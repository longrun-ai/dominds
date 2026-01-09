import type { RootDialog } from './dialog';

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

  register(rootDialog: RootDialog): void {
    this.entries.set(rootDialog.id.rootId, { rootDialog, needsDrive: false });
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
